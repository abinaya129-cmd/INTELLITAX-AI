"""
INTELLITAX-AI Phase 2 — FastAPI backend.

Serves the v29 pan-India dealer network with the EXACT createApi() response
shapes the React dashboard already consumes, but every dealer is enriched
with live ML inference:

  · XGBoost fraud classifier  -> mlRisk (0-100), mlTier
  · XGBoost typology model    -> mlType + per-class confidence
  · IsolationForest           -> unsupervised anomaly opinion (isoScore/isoFlag)
  · SHAP (TreeExplainer)      -> per-dealer rupee-explained reasons
  · Rule engine (v29)         -> riskScore, reasons (unchanged, side-by-side)

Also persists officer audit actions (flag/assign/clear) to server/flags.json
so the audit trail survives reloads in a real deployment.

Run (from gst-dashboard/):  python -m uvicorn server.app:app --port 8000
"""

import json
import math
import sys
import threading
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml_pipeline"))

import joblib
import numpy as np
import pandas as pd
import shap
import xgboost as xgb
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from features import make_features
from shap_service import explain_dealer, group_shap_row

# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------
ARTIFACTS = ROOT / "server" / "artifacts"
ARTIFACTS.mkdir(parents=True, exist_ok=True)
_models_ready = (ARTIFACTS / "xgb_fraud.json").exists()

pre = None
fraud_model = None
typology_model = None
iso_model = None
shap_explainer = None
meta = {}
FEATURE_NAMES_OUT = None
META_FEATURES = []
META_THRESHOLD = 0.5

if _models_ready:
    pre = joblib.load(ARTIFACTS / "preprocessor.joblib")
    fraud_model = xgb.XGBClassifier()
    fraud_model.load_model(ARTIFACTS / "xgb_fraud.json")
    typology_model = xgb.XGBClassifier()
    typology_model.load_model(ARTIFACTS / "xgb_typology.json")
    iso_model = joblib.load(ARTIFACTS / "isolation_forest.joblib")
    shap_explainer = shap.TreeExplainer(fraud_model)
    meta = json.loads((ARTIFACTS / "meta.json").read_text())
    FEATURE_NAMES_OUT = pre.get_feature_names_out()
META_FEATURES = meta.get("features_in", [])
META_THRESHOLD = float(meta.get("decision_threshold", 0.5))
# LabelEncoder mapping persisted at train time (load_model restores class ids,
# not the original typology names)
TYPOLOGY_CLASSES = [str(c) for c in meta.get("classes_typology", [])]

# ---------------------------------------------------------------------------
# Data: the v29 dataset IS the dealer network (with rule-engine scores)
# ---------------------------------------------------------------------------
DATASET = ROOT / "dataset_out" / "full_dataset_with_scores.csv"
_raw = pd.read_csv(DATASET, low_memory=False)
_raw["plantedType"] = _raw["plantedType"].fillna("none")

NUMERIC_COLS = [
    "declared", "gstr1Sales", "gstr3bTurnover", "purchases", "bookStock",
    "stockBalance", "stockShort", "stockExcess", "taxPaid", "itcClaimed", "itcRatio",
    "sanctionedLoad", "monthlyUnits", "ewayCountMonthly", "ewayValueMonthly",
    "avgDistance", "headcount", "wageBill", "impliedElec", "impliedEmp",
    "fleetImplied", "purchaseFlowRatio", "purchaseNoSale", "turnoverDivergence",
    "riskScore",
]
for _c in NUMERIC_COLS:
    if _c in _raw.columns:
        _raw[_c] = pd.to_numeric(_raw[_c], errors="coerce")

ANOMALY_ORDER = [
    "electricity_mismatch", "employment_mismatch", "threshold_manipulation",
    "shell_itc_pattern", "gstr_purchase_no_sale", "gstr_turnover_divergence",
    "stock_reconciliation", "fleet_revenue_mismatch",
]

# ---------------------------------------------------------------------------
# ML enrichment
# ---------------------------------------------------------------------------
def enrich(dealer: dict) -> dict:
    """Attach ML verdicts + SHAP reasons to one dealer dict."""
    if not _models_ready:
        return {"mlRisk": None, "mlTier": "—", "mlType": None, "mlTypeConfidence": None,
                "mlTypeTop2": None, "isoScore": None, "isoFlag": None, "mlReasons": []}

    xf = make_features(dealer)
    # META_FEATURES already ends with [sector, state, reg_type] — exact fit order
    row = [[xf[name] for name in META_FEATURES]]
    X = pre.transform(pd.DataFrame(row, columns=META_FEATURES))

    p_fraud = float(fraud_model.predict_proba(X)[0, 1])
    # Calibrate to the UI's 0-100 display: p = threshold maps to 60 (High line)
    ml_risk = int(round(min(100.0, 60.0 * p_fraud / max(1e-9, META_THRESHOLD))))

    tp = typology_model.predict_proba(X)[0]
    classes = TYPOLOGY_CLASSES
    order = np.argsort(tp)[::-1]
    ml_type = classes[order[0]] if float(tp[order[0]]) >= 0.30 else None

    iso_raw = float(-iso_model.decision_function(X)[0])  # higher = more anomalous

    sv = shap_explainer.shap_values(X)[0]
    pairs = group_shap_row(FEATURE_NAMES_OUT, sv)
    ml_reasons = explain_dealer(pairs, dealer, top_k=6)

    return {
        "mlRisk": ml_risk,
        "mlTier": "High Risk" if ml_risk >= 60 else "Medium Risk" if ml_risk >= 30 else "Low Risk",
        "mlType": ml_type,
        "mlTypeConfidence": float(tp[order[0]]),
        "mlTypeTop2": [
            {"type": classes[order[0]], "confidence": float(tp[order[0]])},
            {"type": classes[order[1]], "confidence": float(tp[order[1]])},
        ],
        "isoScore": round(iso_raw, 4),
        "isoFlag": bool(iso_raw >= 0.0),
        "mlReasons": ml_reasons,
    }


def _risk_label(score: int) -> str:
    return "High Risk" if score >= 60 else "Medium Risk" if score >= 30 else "Low Risk"


# ---------------------------------------------------------------------------
# Officer audit-trail persistence
# ---------------------------------------------------------------------------
FLAGS_PATH = ROOT / "server" / "flags.json"
_flags_lock = threading.Lock()


def _load_flags() -> dict:
    try:
        return json.loads(FLAGS_PATH.read_text())
    except Exception:
        return {}


def _save_flags(all_flags: dict) -> None:
    FLAGS_PATH.write_text(json.dumps(all_flags, indent=2))


# ---------------------------------------------------------------------------
# Row -> dealer dict (superset of the engine fields the UI renders)
# ---------------------------------------------------------------------------
def row_to_dealer(row) -> dict:
    def num(v, default=None):
        try:
            f = float(v)
            return f if f == f else default
        except (TypeError, ValueError):
            return default

    d = {
        "gstin": str(row["gstin"]),
        "businessName": str(row["businessName"]),
        "state": str(row["state"]),
        "stateCode": str(row["stateCode"]) if "stateCode" in row and pd.notna(row["stateCode"]) else None,
        "district": str(row["district"]),
        "sector": str(row["sector"]),
        "segment": str(row["segment"]),
        "regType": str(row["regType"]),
        "declared": num(row["declared"]),
        "taxPaid": num(row["taxPaid"]),
        "itcClaimed": num(row["itcClaimed"]),
        "itcRatio": num(row["itcRatio"]),
        "gstr1Sales": num(row["gstr1Sales"]),
        "gstr3bTurnover": num(row["gstr3bTurnover"]),
        "purchases": num(row["purchases"]),
        "filingStatus": str(row["filingStatus"]),
        "monthlyUnits": num(row["monthlyUnits"]),
        "connectionType": str(row["connectionType"]) if "connectionType" in row and pd.notna(row["connectionType"]) else None,
        "sanctionedLoad": num(row["sanctionedLoad"]),
        "ewayCountMonthly": num(row["ewayCountMonthly"]),
        "ewayValueMonthly": num(row["ewayValueMonthly"]),
        "avgDistance": num(row["avgDistance"]),
        "bookStock": num(row["bookStock"]),
        "headcount": num(row["headcount"]),
        "wageBill": num(row["wageBill"]),
        "impliedElec": num(row["impliedElec"]),
        "impliedEmp": num(row["impliedEmp"]),
        "fleetImplied": num(row["fleetImplied"]),
        "plantedType": str(row["plantedType"]),
        "riskScore": int(num(row["riskScore"], 0)),
        "stockBalance": num(row["stockBalance"]),
        "stockShort": num(row["stockShort"]),
        "stockExcess": num(row["stockExcess"]),
        "purchaseFlowRatio": num(row["purchaseFlowRatio"]),
        "purchaseNoSale": num(row["purchaseNoSale"]),
        "turnoverDivergence": num(row["turnoverDivergence"]),
    }
    d["riskTier"] = _risk_label(d["riskScore"])
    detected = str(row["detectedAnomalyType"])
    d["detectedType"] = detected if detected != "none" else None

    reasons_raw = str(row["reasons"]) if pd.notna(row["reasons"]) else ""
    d["reasons"] = [r for r in reasons_raw.split(" | ") if r]

    # tax-at-risk identity identical to the engine's getSummaryStats
    if d["riskScore"] >= 30:
        if d["segment"] == "Logistics":
            implied = max(d["fleetImplied"] or 0, d["impliedEmp"] or 0)
        elif d["segment"] == "Trader":
            implied = max(d["gstr1Sales"] or 0, d["purchases"] or 0)
        else:
            implied = max(d["impliedElec"] or 0, d["impliedEmp"] or 0, d["gstr1Sales"] or 0)
        d["estTaxAtRisk"] = max(0.0, implied - (d["declared"] or 0)) * 0.18
    else:
        d["estTaxAtRisk"] = 0.0
    return d


# ---------------------------------------------------------------------------
# Boot: batch ML inference over the whole network (vectorized, seconds)
# ---------------------------------------------------------------------------
print("Building dealer network …")
_base_dealers = [row_to_dealer(r) for r in _raw.to_dict("records")]

_batch = {}
if _models_ready:
    _rows = []
    for _d in _base_dealers:
        _xf = make_features(_d)
        _rows.append([_xf[_n] for _n in META_FEATURES])
    _Xall = pre.transform(pd.DataFrame(_rows, columns=META_FEATURES))
    _batch["p_fraud"] = fraud_model.predict_proba(_Xall)[:, 1]
    _batch["typ"] = typology_model.predict_proba(_Xall)
    _batch["iso"] = -iso_model.decision_function(_Xall)
    _batch["shap"] = shap_explainer.shap_values(_Xall)
    print("Batch ML inference done (XGBoost ×2 · IsolationForest · SHAP)")


def _ml_fields(i: int, d: dict) -> dict:
    """Attach the precomputed batch verdicts for dealer index i."""
    if not _models_ready:
        return {"mlRisk": None, "mlTier": "—", "mlType": None, "mlTypeConfidence": None,
                "mlTypeTop2": None, "isoScore": None, "isoFlag": None, "mlReasons": []}
    p_fraud = float(_batch["p_fraud"][i])
    ml_risk = int(round(min(100.0, 60.0 * p_fraud / max(1e-9, META_THRESHOLD))))
    tp = _batch["typ"][i]
    classes = TYPOLOGY_CLASSES
    order = np.argsort(tp)[::-1]
    pairs = group_shap_row(FEATURE_NAMES_OUT, _batch["shap"][i])
    return {
        "mlRisk": ml_risk,
        "mlTier": "High Risk" if ml_risk >= 60 else "Medium Risk" if ml_risk >= 30 else "Low Risk",
        "mlType": classes[order[0]] if float(tp[order[0]]) >= 0.30 else None,
        "mlTypeConfidence": float(tp[order[0]]),
        "mlTypeTop2": [
            {"type": classes[order[0]], "confidence": float(tp[order[0]])},
            {"type": classes[order[1]], "confidence": float(tp[order[1]])},
        ],
        "isoScore": round(float(_batch["iso"][i]), 4),
        "isoFlag": bool(_batch["iso"][i] >= 0.0),
        "mlReasons": explain_dealer(pairs, d, top_k=6),
    }


DEALERS: list = []
for _i, _d in enumerate(_base_dealers):
    _d.update(_ml_fields(_i, _d))
    DEALERS.append(_d)
_BY_GSTIN = {d["gstin"]: d for d in DEALERS}
print(f"Ready: {len(DEALERS)} dealers · models_ready={_models_ready}")

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="INTELLITAX-AI Phase 2 API",
    version="2.0.0",
    description="XGBoost + IsolationForest + SHAP inference behind the createApi() contract.",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class AuditAction(BaseModel):
    gstin: str
    action: str  # flag_for_investigation | assign_officer | clear
    note: str = ""
    officer: str = "AO-1"


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "modelsReady": _models_ready,
        "dealers": len(DEALERS),
        "modelCard": {
            "trainedAt": meta.get("trained_at"),
            "metrics": meta.get("metrics"),
            "versions": meta.get("versions"),
            "decisionThreshold": META_THRESHOLD,
        },
        "datasetMd5": meta.get("dataset", {}).get("md5"),
    }


@app.get("/api/dealers")
def get_dealers(
    search: str = "",
    state: str = "All",
    district: str = "All",
    sector: str = "All",
    segment: str = "All",
    risk: str = "All",
    page: int = 1,
    pageSize: int = 15,
):
    list_ = DEALERS
    if search.strip():
        q = search.strip().lower()
        list_ = [d for d in list_ if q in d["businessName"].lower() or q in d["gstin"].lower()]
    if state != "All":
        list_ = [d for d in list_ if d["state"] == state]
    if district != "All":
        list_ = [d for d in list_ if d["district"] == district]
    if sector != "All":
        list_ = [d for d in list_ if d["sector"] == sector]
    if segment != "All":
        list_ = [d for d in list_ if d["segment"] == segment]
    if risk != "All":
        list_ = [d for d in list_ if _risk_label(d["riskScore"]) == risk]
    # ML leads the ranking (Phase 2 story), rule score breaks ties
    list_ = sorted(
        list_,
        key=lambda d: (d["mlRisk"] if d["mlRisk"] is not None else d["riskScore"], d["riskScore"]),
        reverse=True,
    )
    total = len(list_)
    start = (page - 1) * pageSize
    return {"results": list_[start:start + pageSize], "total": total, "page": page, "pageSize": pageSize}


@app.get("/api/dealer/{gstin}")
def get_dealer(gstin: str):
    d = _BY_GSTIN.get(gstin)
    if not d:
        raise HTTPException(404, f"Dealer {gstin} not found")
    return d


@app.get("/api/dealer/{gstin}/score")
def get_dealer_score(gstin: str):
    """Full ML dossier for one dealer: both engines side by side + SHAP reasons."""
    d = _BY_GSTIN.get(gstin)
    if not d:
        raise HTTPException(404, f"Dealer {gstin} not found")
    return {
        "gstin": d["gstin"],
        "businessName": d["businessName"],
        "ruleEngine": {
            "riskScore": d["riskScore"], "riskTier": d["riskTier"],
            "detectedType": d["detectedType"], "reasons": d["reasons"],
        },
        "ml": {
            "mlRisk": d["mlRisk"], "mlTier": d["mlTier"], "mlType": d["mlType"],
            "mlTypeConfidence": d["mlTypeConfidence"], "mlTypeTop2": d["mlTypeTop2"],
            "isoScore": d["isoScore"], "isoFlag": d["isoFlag"], "mlReasons": d["mlReasons"],
        },
        "modelCard": {
            "trainedAt": meta.get("trained_at"), "metrics": meta.get("metrics"),
            "versions": meta.get("versions"), "decisionThreshold": META_THRESHOLD,
        },
    }


@app.get("/api/district-summary")
def get_district_summary():
    map_ = {}
    for d in DEALERS:
        m = map_.setdefault(d["district"], {"count": 0, "sum": 0, "high": 0, "med": 0, "low": 0, "state": d["state"]})
        m["count"] += 1
        m["sum"] += d["riskScore"]
        label = _risk_label(d["riskScore"])
        if label == "High Risk":
            m["high"] += 1
        elif label == "Medium Risk":
            m["med"] += 1
        else:
            m["low"] += 1
    out = [
        {"district": k, "state": m["state"], "count": m["count"], "avg": round(m["sum"] / m["count"]),
         "high": m["high"], "med": m["med"], "low": m["low"]}
        for k, m in map_.items()
    ]
    return sorted(out, key=lambda x: -x["avg"])


@app.get("/api/sector-summary")
def get_sector_summary():
    map_ = {}
    for d in DEALERS:
        m = map_.setdefault(d["sector"], {"count": 0, "sum": 0, "high": 0})
        m["count"] += 1
        m["sum"] += d["riskScore"]
        if _risk_label(d["riskScore"]) == "High Risk":
            m["high"] += 1
    return sorted(
        [{"sector": k, "count": m["count"], "avg": round(m["sum"] / m["count"]), "high": m["high"]} for k, m in map_.items()],
        key=lambda x: -x["avg"],
    )


@app.get("/api/anomaly-breakdown")
def get_anomaly_breakdown():
    counts = {t: 0 for t in ANOMALY_ORDER}
    for d in DEALERS:
        if d["detectedType"]:
            counts[d["detectedType"]] += 1
    return counts


@app.get("/api/summary-stats")
def get_summary_stats():
    total = len(DEALERS)
    high = sum(1 for d in DEALERS if _risk_label(d["riskScore"]) == "High Risk")
    med = sum(1 for d in DEALERS if _risk_label(d["riskScore"]) == "Medium Risk")
    avg = round(sum(d["riskScore"] for d in DEALERS) / max(1, total))
    ml_high = sum(1 for d in DEALERS if d["mlTier"] == "High Risk")
    ml_med = sum(1 for d in DEALERS if d["mlTier"] == "Medium Risk")
    ml_scores = [d["mlRisk"] for d in DEALERS if d["mlRisk"] is not None]
    agree = sum(1 for d in DEALERS if d["mlRisk"] is None or d["mlTier"] == d["riskTier"])
    return {
        "total": total, "high": high, "med": med, "low": total - high - med,
        "avgRisk": avg,
        "estTaxAtRisk": round(sum(d["estTaxAtRisk"] for d in DEALERS)),
        "ml": {
            "high": ml_high,
            "med": ml_med,
            "low": sum(1 for d in DEALERS if d["mlTier"] == "Low Risk"),
            "avgRisk": round(sum(ml_scores) / max(1, len(ml_scores))) if ml_scores else None,
            "agreementWithRules": round(100 * agree / max(1, total)),
        },
    }


@app.get("/api/shap-global")
def get_shap_global():
    path = ARTIFACTS / "shap_global.json"
    if path.exists():
        return json.loads(path.read_text())
    return []


@app.post("/api/score")
def score_ad_hoc(dealer: dict):
    """Score an AD-HOC dealer record (what-if / single-dealer intake API).
    Returns the ML verdict + SHAP reasons for any raw dealer payload using
    the engine's field names (declared, purchases, gstr1Sales, ...)."""
    if not _models_ready:
        raise HTTPException(503, "Models not trained yet — run ml_pipeline/train.py")
    result = enrich(dealer)
    return result


@app.get("/api/flags")
def get_flags():
    with _flags_lock:
        return list(_load_flags().values())


@app.post("/api/flags")
def post_flag(action: AuditAction):
    if action.action not in ("flag_for_investigation", "assign_officer", "clear"):
        raise HTTPException(400, f"Unknown action {action.action}")
    if action.gstin not in _BY_GSTIN:
        raise HTTPException(404, f"Dealer {action.gstin} not found")
    status_map = {"flag_for_investigation": "flagged", "assign_officer": "assigned", "clear": "cleared"}
    with _flags_lock:
        all_flags = _load_flags()
        existing = all_flags.get(action.gstin) or {"gstin": action.gstin, "status": "none", "history": []}
        entry = {
            "action": action.action,
            "note": action.note or "(no note)",
            "at": datetime.now().strftime("%d %b %Y, %H:%M"),
            "officer": action.officer,
        }
        existing["status"] = status_map[action.action]
        existing["history"] = [entry] + existing["history"]
        all_flags[action.gstin] = existing
        _save_flags(all_flags)
    return existing
