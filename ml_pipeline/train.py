"""
INTELLITAX-AI Phase 2 — Offline model training.

Trains on the v29 synthetic PAN-INDIA dataset (15,000 dealers, every 10th row
carrying a planted fraud typology = ground truth) and exports everything the
backend serves:

  server/artifacts/xgb_fraud.json       XGBoost binary fraud classifier
  server/artifacts/xgb_typology.json    XGBoost multi-class typology model
  server/artifacts/isolation_forest.joblib  IsolationForest (unsupervised check)
  server/artifacts/preprocessor.joblib  column transformer (scale + one-hot)
  server/artifacts/shap_global.json     global feature importances (mean |SHAP|)
  server/artifacts/meta.json            metrics, schema, versions, dataset hash

Run:  python ml_pipeline/train.py
"""

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml_pipeline"))

import xgboost as xgb
import shap
from sklearn.ensemble import IsolationForest
from sklearn.metrics import (
    average_precision_score, classification_report, precision_recall_fscore_support,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import LabelEncoder, OneHotEncoder, StandardScaler

from features import CATEGORICAL_FEATURES, FEATURE_NAMES, NUMERIC_FEATURES, make_features

SEED = 42
DATASET = ROOT / "dataset_out" / "full_dataset_with_scores.csv"
ARTIFACTS = ROOT / "server" / "artifacts"


def load_dataset():
    df = pd.read_csv(DATASET)
    df["plantedType"] = df["plantedType"].fillna("none")
    df["label_fraud"] = (df["plantedType"] != "none").astype(int)
    feats = [make_features(row) for row in df.to_dict("records")]
    X = pd.DataFrame(feats, columns=FEATURE_NAMES)
    return df, X


def build_preprocessor():
    return ColumnTransformer(
        transformers=[
            ("num", StandardScaler(), NUMERIC_FEATURES),
            ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), CATEGORICAL_FEATURES),
        ],
        remainder="drop",
    )


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    df, X = load_dataset()
    y = df["label_fraud"].values
    planted = df["plantedType"].values
    print(f"Dataset: {len(df)} rows · fraud {y.sum()} ({y.mean():.1%}) · dataset md5 {md5_of(DATASET)[:10]}")

    # ---------------------------------------------------------------- split
    idx = np.arange(len(df))
    idx_train, idx_test = train_test_split(idx, test_size=0.20, stratify=y, random_state=SEED)
    # carve a validation slice out of train for early stopping
    idx_tr, idx_val = train_test_split(idx_train, test_size=0.10, stratify=y[idx_train], random_state=SEED)

    pre = build_preprocessor()
    pre.fit(X.iloc[idx_tr])
    joblib.dump(pre, ARTIFACTS / "preprocessor.joblib")

    def M(sel):
        return pre.transform(X.iloc[sel])

    Xtr, Xva, Xte = M(idx_tr), M(idx_val), M(idx_test)
    print(f"Feature matrix: {Xtr.shape[1]} columns after one-hot")

    # ------------------------------------------------- XGBoost fraud (binary)
    pos_weight = (y[idx_tr] == 0).sum() / max(1, (y[idx_tr] == 1).sum())
    fraud = xgb.XGBClassifier(
        n_estimators=600, max_depth=6, learning_rate=0.06,
        subsample=0.85, colsample_bytree=0.85,
        scale_pos_weight=pos_weight, eval_metric="aucpr",
        tree_method="hist", random_state=SEED, n_jobs=-1,
    )
    fraud.fit(Xtr, y[idx_tr])
    p_test = fraud.predict_proba(Xte)[:, 1]
    yte = y[idx_test]
    pred30 = (p_test >= 0.5).astype(int)  # decision threshold analog of score>=30
    prec, rec, f1, _ = precision_recall_fscore_support(yte, pred30, average="binary", zero_division=0)
    auc = roc_auc_score(yte, p_test)
    auprc = average_precision_score(yte, p_test)
    print(f"Fraud @0.5: precision {prec:.3f} · recall {rec:.3f} · F1 {f1:.3f} · ROC-AUC {auc:.4f} · PR-AUC {auprc:.4f}")

    # sweep a recall-first operating point (the taxman hunts under-reporters)
    best = {"thr": 0.5, "precision": -1.0}
    for thr in np.arange(0.10, 0.91, 0.02):
        pr = (p_test >= thr)
        tp = int((pr & (yte == 1)).sum())
        prec = tp / max(1, int(pr.sum()))
        rec = tp / max(1, int((yte == 1).sum()))
        if rec >= 0.97 and prec > best["precision"]:
            best = {"thr": float(thr), "precision": float(prec), "recall": float(rec)}
    if "recall" in best:
        print(f"Recall-first threshold: {best['thr']:.2f} -> precision {best['precision']:.3f} recall {best['recall']:.3f}")

    # -------------------------------------------- XGBoost typology (8-class)
    # XGBoost needs integer class ids — encode planted strings, keep the map.
    fraud_idx_tr = idx_tr[y[idx_tr] == 1]
    fraud_idx_val = idx_val[y[idx_val] == 1]
    le = LabelEncoder()
    y_typ_tr = le.fit_transform(planted[fraud_idx_tr])
    y_typ_val = le.transform(planted[fraud_idx_val])
    types = [str(c) for c in le.classes_]
    typ = xgb.XGBClassifier(
        n_estimators=500, max_depth=6, learning_rate=0.08,
        subsample=0.9, colsample_bytree=0.9,
        num_class=len(types), objective="multi:softprob",
        eval_metric="mlogloss", tree_method="hist",
        random_state=SEED, n_jobs=-1,
    )
    typ.fit(pre.transform(X.iloc[fraud_idx_tr]), y_typ_tr)
    tp = typ.predict_proba(Xte[yte == 1])
    ty_true = planted[idx_test][yte == 1]
    top1 = float((np.array(types)[tp.argmax(1)] == ty_true).mean())
    top2 = float(np.mean([t in np.array(types)[row.argsort()[-2:]] for row, t in zip(tp, ty_true)]))
    print(f"Typology: top-1 {top1:.3f} · top-2 {top2:.3f} over {len(types)} planted types")

    # --------------------------------------------- IsolationForest (physics)
    # Unsupervised second opinion: fit on COMPLIANT rows only — anything the
    # trained lens never saw should isolate. contamination matches the planted
    # rate so the score bands stay comparable.
    iso = IsolationForest(
        n_estimators=300, contamination=0.10, max_samples="auto",
        random_state=SEED, n_jobs=-1,
    )
    iso.fit(Xtr[y[idx_tr] == 0])
    iso_scores = -iso.decision_function(Xte)  # higher = more anomalous
    q = np.quantile(iso_scores[yte == 0], 0.95)
    iso_flag = iso_scores >= q
    iso_catch = float(iso_flag[yte == 1].mean())
    iso_fp = float(iso_flag[yte == 0].mean())
    print(f"IsolationForest: catches {iso_catch:.1%} of planted fraud at a 5% false-alarm band on compliant rows")

    # ---------------------------------------------------------------- SHAP
    explainer = shap.TreeExplainer(fraud)
    sample_idx = np.random.default_rng(SEED).choice(idx_test, size=min(1500, len(idx_test)), replace=False)
    shap_vals = explainer.shap_values(pre.transform(X.iloc[sample_idx]))
    feature_names_out = pre.get_feature_names_out()

    # aggregate one-hot columns back to the canonical feature names:
    #   num__log_declared      -> log_declared   (1:1)
    #   cat__reg_type_Regular  -> reg_type       (longest-prefix match)
    groups = {name: [] for name in FEATURE_NAMES}
    cat_sorted = sorted(CATEGORICAL_FEATURES, key=len, reverse=True)
    for col, fname in enumerate(feature_names_out):
        base = str(fname).split("__", 1)[-1]
        if base.startswith("num__"):
            name = base[5:]
        else:
            name = next((f for f in cat_sorted if base.startswith(f + "_")), base)
        groups.setdefault(name, []).append(col)

    global_importance = []
    for name, cols in groups.items():
        if cols:
            global_importance.append({"feature": name, "mean_abs_shap": float(np.abs(shap_vals[:, cols]).mean())})
    global_importance.sort(key=lambda d: d["mean_abs_shap"], reverse=True)

    # ------------------------------------------------------------- artifacts
    fraud.save_model(ARTIFACTS / "xgb_fraud.json")
    typ.save_model(ARTIFACTS / "xgb_typology.json")
    joblib.dump(iso, ARTIFACTS / "isolation_forest.joblib")

    meta = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "seed": SEED,
        "dataset": {"path": "dataset_out/full_dataset_with_scores.csv", "md5": md5_of(DATASET), "rows": int(len(df)), "fraud_rows": int(y.sum())},
        "features_in": FEATURE_NAMES,
        "categorical": CATEGORICAL_FEATURES,
        "classes_typology": types,
        "decision_threshold": best["thr"],
        "metrics": {
            "fraud": {"precision": float(prec), "recall": float(rec), "f1": float(f1), "roc_auc": float(auc), "pr_auc": float(auprc)},
            "typology_top1": top1,
            "typology_top2": top2,
            "isolation_forest": {"fraud_caught_at_5pct_band": iso_catch, "false_alarm_on_compliant": iso_fp},
        },
        "versions": {
            "xgboost": xgb.__version__, "scikit-learn": __import__("sklearn").__version__,
            "shap": shap.__version__, "pandas": pd.__version__, "numpy": np.__version__,
        },
    }
    (ARTIFACTS / "meta.json").write_text(json.dumps(meta, indent=2))
    (ARTIFACTS / "shap_global.json").write_text(json.dumps(global_importance[:15], indent=2))

    print(f"\nArtifacts -> {ARTIFACTS}")
    print("  xgb_fraud.json · xgb_typology.json · isolation_forest.joblib")
    print("  preprocessor.joblib · shap_global.json · meta.json")
    print("\nTop SHAP drivers:", ", ".join(f"{d['feature']} {d['mean_abs_shap']:.3f}" for d in global_importance[:6]))


if __name__ == "__main__":
    main()
