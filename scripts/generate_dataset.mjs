/* ================================================================================
   INTELLITAX-AI · Dataset generator (Node, no dependencies)
   --------------------------------------------------------------------------------
   Regenerates the synthetic-but-realistic Tamil Nadu dealer dataset using the
   SAME sector-conditioned scoring kernel that runs live in the dashboard, so
   the CSV always matches what the demo shows.

   Output (gst_dataset28.zip):
     gst_returns.csv            — GSTR-1 / 3B / 2A triangulation + declared, tax, ITC
     electricity.csv            — TANGEDCO-style consumption feed
     freight.csv                — e-way bill feed (LOGISTICS ONLY since v28)
     employment.csv             — EPF/ESI headcount + wage bill
     full_dataset_with_scores.csv — everything joined + engine scores
     README_dataset.txt         — column dictionary & planted-type note

   Usage:  node scripts/generate_dataset.mjs
   ================================================================================ */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  genDealers, N_DEALERS, TAX_RATE, ELE_TOL, TURN_TOL, PURCH_TOL,
  STOCK_TOL, STOCK_CAP, COMPOSITE_LIMIT, COMPOSITE_TOL,
} from '../src/data/gstDataEngine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dataset_out');
mkdirSync(outDir, { recursive: true });

const dealers = genDealers();

/* segment splits for the dataset summary */
const segCount = {};
dealers.forEach((d) => { segCount[d.segment] = (segCount[d.segment] || 0) + 1; });

/* ---------- gst_returns.csv (GSTR-1 / GSTR-3B / GSTR-2A view) ---------- */
const gstReturns =
  'gstin,businessName,district,sector,segment,regType,declared,gstr1Sales,gstr3bTurnover,purchases,taxPaid,itcClaimed,itcRatio,filingStatus\n' +
  dealers.map((d) => [
    d.gstin, csv(d.businessName), d.district, csv(d.sector), d.segment, d.regType,
    r2(d.declared), r2(d.gstr1Sales), r2(d.gstr3bTurnover), r2(d.purchases),
    r2(d.taxPaid), r2(d.itcClaimed), d.itcRatio.toFixed(4), d.filingStatus,
  ].join(',')).join('\n') + '\n';

/* ---------- electricity.csv ---------- */
const electricity =
  'gstin,connectionType,sanctionedLoad,monthlyUnits\n' +
  dealers.filter((d) => d.monthlyUnits != null)
    .map((d) => [d.gstin, d.connectionType, d.sanctionedLoad.toFixed(2), d.monthlyUnits.toFixed(1)].join(',')).join('\n') + '\n';

/* ---------- freight.csv (logistics only — e-way is not evidence elsewhere) --- */
const freight =
  'gstin,ewayCountMonthly,ewayValueMonthly,avgDistance\n' +
  dealers.filter((d) => d.segment === 'Logistics')
    .map((d) => [d.gstin, d.ewayCountMonthly, r2(d.ewayValueMonthly), d.avgDistance != null ? d.avgDistance.toFixed(1) : ''].join(',')).join('\n') + '\n';

/* ---------- employment.csv ---------- */
const employment =
  'gstin,headcount,wageBill,impliedRevenue\n' +
  dealers.map((d) => [d.gstin, d.headcount, r2(d.wageBill), d.impliedEmp != null ? r2(d.impliedEmp) : ''].join(',')).join('\n') + '\n';

/* ---------- full_dataset_with_scores.csv ---------- */
const fullHeader =
  'gstin,businessName,district,sector,segment,regType,declared,gstr1Sales,gstr3bTurnover,purchases,bookStock,stockBalance,stockShort,stockExcess,taxPaid,itcClaimed,itcRatio,filingStatus,' +
  'connectionType,sanctionedLoad,monthlyUnits,ewayCountMonthly,ewayValueMonthly,avgDistance,headcount,wageBill,' +
  'impliedElec,impliedEmp,fleetImplied,purchaseFlowRatio,purchaseNoSale,turnoverDivergence,' +
  'riskScore,riskTier,detectedAnomalyType,plantedType,reasons\n';
const fullRows = dealers.map((d) => [
  d.gstin, csv(d.businessName), d.district, csv(d.sector), d.segment, d.regType,
  r2(d.declared), r2(d.gstr1Sales), r2(d.gstr3bTurnover), r2(d.purchases),
  d.bookStock != null ? r2(d.bookStock) : '',
  d.stockBalance != null ? r2(d.stockBalance) : '',
  d.stockShort != null ? d.stockShort.toFixed(3) : '',
  d.stockExcess != null ? d.stockExcess.toFixed(3) : '',
  r2(d.taxPaid), r2(d.itcClaimed), d.itcRatio.toFixed(4), d.filingStatus,
  d.connectionType, d.sanctionedLoad != null ? d.sanctionedLoad.toFixed(2) : '',
  d.monthlyUnits != null ? d.monthlyUnits.toFixed(1) : '',
  d.segment === 'Logistics' ? d.ewayCountMonthly : '',
  d.segment === 'Logistics' && d.ewayValueMonthly != null ? r2(d.ewayValueMonthly) : '',
  d.segment === 'Logistics' && d.avgDistance != null ? d.avgDistance.toFixed(1) : '',
  d.headcount, r2(d.wageBill),
  d.impliedElec != null ? r2(d.impliedElec) : '',
  d.impliedEmp != null ? r2(d.impliedEmp) : '',
  d.fleetImplied != null ? r2(d.fleetImplied) : '',
  d.purchaseFlowRatio != null ? d.purchaseFlowRatio.toFixed(3) : '',
  d.purchaseNoSale != null ? d.purchaseNoSale.toFixed(3) : '',
  d.turnoverDivergence != null ? d.turnoverDivergence.toFixed(3) : '',
  d.riskScore, d.riskTier, d.detectedType || 'none', d.plantedType || 'none',
  csv(d.reasons.join(' | ')),
].join(','));

const full = fullHeader + fullRows.join('\n') + '\n';

/* ---------- data dictionary ---------- */
const dict = `INTELLITAX-AI synthetic GST dataset (gst_dataset28)
=====================================================
Rows: ${dealers.length} Tamil Nadu dealers (deterministic seed 42)
Segment mix: ${Object.entries(segCount).map(([k, v]) => `${k} ${v}`).join(', ')}

DETECTION MODEL (sector-conditioned — v28 checkpoint model)
  Manufacturers : ELECTRICITY + EMPLOYEE COUNT only. E-way bills are NOT scored.
                  Fraud = production footprint >> declared turnover.
  Traders       : pure GSTR return triangulation — no e-way, no electricity.
                  THE CHECKPOINT: GSTR-2A purchases - GSTR-3B sales must equal
                  the stock the books claim (proportions must match).
                  buy Rs.20 L -> sell Rs.15 L -> books must show ~Rs.5-7 L stock
                  and PASS; books far below = goods sold off-book; books far
                  above = paper stock propping up ITC. Both are flagged.
  Logistics     : fleet economics (trips x distance x per-km realisation) imply
                  the revenue floor; e-way bills remain descriptive evidence.

ASYMMETRY RULE (all versions)
  Only UPWARD gaps are scored (evidence >> declared turnover). Over-reporters
  get a consistency note, never points — understated turnover is the primary
  evasion signature, so low declarers are treated as the main culprits.

COLUMNS (full_dataset_with_scores.csv)
  gstin                  15-char GSTIN (33 = Tamil Nadu state code)
  businessName           synthetic legal name
  district               one of 16 TN districts (industrial-weight sampling)
  sector                 10 business sectors
  segment                Manufacturer | Trader | Logistics (drives the model)
  regType                Regular | Composite (Composite capped at Rs.1.5 Cr)
  declared               annual turnover declared in GSTR-3B (Rs.)
  gstr1Sales             invoiced outward supplies, GSTR-1 (Rs.)
  gstr3bTurnover         cash returned in GSTR-3B (Rs.)
  purchases              inward supplies visible in GSTR-2A (Rs.)
  taxPaid                net cash GST paid (Rs.)
  itcClaimed / itcRatio  Input Tax Credit claimed and its share of turnover
  filingStatus           Filed on time | Filed late | Non-filer
  monthlyUnits           electricity kWh/month (TANGEDCO-style feed)
  ewayCountMonthly       e-way bills per month (LOGISTICS rows only, else blank)
  ewayValueMonthly       goods value moved per month (Rs., logistics rows only)
  headcount, wageBill    EPF/ESI-registered employees and annual wage bill
  impliedElec            revenue implied by power draw (Rs./yr, manufacturers)
  impliedEmp             revenue capacity implied by headcount (Rs./yr)
  fleetImplied           revenue implied by fleet activity (Rs./yr, logistics)
  bookStock              closing stock the BOOKS claim (Rs.)
  stockBalance           2A purchases - 3B sales: the balance the books must
                         cover (Rs.; negative = net outward during the year)
  stockShort             (balance - books) / purchases, when books fall short
  stockExcess            (books - 1.6x balance) / balance, paper-stock face
  purchaseFlowRatio      GSTR-2A purchases / GSTR-1 sales
  purchaseNoSale         share of purchases with no matching sales (0-1)
  turnoverDivergence     GSTR-1 sales not returned in 3B (0-1)
  riskScore              0-100 engine score (>=60 High, >=30 Medium)
  riskTier               Low / Medium / High Risk
  detectedAnomalyType    engine-assigned typology
  plantedType            ground-truth typology used to generate the row
                         ('none' = compliant draw; used for precision/recall)
  reasons                plain-language explanation, pipe-separated

GROUND TRUTH
  Every 10th row carries a planted typology (plantedType), so precision and
  recall of the scoring kernel can be measured directly from the CSV.
  Detection thresholds: ELE_TOL=${ELE_TOL}, TURN_TOL=${TURN_TOL}, PURCH_TOL=${PURCH_TOL},
  STOCK_TOL=${STOCK_TOL} (cap ${STOCK_CAP}), composite band=${Math.round(COMPOSITE_TOL * 100)}%
  under Rs.${(COMPOSITE_LIMIT / 1e7).toFixed(1)} Cr, representative GST rate=${TAX_RATE * 100}%.

ALL DATA IS SYNTHETIC. No real taxpayer, GSTIN, or consumer record is used —
the generator mirrors statistical structure only (responsible-AI by design).
`;

writeFileSync(join(outDir, 'gst_returns.csv'), gstReturns);
writeFileSync(join(outDir, 'electricity.csv'), electricity);
writeFileSync(join(outDir, 'freight.csv'), freight);
writeFileSync(join(outDir, 'employment.csv'), employment);
writeFileSync(join(outDir, 'full_dataset_with_scores.csv'), full);
writeFileSync(join(outDir, 'README_dataset.txt'), dict);

/* ---------- validation summary ---------- */
const high = dealers.filter((d) => d.riskScore >= 60).length;
const med = dealers.filter((d) => d.riskScore >= 30 && d.riskScore < 60).length;
const planted = dealers.filter((d) => d.plantedType && d.plantedType !== 'none');
const caught = planted.filter((d) => d.riskScore >= 30);
const falsePos = dealers.filter((d) => (!d.plantedType || d.plantedType === 'none') && d.riskScore >= 30);

/* type agreement: engine top-typology matches the planted one */
const typeAgree = planted.filter((d) => d.detectedType === d.plantedType);

console.log(`Generated ${dealers.length} dealer rows in dataset_out/`);
console.log(`Segments: ${JSON.stringify(segCount)}`);
console.log(`Tiers: High ${high} (${pct(high, N_DEALERS)}), Medium ${med} (${pct(med, N_DEALERS)}), Low ${N_DEALERS - high - med} (${pct(N_DEALERS - high - med, N_DEALERS)})`);
console.log(`Planted fraud: ${planted.length} · caught (>=30): ${caught.length} (${pct(caught.length, planted.length)} recall)`);
console.log(`Typology agreement: ${typeAgree.length}/${planted.length} (${pct(typeAgree.length, planted.length)})`);
console.log(`False positives among compliant rows: ${falsePos.length} of ${N_DEALERS - planted.length} (${pct(falsePos.length, N_DEALERS - planted.length)})`);

/* ---------- zip ---------- */
const zipPath = join(root, 'gst_dataset28.zip');
const zipCmd = process.platform === 'win32'
  ? `powershell -NoProfile -Command "Compress-Archive -Path '${outDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`
  : `cd "${outDir}" && zip -j "${zipPath}" *.csv README_dataset.txt`;
execSync(zipCmd, { stdio: 'inherit' });
console.log(`Zipped -> ${zipPath}`);

function csv(s) { return `"${String(s).replace(/"/g, '""')}"`; }
function r2(n) { return Number(n).toFixed(2); }
function pct(a, b) { return b ? `${Math.round((a / b) * 1000) / 10}%` : '—'; }
