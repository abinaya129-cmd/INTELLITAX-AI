/* verify_v29.mjs — headless assertions for the pan-India engine. */
import { genDealers, createApi, STATES, DISTRICTS, districtsOfState, INDIA_STATES } from './src/data/gstDataEngine.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS', msg); }
  else { fail++; console.log('  FAIL', msg); }
}

console.log('--- constants ---');
ok(STATES.length === 32, `32 states/UTs modelled (got ${STATES.length})`);
ok(INDIA_STATES.every(s => s.code && s.factor > 0 && s.districts.length > 0), 'every state has code/factor/districts');
ok(DISTRICTS.length >= 90, `districts expanded (${DISTRICTS.length})`);
ok(districtsOfState('All').length === DISTRICTS.length, 'districtsOfState(All) = all');
ok(districtsOfState('Tamil Nadu').includes('Chennai') && districtsOfState('Tamil Nadu').length === 16, 'TN still has its 16 districts');
ok(JSON.stringify(districtsOfState('Bihar')) === JSON.stringify(['Bhagalpur', 'Muzaffarpur', 'Patna']), 'Bihar districts sorted correctly');

console.log('--- generation ---');
const t0 = Date.now();
const dealers = genDealers();
console.log('  gen time ms:', Date.now() - t0);
ok(dealers.length === 15000, `15,000 dealers generated (${dealers.length})`);

const stateCounts = {};
dealers.forEach(d => { stateCounts[d.state] = (stateCounts[d.state] || 0) + 1; });
const nStatesCovered = Object.keys(stateCounts).length;
ok(nStatesCovered === 32, `all 32 states/UTs have dealers (got ${nStatesCovered})`);
ok(dealers.every(d => d.gstin.slice(0, 2) === d.stateCode), 'GSTIN prefix matches dealer state code');
const codesSeen = new Set(dealers.map(d => d.stateCode));
ok(codesSeen.size === 32, `all 32 GSTIN state codes appear (${codesSeen.size})`);
ok(dealers.every(d => d.state && d.district), 'every dealer has state + district');

/* district belongs to state */
const validPairs = new Set(INDIA_STATES.flatMap(s => s.districts.map(d => `${s.name}|${d[0]}`)));
ok(dealers.every(d => validPairs.has(`${d.state}|${d.district}`)), 'every (state,district) pair is valid');

/* per-state sanity: every state has dealers, none 100% flagged; tiny UTs may
   legitimately round to 0 flagged — only large states must have some. */
let sane = true;
for (const st of INDIA_STATES) {
  const rows = dealers.filter(d => d.state === st.name);
  const flagged = rows.filter(d => d.riskScore >= 30).length;
  if (rows.length === 0 || flagged === rows.length) sane = false;
  if (rows.length >= 100 && flagged === 0) sane = false;
}
ok(sane, 'all states populated; large states have flagged rows; none 100% flagged');

/* calibration fairness: compliant manufacturers in low-factor states not mass-flagged */
const lowFactor = ['Bihar', 'Uttar Pradesh', 'Madhya Pradesh'];
const lowCompliantMfg = dealers.filter(d => lowFactor.includes(d.state) && d.segment === 'Manufacturer' && !d.plantedType);
const lowFlagged = lowCompliantMfg.filter(d => d.riskScore >= 30).length;
console.log(`  low-factor compliant manufacturers: ${lowCompliantMfg.length}, flagged: ${lowFlagged}`);
ok(lowFlagged === 0, 'zero false positives among low-factor compliant manufacturers');

const compliant = dealers.filter(d => !d.plantedType);
ok(compliant.every(d => d.riskScore < 30), 'zero false positives among ALL compliant dealers');

const planted = dealers.filter(d => d.plantedType);
const caught = planted.filter(d => d.riskScore >= 30);
/* v28 ground truth (proven bit-for-bit identical in the direct A/B run):
   recall 96.9%, typology agreement 1130/1500 — detection typing picks the
   top-gap candidate, so multi-typology seeds may surface another label. */
ok((100 * caught.length / planted.length) >= 96.8, `recall at v28 level: ${(100 * caught.length / planted.length).toFixed(1)}%`);
const agree = planted.filter(d => d.detectedType === d.plantedType).length;
ok(agree >= 1125, `typology agreement at v28 level: ${agree}/${planted.length}`);

console.log('--- API layer ---');
const api = createApi(dealers);
const r1 = await api.getDealers({ state: 'Bihar' });
ok(r1.results.length > 0 && r1.results.every(d => d.state === 'Bihar'), `state filter works (Bihar: ${r1.total})`);
const r2 = await api.getDealers({ state: 'Bihar', district: 'Patna' });
ok(r2.results.length > 0 && r2.results.every(d => d.district === 'Patna'), 'cascading district filter works');
const r3 = await api.getDealers({ state: 'Bihar', district: 'Chennai' });
ok(r3.total === 0, 'cross-state district returns empty (no impossible matches)');
const r4 = await api.getDealers({ district: 'Chennai' });
ok(r4.results.every(d => d.district === 'Chennai'), 'district-only filter still works');
const r5 = await api.getDealers({ state: 'Tamil Nadu' });
ok(r5.total > 0, `TN dealers present (${r5.total})`);

const ds = await api.getDistrictSummary();
ok(ds.every(x => x.state), 'district summary carries state labels');
ok(ds.some(x => x.state === 'Maharashtra'), 'Maharashtra districts in summary');
const dsum = ds.find(x => x.district === 'Chennai');
ok(dsum && dsum.state === 'Tamil Nadu', 'Chennai maps to Tamil Nadu in summary');

console.log('--- scoring spot checks ---');
const elecSeed = planted.find(d => d.plantedType === 'electricity_mismatch');
ok(!!elecSeed && elecSeed.riskScore >= 30, `electricity seeds caught (${elecSeed && elecSeed.riskScore})`);
const stockSeed = planted.find(d => d.plantedType === 'stock_reconciliation');
ok(!!stockSeed && stockSeed.riskScore >= 30, `stock checkpoint seed caught (${stockSeed && stockSeed.riskScore})`);
/* direct kernel test: the ₹20 L / ₹15 L / ₹7 L spec case must PASS in ANY state */
import { scoreDealer } from './src/data/gstDataEngine.js';
for (const st of ['Maharashtra', 'Tamil Nadu', 'Bihar']) {
  const spec = scoreDealer({
    gstin: 'TEST0000000F1Z5', businessName: 'Spec Trader',
    state: st, stateCode: st === 'Maharashtra' ? '27' : st === 'Tamil Nadu' ? '33' : '10',
    district: 'X', sector: 'FMCG Trading', segment: 'Trader', regType: 'Regular',
    declared: 1500000, taxPaid: 90000, itcClaimed: 300000, itcRatio: 0.20,
    gstr1Sales: 1500000, gstr3bTurnover: 1500000, purchases: 2000000,
    filingStatus: 'Filed on time', monthlyUnits: 1200, connectionType: 'LT',
    sanctionedLoad: 5, ewayCountMonthly: 0, ewayValueMonthly: null, avgDistance: null,
    bookStock: 700000, headcount: 4, wageBill: 900000,
    impliedElec: null, impliedEmp: null, fleetImplied: null, plantedType: null,
  });
  ok(spec.riskScore < 30, `${st}: buy 20L/sell 15L/stock 7L PASSES (score ${spec.riskScore})`);
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
