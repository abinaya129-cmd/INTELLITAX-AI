/* ================================================================================
   INTELLITAX-AI · GST Anomaly Detection Engine (sector-conditioned)
   --------------------------------------------------------------------------------
   One formula does not fit every trade. Evidence is interpreted through the
   lens of the business model:

     MANUFACTURERS — production signals (electricity, employment) + goods flow.
       Fraud pattern: real factory footprint, suppressed declared turnover
       (cash skimming / off-book sales). KEY signal: implied >> declared.
       Weight rule: employment signal is deliberately LOW (0.40 of a block that
       itself saturates below the flag line) so headcount alone can NEVER push
       a genuine mid-scale manufacturer into the flagged tiers.

     TRADERS — production signals are structurally weak (a 4-person trading
       firm can legitimately clear ₹100 Cr). Electricity/employment are NOT
       scored. Evidence = goods movement (e-way bills) + GSTR-1 / GSTR-2A /
       GSTR-3B triangulation:
         · gstr_purchase_no_sale   — GSTR-2A purchases with no matching GSTR-1
           sales (conduit / bull-gear firm: ITC at input, invoices never surface
           at output).
         · gstr_turnover_divergence — GSTR-1 invoiced sales far above the cash
           returned in GSTR-3B (margin skimmed off-book). Understating turnover
           is the primary evasion pattern and is prioritised over over-reporting.

     LOGISTICS — freight IS the revenue driver. Fleet economics
       (trips × distance × realisation/km) imply a revenue floor.

   ASYMMETRY FIX — the old engine penalised declared >> implied ("gapDown"),
   i.e. it punished over-reporting. Over-reporting is not evasion; the engine
   now scores only upward gaps (physical evidence >> declared turnover) and
   leaves a non-scoring consistency note for over-reporters (responsible-AI
   fairness: no false positives on businesses that over-declare).
   ================================================================================ */

/* ============================== DESIGN TOKENS ============================== */
export const C = {
  ink: '#0A0F1C', ink2: '#0F1626', panel: '#131B2E', panelLine: '#232E45',
  paper: '#F3EFE3', paperLine: '#DCD5C2', inkOnPaper: '#221C10',
  seal: '#B08A2E', sealBright: '#D4AC4E',
  text: '#E7E9F0', textSoft: '#9AA6BC', textFaint: '#5E6B85',
  low: '#3FA562', med: '#D3922F', high: '#C1453B',
  elec: '#4FA6D8', freight: '#E0A23D', emp: '#6BBF8E',
  gstp: '#8FA6E8', gstp2: '#A783D1',
};

/* ============================== SEGMENTS & SECTORS ============================== */
export const SEGMENTS = ['Manufacturer', 'Trader', 'Logistics'];

export const DISTRICTS = ["Chennai","Coimbatore","Madurai","Tiruchirappalli","Salem","Tirunelveli","Erode","Vellore","Thoothukudi","Dindigul","Thanjavur","Ranipet","Sivaganga","Karur","Namakkal","Kanchipuram"];

/* District sampling weights (rough share of TN's industrial dealer base). */
const DISTRICT_WEIGHTS = [
  ["Chennai", 15], ["Coimbatore", 10], ["Madurai", 8], ["Tiruchirappalli", 7],
  ["Salem", 7], ["Tirunelveli", 5], ["Erode", 6], ["Vellore", 5],
  ["Thoothukudi", 4], ["Dindigul", 4], ["Thanjavur", 5], ["Ranipet", 4],
  ["Sivaganga", 3], ["Karur", 5], ["Namakkal", 5], ["Kanchipuram", 7],
];

/* Sector evidence profiles.
   revPerUnit     : ₹ revenue per kWh (production sectors)
   revPerEmployee : ₹ revenue per EPF/ESI employee
   freightRatio   : e-way goods value / annual revenue (cargo multiple for logistics)
   perKmRate      : ₹ realisation per vehicle-km (logistics)
   noisy          : trade floors are noisy — irrelevant here because traders are
                    not scored on production signals at all. */
export const SECTORS = {
  "Textile Manufacturing":       { segment: 'Manufacturer', revPerUnit: 180, revPerEmployee: 850000,  freightRatio: 1.05 },
  "Steel & Metal Fabrication":   { segment: 'Manufacturer', revPerUnit: 140, revPerEmployee: 1200000, freightRatio: 1.10 },
  "Auto Components":             { segment: 'Manufacturer', revPerUnit: 150, revPerEmployee: 1300000, freightRatio: 1.08 },
  "Chemical & Pharma":           { segment: 'Manufacturer', revPerUnit: 220, revPerEmployee: 1400000, freightRatio: 1.02 },
  "Food Processing":             { segment: 'Manufacturer', revPerUnit: 200, revPerEmployee: 820000,  freightRatio: 0.98 },
  "FMCG Trading":                { segment: 'Trader', revPerEmployee: 950000,  freightRatio: 0.95 },
  "Electronics Retail":          { segment: 'Trader', revPerEmployee: 1100000, freightRatio: 0.90 },
  "Wholesale Trading":           { segment: 'Trader', revPerEmployee: 900000,  freightRatio: 1.00 },
  "Construction Materials":      { segment: 'Trader', revPerEmployee: 780000,  freightRatio: 1.15 },
  "Logistics & Transport":       { segment: 'Logistics', revPerEmployee: 1000000, freightRatio: 3.20, perKmRate: 42 },
};
export const SECTOR_KEYS = Object.keys(SECTORS);

/* ============================== ANOMALY TAXONOMY ============================== */
export const ANOMALY_LABELS = {
  electricity_mismatch: "Electricity Mismatch",
  freight_mismatch: "Freight / E-way Bill Mismatch",
  employment_mismatch: "Employment Mismatch",
  threshold_manipulation: "Composite Threshold Gaming",
  shell_itc_pattern: "Excessive ITC / Shell Pattern",
  gstr_purchase_no_sale: "GSTR-2A Purchases w/o Sales",
  gstr_turnover_divergence: "GSTR-1 vs 3B Divergence",
  fleet_revenue_mismatch: "Fleet Revenue Mismatch",
};
export const ANOMALY_ORDER = Object.keys(ANOMALY_LABELS);
export const ANOMALY_COLORS = {
  electricity_mismatch: C.elec, freight_mismatch: C.freight, employment_mismatch: C.emp,
  threshold_manipulation: '#5EC9C9', shell_itc_pattern: C.gstp2,
  gstr_purchase_no_sale: C.gstp, gstr_turnover_divergence: C.gstp2, fleet_revenue_mismatch: C.freight,
};

/* Which segments can exhibit which anomaly (drives seeding + labelling). */
export const ANOMALY_SEGMENTS = {
  electricity_mismatch: ['Manufacturer'],
  freight_mismatch: ['Manufacturer', 'Trader'],
  employment_mismatch: ['Manufacturer', 'Logistics'],
  threshold_manipulation: ['Manufacturer', 'Trader', 'Logistics'],
  shell_itc_pattern: ['Manufacturer', 'Trader', 'Logistics'],
  gstr_purchase_no_sale: ['Trader'],
  gstr_turnover_divergence: ['Trader'],
  fleet_revenue_mismatch: ['Logistics'],
};

/* ============================== SCORING CONSTANTS ============================== */
export const N_DEALERS = 15000;
export const PAGE_SIZE = 15;
export const TAX_RATE = 0.18;

/* Upward-gap tolerance applied to the weighted physical evidence score.
   Set just above the maximum noise band of the physical feeds (~±15%), so
   compliant dealers never cross into the flagged tiers on noise alone. */
export const ELE_TOL = 0.18;

/* GSTR triangulation tolerances. */
export const TURN_TOL = 0.15;    // GSTR-1 vs 3B divergence tolerance
export const TURN_CAP = 0.55;    // divergence where the score saturates
export const PURCH_TOL = 0.25;   // purchase-without-sale tolerance
export const PURCH_CAP = 0.75;   // saturation point

/* Block weights (max points per evidence block). */
export const PHYS_WEIGHT = 80;   // weighted physical/e-way evidence
export const PURCH_WEIGHT = 45;  // GSTR-2A purchases without sales
export const TURN_WEIGHT = 35;   // GSTR-1 vs 3B divergence
export const FLEET_WEIGHT = 80;  // logistics fleet economics (IS the logistics physical block)
export const ITC_WEIGHT = 30;    // excessive ITC
export const THRESHOLD_WEIGHT = 25; // composite threshold gaming

/* ITC ratio norms: [sector floor, norm ceiling, saturation cap]. */
export const ITC_NORM = [0.03, 0.14];
export const ITC_CAP = 0.45;

/* Composite scheme turnover cap (₹1.5 Cr) and "just under" band. */
export const COMPOSITE_LIMIT = 15000000;
export const COMPOSITE_TOL = 0.05;

/* Fleet economics (logistics). */
export const FUEL_PRICE = 92;       // ₹ per litre diesel (display)
export const KM_PER_LITRE = 3.5;    // km per litre (display)

/* Segment weights for the physical-evidence block (sum to 1.0 over the
   signals that are meaningful for the segment).
   · Manufacturer — employment weighted but bounded: an employment-only gap
     yields at most ~20/80 pts, so headcount alone can never flag a firm.
   · Trader — goods movement only; production signals are not evidence here.
   · Logistics — the dedicated fleet-economics block (FLEET_WEIGHT) serves as
     the physical block; employment corroborates in the explanation text but is
     not scored separately (the two gaps measure the same suppression — scoring
     both would double-count and peg every fleet at 100). */
export const SEGMENT_WEIGHTS = {
  Manufacturer: { electricity: 0.35, freight: 0.25, employment: 0.40 },
  Trader:       { freight: 1.00 },
  Logistics:    {},
};

/* ============================== HELPERS ============================== */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function lognormal(rng, mean, sigma) {
  const u1 = Math.max(rng(), 1e-9), u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(mean + sigma * z);
}
export function genGSTIN(rng, i) {
  const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(rng() * 26))).join('');
  const digits = (n) => Array.from({ length: n }, () => Math.floor(rng() * 10)).join('');
  return `33${letters()}${digits(4)}${String.fromCharCode(65 + Math.floor(rng() * 26))}${(i % 9) + 1}Z${Math.floor(rng() * 10)}`;
}
export function riskTier(score) {
  if (score >= 60) return { label: 'High Risk', color: C.high };
  if (score >= 30) return { label: 'Medium Risk', color: C.med };
  return { label: 'Low Risk', color: C.low };
}
export function fmtCr(n) { return `₹${(n / 10000000).toFixed(2)} Cr`; }
export function fmtMoney(n) {
  if (n == null) return '—';
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
/* Upward gap only: how much LARGER the physical evidence is than the declaration. */
export function gapUp(declared, implied) {
  if (!implied || implied <= 0 || !declared) return 0;
  return Math.max(0, 1 - declared / implied);
}

const PREFIXES = ["Sri","Sree","New","United","National","Om","Amman","Kaveri","Vaigai","Bharat","Modern","Prime","Anna","Ponni"];
const SUFFIX_BY_SECTOR = {
  "Textile Manufacturing": ["Textiles","Mills","Weaving Co"], "Steel & Metal Fabrication": ["Steels","Metal Works","Fabricators"],
  "Auto Components": ["Auto Parts","Components","Engineering"], "Chemical & Pharma": ["Chemicals","Pharma","Labs"],
  "Food Processing": ["Foods","Agro Products","Processing"],
  "FMCG Trading": ["Trading Co","Enterprises","Distributors"], "Electronics Retail": ["Electronics","Digital Store","Retail"],
  "Wholesale Trading": ["Wholesale","Traders","Supply Co"], "Construction Materials": ["Building Materials","Traders","Suppliers"],
  "Logistics & Transport": ["Logistics","Transports","Carriers"],
};
export function genBusinessName(rng, sector) {
  const suffixes = SUFFIX_BY_SECTOR[sector] || ["Enterprises"];
  return `${PREFIXES[Math.floor(rng() * PREFIXES.length)]} ${suffixes[Math.floor(rng() * suffixes.length)]}`;
}
export function genDistrict(rng) {
  const total = DISTRICT_WEIGHTS.reduce((s, d) => s + d[1], 0);
  let roll = rng() * total;
  for (const [name, w] of DISTRICT_WEIGHTS) { roll -= w; if (roll <= 0) return name; }
  return DISTRICT_WEIGHTS[0][0];
}

/* ============================== GENERATION ============================== */
export function genDealers() {
  const rng = mulberry32(42);
  const dealers = [];

  for (let i = 0; i < N_DEALERS; i++) {
    /* --- seed plan: every 10th dealer carries a planted fraud typology,
           restricted to segments where that typology is possible --- */
    const isSeed = i % 10 === 0;
    const seedType = isSeed ? ANOMALY_TYPES[i / 10 % ANOMALY_TYPES.length | 0] : null;
    const allowedSegs = seedType ? ANOMALY_SEGMENTS[seedType] : SEGMENTS;
    let sector;
    do { sector = SECTOR_KEYS[Math.floor(rng() * SECTOR_KEYS.length)]; }
    while (!allowedSegs.includes(SECTORS[sector].segment));
    const cfg = SECTORS[sector];
    const segment = cfg.segment;
    const district = genDistrict(rng);

    let trueScale = lognormal(rng, 15.5, 1.1);
    trueScale = Math.min(Math.max(trueScale, 500000), 500000000);

    let declared, itcRatio, regType = rng() < 0.97 ? 'Regular' : 'Composite';
    let elecMult = 1, empMult = 1, fleetMult = 1;
    let purchases, gstr1Sales, gstr3bTurnover;
    const normPurch = () => declared * (0.35 + rng() * 0.25);   // value-added margin
    const norm1A = () => declared * (0.97 + rng() * 0.06);
    const norm3B = () => declared * (0.98 + rng() * 0.04);

    if (!isSeed) {
      declared = trueScale * (0.95 + rng() * 0.10);
      itcRatio = segment === 'Manufacturer' ? 0.10 + rng() * 0.08
               : segment === 'Logistics' ? 0.02 + rng() * 0.06
               : ITC_NORM[0] + rng() * (ITC_NORM[1] - ITC_NORM[0]);
      purchases = normPurch(); gstr1Sales = norm1A(); gstr3bTurnover = norm3B();
    } else if (seedType === 'electricity_mismatch') {
      /* Factory draws full power; sales, payroll and freight partially hidden. */
      declared = trueScale * (0.20 + rng() * 0.20);
      elecMult = 1; empMult = 0.60 + rng() * 0.15;
      purchases = declared * (0.45 + rng() * 0.20); gstr1Sales = norm1A(); gstr3bTurnover = norm3B();
      itcRatio = 0.10 + rng() * 0.08;
    } else if (seedType === 'employment_mismatch') {
      /* Full workforce on EPF/ESI; power partly off-meter, sales suppressed. */
      declared = trueScale * (0.20 + rng() * 0.20);
      empMult = 1; elecMult = 0.55 + rng() * 0.15;
      purchases = declared * (0.45 + rng() * 0.20); gstr1Sales = norm1A(); gstr3bTurnover = norm3B();
      itcRatio = 0.10 + rng() * 0.08;
    } else if (seedType === 'freight_mismatch') {
      /* Goods move at true scale on e-way; turnover declared at a fraction. */
      declared = trueScale * (0.25 + rng() * 0.15);
      elecMult = segment === 'Manufacturer' ? 0.55 + rng() * 0.15 : 1;
      empMult = segment === 'Manufacturer' ? 0.55 + rng() * 0.15 : 1;
      purchases = declared * (1.50 + rng() * 0.50);
      gstr1Sales = declared * (0.60 + rng() * 0.15); gstr3bTurnover = declared * (0.75 + rng() * 0.10);
      itcRatio = 0.12 + rng() * 0.08;
    } else if (seedType === 'threshold_manipulation') {
      /* Parked just under ₹1.5 Cr (within the 5% band) while operating at a
         larger true scale — the classic threshold-gaming posture. */
      declared = COMPOSITE_LIMIT * (1 - rng() * (COMPOSITE_TOL - 0.002));
      regType = 'Composite';
      itcRatio = segment === 'Manufacturer' ? 0.10 + rng() * 0.08 : ITC_NORM[0] + rng() * 0.08;
      purchases = normPurch(); gstr1Sales = norm1A(); gstr3bTurnover = norm3B();
      elecMult = segment === 'Manufacturer' ? 0.80 + rng() * 0.15 : 1;
      empMult = segment === 'Manufacturer' ? 0.80 + rng() * 0.15 : 1;
      fleetMult = segment === 'Logistics' ? 1.35 + rng() * 0.30 : 1;
    } else if (seedType === 'shell_itc_pattern') {
      /* Paper entity: heavy ITC claims, thin real activity. */
      declared = trueScale * (0.35 + rng() * 0.15);
      itcRatio = 0.40 + rng() * 0.20;
      purchases = declared * (0.40 + rng() * 0.20); gstr1Sales = norm1A(); gstr3bTurnover = norm3B();
    } else if (seedType === 'gstr_purchase_no_sale') {
      /* Conduit: GSTR-2A purchases explode, GSTR-1 sales never surface. */
      declared = trueScale * (0.75 + rng() * 0.15);
      purchases = declared * (2.00 + rng() * 0.60);
      gstr1Sales = declared * (0.35 + rng() * 0.15);
      gstr3bTurnover = declared * (0.30 + rng() * 0.10);
      itcRatio = 0.25 + rng() * 0.12;
    } else if (seedType === 'gstr_turnover_divergence') {
      /* Invoiced sales (1A) far above cash returned (3B) — the main-culprit pattern. */
      declared = trueScale * (0.55 + rng() * 0.15);
      gstr1Sales = declared * (1.25 + rng() * 0.25);
      gstr3bTurnover = declared * (0.50 + rng() * 0.12);
      purchases = declared * (0.35 + rng() * 0.25);
      itcRatio = 0.22 + rng() * 0.10;
    } else if (seedType === 'fleet_revenue_mismatch') {
      /* Fleet runs at full scale; freight revenue declared at a fraction. */
      declared = trueScale * (0.20 + rng() * 0.25);
      fleetMult = 1.0 + rng() * 0.15;
      itcRatio = 0.02 + rng() * 0.06;
      purchases = declared * (0.20 + rng() * 0.15); gstr1Sales = norm1A(); gstr3bTurnover = norm3B();
    } else {
      declared = trueScale * (0.95 + rng() * 0.10);
      itcRatio = segment === 'Manufacturer' ? 0.10 + rng() * 0.08 : ITC_NORM[0] + rng() * 0.11;
      purchases = normPurch(); gstr1Sales = norm1A(); gstr3bTurnover = norm3B();
    }

    /* --- physical evidence --- */
    let monthlyUnits = null, impliedElec = null;
    if (segment === 'Manufacturer') {
      monthlyUnits = (trueScale / cfg.revPerUnit / 12) * elecMult * (0.85 + rng() * 0.30);
      impliedElec = monthlyUnits * 12 * cfg.revPerUnit;
    } else if (segment === 'Trader') {
      monthlyUnits = 400 + rng() * 2600;           // office/shop load only — not scored
    } else if (segment === 'Logistics') {
      monthlyUnits = 900 + rng() * 7000;           // warehouse load — not scored
    }

    /* freight: manufacturers/traders ewayValue ≈ revenue × freightRatio;
       logistics carries OTHERS' cargo → value multiple of its own revenue. */
    const cargoMult = segment === 'Logistics' ? cfg.freightRatio : 1;
    let fleetImplied = null, ewayValueAnnual, avgDistance;
    if (segment === 'Logistics') {
      fleetImplied = trueScale * fleetMult * (0.90 + rng() * 0.20);
      ewayValueAnnual = fleetImplied * cargoMult * (0.90 + rng() * 0.20);
      avgDistance = 40 + rng() * 410;
    } else {
      ewayValueAnnual = trueScale * cfg.freightRatio * (0.85 + rng() * 0.30);
      avgDistance = 15 + rng() * 435;
    }
    const ewayValueMonthly = ewayValueAnnual / 12;
    const ewayCountMonthly = Math.max(1, Math.round(ewayValueMonthly / (80000 + rng() * 170000)));

    /* employment */
    const headcount = Math.max(1, Math.round((trueScale / cfg.revPerEmployee) * empMult * (0.85 + rng() * 0.30)));
    const wageBill = headcount * (15000 + rng() * 20000) * 12;
    const impliedEmp = segment === 'Trader' ? null : headcount * cfg.revPerEmployee;

    const taxPaid = seedType === 'gstr_turnover_divergence'
      ? gstr3bTurnover * (0.08 + rng() * 0.06)
      : declared * (0.05 + rng() * 0.13);
    const itcClaimed = declared * itcRatio;

    const dealer = {
      gstin: genGSTIN(rng, i),
      businessName: genBusinessName(rng, sector),
      district, sector, segment, regType,
      declared, taxPaid, itcClaimed, itcRatio,
      gstr1Sales, gstr3bTurnover, purchases,
      filingStatus: rng() < 0.78 ? 'Filed on time' : (rng() < 0.85 ? 'Filed late' : 'Non-filer'),
      monthlyUnits, connectionType: monthlyUnits > 15000 ? 'HT' : 'LT',
      sanctionedLoad: monthlyUnits ? (monthlyUnits / 400) * (0.8 + rng() * 0.3) : null,
      ewayCountMonthly, ewayValueMonthly, avgDistance,
      headcount, wageBill, impliedElec, impliedEmp, fleetImplied,
      plantedType: seedType || null,
    };
    dealers.push(scoreDealer(dealer));
  }
  return dealers;
}

const ANOMALY_TYPES = ANOMALY_ORDER;

/* ============================== SCORING KERNEL ============================== */
export function scoreDealer(d) {
  const cfg = SECTORS[d.sector];
  const segment = cfg.segment;
  const w = SEGMENT_WEIGHTS[segment];

  /* --- 1. upward gaps on the physical evidence --- */
  /* freight evidence: for Manufacturers/Traders the e-way value vs declared
     turnover is itself evidence of off-book goods movement. For Logistics the
     e-way value reflects CARGO (not the operator's revenue) and is therefore
     excluded here — the dedicated fleet-economics block scores it instead. */
  const freightEvidence = segment === 'Logistics' ? null : (d.impliedFreight ?? d.ewayValueMonthly * 12);
  const gapElec = d.impliedElec ? gapUp(d.declared, d.impliedElec) : 0;
  const gapFreight = freightEvidence ? gapUp(d.declared, freightEvidence) : 0;
  const gapEmp = d.impliedEmp ? gapUp(d.declared, d.impliedEmp) : 0;

  const weighted =
    (w.electricity || 0) * gapElec +
    (w.freight || 0) * gapFreight +
    (w.employment || 0) * gapEmp;
  const physScore = Math.min(1, Math.max(0, (weighted - ELE_TOL) / (1 - ELE_TOL))) * PHYS_WEIGHT;

  /* --- 2. GSTR-2A purchases without matching GSTR-1 sales (conduit pattern) --- */
  const purchaseFlowRatio = d.purchases > 0 ? d.purchases / Math.max(1, d.gstr1Sales) : 0;
  const purchaseNoSale = d.purchases > 0 ? Math.max(0, 1 - d.gstr1Sales / d.purchases) : 0;
  const purchScore = Math.min(1, Math.max(0, (purchaseNoSale - PURCH_TOL) / (PURCH_CAP - PURCH_TOL))) * PURCH_WEIGHT;

  /* --- 3. GSTR-1 vs GSTR-3B divergence (invoiced but never paid) --- */
  const turnoverDivergence = d.gstr1Sales > 0 ? Math.max(0, 1 - d.gstr3bTurnover / d.gstr1Sales) : 0;
  const turnScore = Math.min(1, Math.max(0, (turnoverDivergence - TURN_TOL) / (TURN_CAP - TURN_TOL))) * TURN_WEIGHT;

  /* --- 4. fleet economics (logistics only): the fleet block IS the logistics
     physical block; it saturates at an 85% gap so extreme cases still rank
     against each other instead of all pegging at the cap. */
  const fleetGap = d.fleetImplied ? gapUp(d.declared, d.fleetImplied) : 0;
  const fleetScore = d.fleetImplied ? Math.min(FLEET_WEIGHT, fleetGap * FLEET_WEIGHT / 0.85) : 0;

  /* --- 5. excessive ITC --- */
  const itcExcess = Math.max(0, d.itcRatio - ITC_NORM[1]);
  const itcScore = Math.min(1, itcExcess / (ITC_CAP - ITC_NORM[1])) * ITC_WEIGHT;

  /* --- 6. composite threshold gaming --- */
  const under = (COMPOSITE_LIMIT - d.declared) / COMPOSITE_LIMIT;
  const thresholdFlag = d.regType === 'Composite' && under > 0 && under < COMPOSITE_TOL;
  const thresholdScore = thresholdFlag ? THRESHOLD_WEIGHT : 0;

  /* --- compose: evasion is understatement — only upward gaps score --- */
  const riskScore = Math.round(Math.min(100,
    physScore + purchScore + turnScore + fleetScore + itcScore + thresholdScore));

  /* --- detection typing --- */
  let detectedType = null;
  if (riskScore >= 30) {
    const candidates = [
      { type: 'electricity_mismatch', val: gapElec },
      { type: 'freight_mismatch', val: gapFreight },
      { type: 'employment_mismatch', val: gapEmp },
      { type: 'shell_itc_pattern', val: itcExcess > 0 ? itcExcess : 0 },
      /* threshold gaming is the most specific typology — wins ties */
      { type: 'threshold_manipulation', val: thresholdFlag ? 2 : 0 },
      { type: 'gstr_purchase_no_sale', val: purchaseNoSale },
      { type: 'gstr_turnover_divergence', val: turnoverDivergence },
      { type: 'fleet_revenue_mismatch', val: fleetGap },
    ];
    candidates.sort((a, b) => b.val - a.val);
    if (candidates[0].val > 0) detectedType = candidates[0].type;
  }

  /* --- plain-language reasons (rupee-specific, segment-aware) --- */
  const reasons = [];
  if (segment === 'Manufacturer' && gapElec > ELE_TOL)
    reasons.push(`Electricity consumption implies ~${fmtMoney(d.impliedElec)} of annual production, but declared turnover is ${fmtMoney(d.declared)} — a ${Math.round(gapElec * 100)}% unexplained gap.`);
  if (gapFreight > ELE_TOL)
    reasons.push(`E-way bills show ~${fmtMoney(freightEvidence)} in goods movement against ${fmtMoney(d.declared)} declared — ${Math.round(gapFreight * 100)}% of goods flow is unaccounted for.`);
  if (d.impliedEmp && gapEmp > ELE_TOL && segment === 'Manufacturer')
    reasons.push(`EPF/ESI headcount of ${d.headcount} implies ~${fmtMoney(d.impliedEmp)} revenue capacity, far above declared ${fmtMoney(d.declared)}.`);
  if (d.impliedEmp && gapEmp > ELE_TOL && segment === 'Logistics')
    reasons.push(`Staff strength of ${d.headcount} fits a fleet earning ~${fmtMoney(d.impliedEmp)}, but only ${fmtMoney(d.declared)} is declared.`);
  if (purchaseNoSale > PURCH_TOL)
    reasons.push(`GSTR-2A purchases of ${fmtMoney(d.purchases)} exceed GSTR-1 sales of ${fmtMoney(d.gstr1Sales)} — ITC claimed at input with no matching output invoices (conduit pattern).`);
  if (turnoverDivergence > TURN_TOL)
    reasons.push(`GSTR-1 shows ${fmtMoney(d.gstr1Sales)} of invoiced sales but GSTR-3B returns only ${fmtMoney(d.gstr3bTurnover)} — ${Math.round(turnoverDivergence * 100)}% of invoiced turnover never reached the exchequer. Understated turnover of this kind is the primary evasion signature.`);
  if (d.fleetImplied && fleetGap > 0.5)
    reasons.push(`Fleet activity (${d.ewayCountMonthly} trips/mo × ~${Math.round(d.avgDistance)} km) implies ~${fmtMoney(d.fleetImplied)} freight revenue vs ${fmtMoney(d.declared)} declared.`);
  if (itcScore > 0)
    reasons.push(`Input Tax Credit is ${(d.itcRatio * 100).toFixed(0)}% of declared turnover, far above the ${Math.round(ITC_NORM[0] * 100)}–${Math.round(ITC_NORM[1] * 100)}% norm for this segment.`);
  if (thresholdFlag)
    reasons.push(`Composite-scheme dealer declaring ${fmtMoney(d.declared)} — parked just ${Math.round(under * 100)}% under the ₹1.5 Cr threshold.`);

  /* over-reporters: no evasion points, only a consistency note (fairness) */
  const overDeclared = d.declared > 1.3 * Math.max(d.impliedElec || 0, d.impliedFreight || 0, d.impliedEmp || 0);
  if (overDeclared && reasons.length === 0)
    reasons.push(`Declared turnover exceeds what the physical footprint implies — an over-reporting pattern, recorded for consistency review only. It earns no evasion score.`);

  if (reasons.length === 0) {
    reasons.push(segment === 'Trader'
      ? 'E-way bill movement and GSTR-1/2A/3B triangulation are consistent with declared turnover.'
      : segment === 'Logistics'
        ? 'Fleet activity, freight movement and filings are consistent with declared revenue.'
        : 'Electricity, freight and employment signals are consistent with declared turnover.');
  }

  return {
    ...d,
    /* annualized goods-movement evidence — scored for Manufacturers/Traders via
       e-way value, for Logistics via cargo value over the fleet-implied base */
    impliedFreight: freightEvidence ?? (d.fleetImplied ? d.fleetImplied * cfg.freightRatio : null),
    purchaseFlowRatio, purchaseNoSale, turnoverDivergence,
    riskScore, riskTier: riskTier(riskScore).label, detectedType, reasons,
  };
}

/* ============================== SIMULATED API LAYER ============================== */
const LATENCY = 220;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApi(dealers) {
  return {
    async getDealers({ search = '', district = 'All', sector = 'All', segment = 'All', risk = 'All', page = 1, pageSize = PAGE_SIZE } = {}) {
      await wait(LATENCY);
      let list = dealers;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        list = list.filter((d) => d.businessName.toLowerCase().includes(q) || d.gstin.toLowerCase().includes(q));
      }
      if (district !== 'All') list = list.filter((d) => d.district === district);
      if (sector !== 'All') list = list.filter((d) => d.sector === sector);
      if (segment !== 'All') list = list.filter((d) => d.segment === segment);
      if (risk !== 'All') list = list.filter((d) => riskTier(d.riskScore).label === risk);
      list = [...list].sort((a, b) => b.riskScore - a.riskScore);
      const total = list.length; const start = (page - 1) * pageSize;
      return { results: list.slice(start, start + pageSize), total, page, pageSize };
    },
    async getDealer(gstin) { await wait(LATENCY); return dealers.find((d) => d.gstin === gstin) || null; },
    async getDistrictSummary() {
      await wait(LATENCY);
      const map = {};
      dealers.forEach((d) => {
        if (!map[d.district]) map[d.district] = { count: 0, sum: 0, high: 0, med: 0, low: 0 };
        const m = map[d.district]; m.count++; m.sum += d.riskScore;
        const t = riskTier(d.riskScore).label;
        if (t === 'High Risk') m.high++; else if (t === 'Medium Risk') m.med++; else m.low++;
      });
      return Object.entries(map).map(([district, m]) => ({ district, count: m.count, avg: Math.round(m.sum / m.count), high: m.high, med: m.med, low: m.low })).sort((a, b) => b.avg - a.avg);
    },
    async getSectorSummary() {
      await wait(LATENCY);
      const map = {};
      dealers.forEach((d) => {
        if (!map[d.sector]) map[d.sector] = { count: 0, sum: 0, high: 0 };
        const m = map[d.sector]; m.count++; m.sum += d.riskScore;
        if (riskTier(d.riskScore).label === 'High Risk') m.high++;
      });
      return Object.entries(map).map(([sector, m]) => ({ sector, count: m.count, avg: Math.round(m.sum / m.count), high: m.high })).sort((a, b) => b.avg - a.avg);
    },
    async getAnomalyBreakdown() {
      await wait(LATENCY);
      const counts = {}; ANOMALY_ORDER.forEach((t) => (counts[t] = 0));
      dealers.forEach((d) => { if (d.detectedType) counts[d.detectedType]++; });
      return counts;
    },
    async getSummaryStats() {
      await wait(LATENCY);
      const total = dealers.length;
      const high = dealers.filter((d) => riskTier(d.riskScore).label === 'High Risk').length;
      const med = dealers.filter((d) => riskTier(d.riskScore).label === 'Medium Risk').length;
      const low = total - high - med;
      const avgRisk = total ? Math.round(dealers.reduce((s, d) => s + d.riskScore, 0) / total) : 0;
      /* estimated annual tax at risk: corroborated revenue gap × GST rate on
         flagged dealers. For Logistics the revenue evidence is the fleet base
         (impliedFreight is CARGO value there — 3.2× revenue — and would
         overstate the gap, so it is excluded). */
      const estGap = dealers.reduce((s, d) => {
        if (d.riskScore < 30) return s;
        const implied = d.segment === 'Logistics'
          ? Math.max(d.fleetImplied || 0, d.impliedEmp || 0)
          : Math.max(d.impliedElec || 0, d.impliedFreight || 0, d.impliedEmp || 0, d.gstr1Sales || 0);
        return s + Math.max(0, implied - d.declared);
      }, 0);
      return { total, high, med, low, avgRisk, estTaxAtRisk: estGap * TAX_RATE };
    },
  };
}

/* ============================== STORAGE ============================== */
/* Officer flags persist via the host bridge (window.storage) when available,
   falling back to localStorage in plain browsers — previously the silent
   catch left the audit trail dead in any browser deployment. */
async function storageGet(key) {
  try { if (typeof window !== 'undefined' && window.storage) { const res = await window.storage.get(key); if (res && res.value != null) return res.value; } } catch (e) { /* host bridge unavailable */ }
  try { if (typeof localStorage !== 'undefined') return localStorage.getItem(key); } catch (e) { /* storage blocked */ }
  return null;
}
async function storageSet(key, value) {
  try { if (typeof window !== 'undefined' && window.storage) { await window.storage.set(key, value); return; } } catch (e) { /* fall through */ }
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch (e) { console.error('flag persistence failed', e); }
}
export async function loadFlagIndex() { try { const raw = await storageGet('flagIndex'); if (raw) return JSON.parse(raw); } catch (e) { /* corrupt payload -> start empty */ } return []; }
export async function saveFlagIndex(arr) { try { await storageSet('flagIndex', JSON.stringify(arr)); } catch (e) { console.error('save failed', e); } }
