# INTELLITAX-AI · Phase 2 — XGBoost + Isolation Forest + SHAP Backend

Phase 2 replaces the in-browser simulation with a real ML backend — **the React
UI keeps its exact layout and API contract**. Every dealer is now scored by
TWO engines side by side:

| Engine | Output | Where in the UI |
|---|---|---|
| Rule engine (v29, sector-conditioned) | `riskScore` 0–100, reasons | unchanged — badges, list, heatmap |
| **XGBoost fraud classifier** | `mlRisk` 0–100, `mlTier` | "PHASE 2 ML" strip on every profile |
| **XGBoost typology model** (8-class) | `mlType` + confidence | same strip ("typology: … 99%") |
| **Isolation Forest** (unsupervised) | `isoScore`, `isoFlag` | same strip ("anomalous / in-distribution") |
| **SHAP TreeExplainer** | per-dealer attributed reasons | "SHAP · XGBOOST ATTRIBUTIONS" panel |

## Model metrics (held-out 20% test split)

| Model | Metric | Value |
|---|---|---|
| XGBoost fraud | precision / recall / F1 | 1.000 / 1.000 / 1.000 |
| | ROC-AUC / PR-AUC | 0.9998 / 0.9966 |
| XGBoost typology | top-1 / top-2 (8 planted types) | **0.980 / 0.993** (rule engine: 0.753) |
| Isolation Forest | fraud isolated @ 5% false-alarm band | 45% (trained on compliant rows only) |
| SHAP global | top drivers | purchase_flow_ratio, stock_balance_ratio, gap_emp, itc_ratio |

Training: `python ml_pipeline/train.py` — reads
`dataset_out/full_dataset_with_scores.csv` (15,000 pan-India dealers, every 10th
row carrying a planted fraud typology = ground truth; the models never see the
rule scores). Artifacts land in `server/artifacts/`:
`xgb_fraud.json`, `xgb_typology.json`, `isolation_forest.joblib`,
`preprocessor.joblib`, `shap_global.json`, `meta.json` (model card + metrics).

## Feature engineering (`ml_pipeline/features.py`)

31 numeric + 3 categorical features mirroring the v29 evidence lens:
GSTR-1/2A/3B triangulation (purchase flow, purchase-no-sale, turnover
divergence), THE stock checkpoint (balance ratio, cover, short, excess),
segment-scoped physical gaps (electricity / employment / fleet), intensity
ratios (headcount, kWh, e-way bills per crore), composite-threshold posture,
effective tax rate, filing discipline, one-hots for sector/state/reg-type and
the v29 state economic factor. Segment-conditional gaps default to parity when
a feed is absent — trees split on "evidence exists vs not" exactly like the
rule engine.

## Run everything

```bash
# 1) backend (first time: python ml_pipeline/train.py)
python -m uvicorn server.app:app --port 8000

# 2) frontend (vite.config.js proxies /api -> localhost:8000)
npx vite --port 4199
```

Open http://localhost:4199. If the backend is down, every call transparently
falls back to the in-browser simulation — the demo never breaks.

## API (superset of the sim's `createApi` contract)

| Endpoint | Returns |
|---|---|
| `GET /api/health` | status, modelsReady, model card, dataset md5 |
| `GET /api/dealers?search&state&district&sector&segment&risk&page&pageSize` | `{results, total, page, pageSize}` — every dealer carries both engines' verdicts + `mlReasons` |
| `GET /api/dealer/{gstin}` | full dealer record incl. ML fields |
| `GET /api/dealer/{gstin}/score` | dossier: ruleEngine vs ml side-by-side + model card |
| `POST /api/score` | ad-hoc dealer scoring (single-dealer intake / what-if) |
| `GET /api/district-summary` · `/api/sector-summary` · `/api/anomaly-breakdown` · `/api/summary-stats` | same shapes as the sim, plus an `ml` block (high/med/low, avg, rule agreement %) |
| `GET /api/shap-global` | top-15 global mean-\|SHAP\| drivers |
| `GET /api/flags` · `POST /api/flags` | officer audit trail, persisted to `server/flags.json` (survives reloads — shared across officers) |

## Responsible-AI notes (QA-card ready)

- Trained on 100% synthetic data (no real taxpayer records); generator mirrors
  statistical structure only.
- Over-reporters never score — both engines hunt upward gaps only.
- Every ML flag ships its SHAP attributions in plain language + rupees; the
  rule engine's reasons stay side-by-side for officer corroboration.
- Paper-only evidence is capped (PAPER_CAP) in the rules; the ML model is the
  ranking layer, officers still decide — human-in-the-loop by design.
