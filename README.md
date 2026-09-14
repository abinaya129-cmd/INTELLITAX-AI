# INTELLITAX-AI
### Sector-Conditioned GST Anomaly Detection — Tamil Nadu Commercial Tax · Hackathon 2026

> **One line:** Every dealer is scored with the evidence that fits its business model —
> manufacturers on electricity + employee count, traders on the GSTR-2A − 3B
> stock-reconciliation checkpoint, logistics on fleet economics — with every score
> explained in rupees, not jargon.

---

## 1. Problem definition & relevance

India's GST net leaks an estimated **₹2+ lakh crore a year** (Directorate General of
Analytics & Risk Management figures; TN's share of registered dealers is 15 lakh+).
Three structural failures drive it:

| Failure | What it looks like | Who does it |
|---|---|---|
| **Suppressed turnover** | Factory at full capacity declaring a fraction of output | Manufacturers |
| **Conduit / bull-gear fraud** | Purchases on record, sales never invoiced — ITC laundering | Traders |
| **Freight revenue under-declaration** | Fleet running full routes, revenue declared at a fraction | Logistics |

The national loss is a **direct transfer from hospitals, roads and schools**. Existing
rule-based systems apply *one formula to every trade*, so they flag honest employers
while missing conduits whose paperwork is internally consistent.

## 2. Users & problem validation

- **Primary users:** Range Officers / Intelligence Wing of the Commercial Tax
  Department — our scoring screen mirrors their case-selection workflow
  (list → filter → prioritise → act), confirmed against the public
  " GST Officer " job workflows and departmental press notes on data-led selection.
- **Evidence of the pattern:** DGGI press releases repeatedly describe the same
  typologies we encode — fake ITC chains via conduit firms (₹700 Cr+ single-network
  cases), factories with suppressed turnover detected via electricity/EPF cross-checks,
  and transporters under-declaring freight income.
- **Validation built into the product:** every 10th row of our dataset carries a
  *planted* fraud typology with ground-truth labels, so the model's precision/recall
  is measurable, not claimed.

## 3. Originality & innovation

1. **Sector-conditioned scoring (our core novelty).** Evidence only counts when the
   business model makes it count:
   - *Manufacturers* → **electricity + employee count** define the physical ceiling.
     The **employment signal is deliberately bounded (max 26 pts alone)** — a genuine
     mid-scale employer is never flagged on headcount. E-way bills are deliberately
     NOT scored: goods movement supports a genuine and a fraudulent firm alike.
   - *Traders* → production signals are **not evidence at all**. The checkpoint is
     pure return triangulation:
     `GSTR-2A purchases − GSTR-3B sales = the stock the books must show`.
     Buy ₹20 L, sell ₹15 L → the ₹5 L balance must sit on the shelf (books showing
     ~₹7 L pass within the sector's margin tolerance). Books far **below** the
     balance mean goods left through undeclared sales; books far **above** it mean
     paper/dummy purchases propping up ITC — either face fails the checkpoint.
     Conduits (2A purchases, no GSTR-1 sales) and **GSTR-1 vs 3B divergence**
     (invoiced but never returned — the *main culprits*) are flagged alongside.
   - *Logistics* → fleet economics: trips × distance × realisation/km put a floor
     under declared revenue (the one segment where e-way stays, as its feed).
2. **Asymmetric fraud direction.** Competing hacks penalise both directions.
   We score **only upward gaps** (evidence ≫ declared). Over-reporting earns zero
   points — because understated turnover, not paperwork noise, is the real crime.
   And return-derived evidence is capped (≤85 pts) so paper alone can never
   outrank physically corroborated fraud.
3. **Rupee-explainability.** Every flagged dealer ships with plain-language reasons
   quoting the exact gap ("₹90.59 L implied vs ₹21.48 L declared — 77% unexplained").

## 4. Meaningful application of AI

- A transparent, tuned **cross-signal scoring model** (weighted evidence blocks with
  per-segment saturation curves) that is fully explainable — an officer can trace
  every point.
- The architecture is deliberately **model-swappable**: the same feature rows
  (`full_dataset_with_scores.csv`) are ready for Isolation Forest / gradient-boosted
  classifiers as a phase-2, with the rule kernel kept as the explainable fallback and
  sanity bound (responsible-AI layering).
- Ground-truth planted typologies enable supervised evaluation today.

## 5. Technical architecture

```
Data feeds (synthetic, statistically realistic)      Scoring kernel (src/data/gstDataEngine.js)
├─ gst_returns.csv  (GSTR-1/3B/2A)  ─┐               ├─ segment router (Manufacturer/Trader/Logistics)
├─ electricity.csv  (TANGEDCO)      ─┼─▶ genDealers()─├─ stock-reconciliation checkpoint (2A−3B vs books)
├─ freight.csv      (e-way, LOGIST. ─┤   15,000 rows ├─ per-segment evidence weights + tolerances
├─ employment.csv   (EPF/ESI)       ─┘               └─ composite-threshold + ITC checks
                                                              │
            React 19 + Vite dashboard  ◀── simulated REST API (220 ms latency, pagination)
            (landing · command center · dealer list · profile · analytics)
```

- **Detection blocks:** electricity (≤55) + employment (≤26, manufacturers only) +
  **stock reconciliation (≤55, traders)** + purchase-without-sale (≤40) + turnover
  divergence (≤35) + fleet economics (≤72, logistics) + excessive ITC (≤20) +
  corroborated threshold gaming (≤32); return-derived evidence capped at 85 → 0-100
  (High ≥60, Medium ≥30).
- **Dataset generator:** `node scripts/generate_dataset.mjs` regenerates the CSVs
  **with the same kernel** that runs in the demo — data and scores can never drift.

## 6. Working prototype (live demo)

The repository **is** the prototype: `npm install && npm run dev`.
- Landing page with the live top-risk dealer and its rupee explanation.
- **Command Center:** district heatmap, risk distribution, anomaly taxonomy,
  estimated annual tax at risk.
- **Dealer list:** search + segment/district/sector/risk filters, pagination.
- **Dealer profile:** declared-vs-implied revenue chart, segment-aware raw signal
  panel (GSTR triangulation for traders, electricity for factories, fleet for
  transporters), officer actions with persisted audit trail.

## 7. Testing, performance & reliability

Measured on the shipped 15,000-row dataset (1,500 planted frauds):

| Metric | Result |
|---|---|
| Recall (planted frauds caught, score ≥30) | **96.9%** |
| False positives among compliant rows | **0** (0 / 13,500) |
| Precision proxy (flagged that are planted) | 100% |
| Typology agreement (top label = planted type) | 75.3% (single-label metric; multi-cue rows are counted as partial) |
| Flag rate by segment | Mfr 7.2% · Trader 11.1% · Logistics 15.4% |
| Scoring throughput | 15,000 rows < 100 ms (client-side) |
| Build | Vite production build, 0 lint errors |

Reproduce anytime: `node scripts/generate_dataset.mjs` (deterministic seed 42).
The spec case is encoded in the kernel: a trader buying ₹20 L and selling ₹15 L
with ₹7 L of book stock scores **0 (passes)**; the same returns with ₹2 L of book
stock scores **31 (flagged)**.

## 8. Responsible AI

- **Privacy:** 100% synthetic data mirroring statistical structure only — no real
  GSTIN, taxpayer, or consumer record exists in the repo.
- **Fairness:** per-segment weighting is explicitly designed to remove structural
  bias (no trader flagged for having a small office; no manufacturer flagged for
  employing people). Over-reporters are never penalised.
- **Transparency:** every score is traceable to named evidence in rupees; no black
  box makes the final call.
- **Security posture:** action notes and audit trail are append-only; in production
  the design assumes departmental SSO and feed-level encryption (NIC/TANGEDCO APIs).
- **Human-in-the-loop:** the model *prioritises*, the officer *decides* — flag /
  assign / clear-as-false-positive is always human.

## 9. Impact, scalability & sustainability

- Screening 15 lakh TN dealers at the demo's throughput is a background batch job
  on a single departmental VM; the kernel is O(n) per dealer.
- At the observed ~6% high-risk rate, an officer's casework is pre-sorted from
  15 lakh files to ~90k prioritised cases with rupee-quantified justification —
  **an order-of-magnitude reduction in investigation latency**.
- Sustainable because every new data feed (electricity, e-way, EPF, GSTN) is one
  adapter + one weight row, not a new model.

## 10. Business / implementation model

- **Adoption path:** pilot in 2 TN ranges with historical enforcement outcomes →
  shadow-run against officer-selected cases → integrate as the case-selection
  layer of the existing departmental portal (no rip-and-replace).
- **Competitive advantage:** sector-conditioned evidence + asymmetric evasion
  scoring + rupee explainability — packaged as a thin, state-owned layer over data
  the department already collects.
- **Moat:** every officer action (flag/assign/clear) feeds back as labels, making
  the prioritisation better every quarter.

## 11. Presentation & jury readiness

- The 60-second story: *"One formula flags the wrong trades. We give each trade its
  own evidence — and show the stolen rupees."*
- Live-demo script: landing (top fraudster in rupees) → Command Center (heatmap +
  tax-at-risk) → filter Traders → open a conduit (₹1.39 Cr purchases vs ₹28 L
  sales) → flag it → Analytics taxonomy.
- Anticipated Q&A is covered by sections 2, 7 and 8 above.

---

### Repository map
```
src/data/gstDataEngine.js     sector-conditioned engine (generation + scoring + API)
src/gst_complete_workflow.jsx dashboard UI (landing, command center, dealers, profile, analytics)
scripts/generate_dataset.mjs  dataset generator → gst_dataset27.zip
dataset_out/                  generated CSVs + README_dataset.txt (column dictionary)
gst_dataset27.zip             distributable dataset with planted ground truth
```

### Run & deploy
```bash
npm install
npm run dev          # local demo at http://localhost:5173
npm run build        # production bundle → dist/
npm run lint         # oxlint, 0 errors
node scripts/generate_dataset.mjs   # regenerate dataset + gst_dataset27.zip
```

Deployment is a static build — any static host works:
- **Vercel / Netlify:** framework preset "Vite", build `npm run build`, output `dist`
- **GitHub Pages:** push `dist/` to a `gh-pages` branch (or set base in `vite.config.js`)
- **Any web server:** serve `dist/` as static files

Officer flags persist in the browser (`localStorage`) for demo continuity; in a
production deployment this layer would be swapped for departmental storage.
