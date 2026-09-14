import React, { useState, useEffect, useMemo } from 'react';
import {
  Search, Zap, Truck, Users, Flag, UserPlus, CheckCircle2, ArrowLeft,
  ShieldAlert, Activity, TrendingUp, LayoutGrid, List, BarChart2,
  ChevronLeft, ChevronRight, Clock, ArrowRight, Home,
  FileText, Package, IndianRupee
} from 'lucide-react';
import {
  C, DISTRICTS, SECTOR_KEYS, SEGMENTS,
  ANOMALY_LABELS, ANOMALY_ORDER, ANOMALY_COLORS,
  PAGE_SIZE, genDealers, createApi, loadFlagIndex, saveFlagIndex, riskTier, fmtCr, fmtMoney,
} from './data/gstDataEngine.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================== SMALL UI PIECES ============================== */
function RiskBadge({ score, size = 'md' }) {
  const t = riskTier(score); const big = size === 'lg';
  return <div style={{ background: t.color, color: '#fff', fontFamily: 'monospace', fontWeight: 700, borderRadius: big ? 12 : 8, padding: big ? '10px 16px' : '4px 9px', fontSize: big ? 22 : 13, display: 'inline-flex', alignItems: 'center', lineHeight: 1 }}>{score}</div>;
}
function TierPill({ score }) {
  const t = riskTier(score);
  return <span style={{ color: t.color, background: `${t.color}22`, border: `1px solid ${t.color}55`, borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>{t.label}</span>;
}
function Bar({ label, value, max, color, sub }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontFamily: 'monospace', color: C.textFaint, marginBottom: 5 }}><span>{label}</span><span style={{ color: C.text }}>{sub}</span></div>
      <div style={{ height: 9, background: C.paperLine, borderRadius: 99, overflow: 'hidden' }}><div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 99, transition: 'width .6s ease' }} /></div>
    </div>
  );
}
function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 12, padding: '18px 20px', display: 'flex', gap: 14, alignItems: 'center', flex: 1, minWidth: 180 }}>
      <div style={{ width: 40, height: 40, borderRadius: 9, background: `${accent}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon size={19} color={accent} /></div>
      <div><div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'monospace', color: C.text }}>{value}</div><div style={{ fontSize: 12, color: C.textFaint, marginTop: 2 }}>{label}</div></div>
    </div>
  );
}
function DonutChart({ data }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  let acc = 0;
  const stops = data.map((d) => { const start = (acc / total) * 360; acc += d.value; const end = (acc / total) * 360; return `${d.color} ${start}deg ${end}deg`; });
  return (
    <div style={{ position: 'relative', width: 140, height: 140, flexShrink: 0 }}>
      <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: `conic-gradient(${stops.join(', ')})` }} />
      <div style={{ position: 'absolute', inset: 22, background: C.panel, borderRadius: '50%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'monospace' }}>{total}</div><div style={{ fontSize: 9.5, color: C.textFaint }}>total flags</div>
      </div>
    </div>
  );
}
function GlobalStyles() {
  return <style>{`
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes flowThread{to{stroke-dashoffset:-30}}
    @keyframes pulseRing{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:.15;transform:scale(1.35)}}
    @keyframes glowNum{0%,100%{opacity:1}50%{opacity:.75}}
    * { box-sizing: border-box; }
  `}</style>;
}
function LoadingSkeleton() {
  return (
    <div style={{ minHeight: '100vh', background: C.ink, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <GlobalStyles />
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 40, height: 40, border: `3px solid ${C.panelLine}`, borderTopColor: C.sealBright, borderRadius: '50%', margin: '0 auto 18px', animation: 'spin 0.8s linear infinite' }} />
        <div style={{ color: C.textFaint, fontSize: 13, fontFamily: 'monospace' }}>Generating 15,000 dealer records…</div>
      </div>
    </div>
  );
}

/* Segment-aware evidence copy used on the landing "signals" section. */
const SIGNAL_CARDS = [
  { icon: Zap, color: C.elec, title: 'Electricity load', seg: 'Manufacturers', copy: "Monthly units consumed reveal true production scale — a factory running industrial machinery all month can't credibly declare retail-scale turnover.", tag: 'TANGEDCO-style feed' },
  { icon: Package, color: C.freight, title: 'Stock reconciliation', seg: 'Traders', copy: 'The checkpoint: GSTR-2A purchases minus GSTR-3B sales must equal the stock on the books. Buy ₹20 L, sell ₹15 L — the ₹5 L balance must sit on the shelf. Books that fall short hide off-book sales; books that balloon hold paper stock propping up ITC.', tag: '2A − 3B = stock' },
  { icon: FileText, color: C.gstp, title: 'GSTR-1 × 2A × 3B', seg: 'Traders', copy: 'Return triangulation without any physical feed: purchases visible in GSTR-2A must resurface as GSTR-1 sales. Purchases with no sales expose conduit firms; invoiced sales missing from the 3B cash return expose understated turnover.', tag: 'GSTN return triangulation' },
  { icon: Users, color: C.emp, title: 'Employment footprint', seg: 'Manufacturers & Logistics', copy: 'EPF/ESI headcount implies a minimum output for factories and fleet size for transporters — deliberately low-weighted so genuine employers are never flagged on headcount alone.', tag: 'EPF/ESI-style feed' },
  { icon: Package, color: C.freight, title: 'Fleet economics', seg: 'Logistics', copy: 'Trips × distance × realisation per km put a floor under a fleet operator\u2019s revenue. A fleet running full routes on a fraction of that revenue is under-declaring.', tag: 'E-way + fleet feed' },
  { icon: IndianRupee, color: C.high, title: 'Turnover asymmetry', seg: 'All segments', copy: 'Understating turnover is the primary evasion signature, so only upward gaps score. Over-reporters earn no points — the engine hunts the main culprits, not paperwork noise.', tag: 'Fair-scoring rule' },
];

/* ============================== LANDING SCREEN ============================== */
function Landing({ featuredDealer, totalDealers, onEnter }) {
  const [hover, setHover] = useState(null);
  return (
    <div style={{ background: C.ink, color: C.text, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", minHeight: '100vh' }}>
      <GlobalStyles />
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'rgba(10,15,28,0.85)', backdropFilter: 'blur(8px)', borderBottom: `1px solid ${C.panelLine}` }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 24px', height: 68, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div style={{ width: 32, height: 32, borderRadius: 7, background: `linear-gradient(155deg, ${C.sealBright}, ${C.seal})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ShieldAlert size={16} color="#160F02" /></div>
            <div><div style={{ fontSize: 14, fontWeight: 600 }}>GST Anomaly Detection</div><div style={{ fontSize: 10.5, color: C.textFaint }}>Tamil Nadu Commercial Tax · Hackathon 2026</div></div>
          </div>
          <button onClick={onEnter} style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.seal, color: '#160F02', border: 'none', borderRadius: 7, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            View live demo <ArrowRight size={13} />
          </button>
        </div>
      </div>

      <div style={{ padding: '96px 24px 80px', background: `radial-gradient(ellipse 900px 500px at 78% 10%, rgba(176,138,46,0.10), transparent 60%), radial-gradient(ellipse 700px 500px at 10% 90%, rgba(79,166,216,0.07), transparent 60%), ${C.ink}`, borderBottom: `1px solid ${C.panelLine}` }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gridTemplateColumns: '1.05fr 0.95fr', gap: 56, alignItems: 'center' }} className="hero-grid">
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontFamily: 'monospace', fontSize: 11.5, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.sealBright, border: `1px solid ${C.seal}55`, padding: '7px 13px', borderRadius: 99, marginBottom: 26, background: `${C.seal}10` }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.sealBright }} />Sector-conditioned compliance intelligence
            </div>
            <h1 style={{ fontSize: 'clamp(38px, 5vw, 60px)', fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.01em', color: '#FBFAF6', marginBottom: 24 }}>
              The right evidence.<br /><span style={{ color: C.sealBright }}>For the right trade.</span>
            </h1>
            <p style={{ fontSize: 16.5, lineHeight: 1.65, color: C.textSoft, maxWidth: 480, marginBottom: 34 }}>
              A factory's power draw, a trader's purchase ledger and a fleet's trip trail each tell a different truth. We score every dealer with the evidence that fits its business model — and show the gap in rupees, in plain language, live.
            </p>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <button onClick={onEnter} style={{ display: 'flex', alignItems: 'center', gap: 9, background: C.seal, color: '#160F02', padding: '14px 24px', borderRadius: 7, fontSize: 14.5, fontWeight: 600, border: 'none', cursor: 'pointer' }}>
                Enter live dashboard <ArrowRight size={15} />
              </button>
              <a href="#signals" style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'transparent', color: C.text, padding: '14px 22px', borderRadius: 7, fontSize: 14.5, fontWeight: 500, border: `1px solid ${C.panelLine}`, textDecoration: 'none' }}>
                See the detection logic
              </a>
            </div>
          </div>
          <div style={{ width: '100%', aspectRatio: '1/0.92' }}>
            <svg viewBox="0 0 460 420" fill="none" style={{ width: '100%', height: '100%' }}>
              <circle cx="46" cy="72" r="22" fill={`${C.elec}20`} stroke={C.elec} strokeWidth="1.5" />
              <circle cx="46" cy="210" r="22" fill={`${C.freight}20`} stroke={C.freight} strokeWidth="1.5" />
              <circle cx="46" cy="348" r="22" fill={`${C.gstp}20`} stroke={C.gstp} strokeWidth="1.5" />
              <path d="M50 60 L38 76 L46 76 L42 90 L58 70 L48 70 Z" fill={C.elec} transform="translate(-2,4) scale(0.85)" />
              <rect x="30" y="200" width="30" height="18" rx="3" fill="none" stroke={C.freight} strokeWidth="2" />
              <rect x="56" y="204" width="10" height="14" rx="2" fill="none" stroke={C.freight} strokeWidth="2" />
              <circle cx="37" cy="220" r="3" fill={C.freight} /><circle cx="58" cy="220" r="3" fill={C.freight} />
              <rect x="32" y="339" width="28" height="18" rx="3" fill="none" stroke={C.gstp} strokeWidth="2" />
              <path d="M36 344 h20 M36 350 h20 M36 356 h13" stroke={C.gstp} strokeWidth="1.6" strokeLinecap="round" />
              <path d="M68 72 C 180 72, 220 130, 296 190" fill="none" stroke={C.elec} strokeWidth="2.5" strokeLinecap="round" style={{ strokeDasharray: '8 7', animation: 'flowThread 1.1s linear infinite' }} />
              <path d="M68 210 C 180 210, 240 210, 296 210" fill="none" stroke={C.freight} strokeWidth="2.5" strokeLinecap="round" style={{ strokeDasharray: '8 7', animation: 'flowThread 1.1s linear infinite' }} />
              <path d="M68 348 C 180 348, 220 280, 296 226" fill="none" stroke={C.gstp} strokeWidth="2.5" strokeLinecap="round" style={{ strokeDasharray: '8 7', animation: 'flowThread 1.1s linear infinite' }} />
              <rect x="296" y="140" width="140" height="150" rx="10" fill={C.paper} />
              <rect x="316" y="164" width="70" height="7" rx="3" fill="#B5A98A" />
              <rect x="316" y="180" width="100" height="5" rx="2.5" fill={C.paperLine} />
              <rect x="316" y="192" width="85" height="5" rx="2.5" fill={C.paperLine} />
              <rect x="316" y="212" width="100" height="6" rx="3" fill="#8B8168" />
              <rect x="316" y="228" width="55" height="6" rx="3" fill={C.elec} />
              <rect x="316" y="242" width="80" height="6" rx="3" fill={C.freight} />
              <rect x="316" y="256" width="40" height="6" rx="3" fill={C.gstp} />
              <circle cx="405" cy="270" r="24" fill="none" stroke={C.high} strokeWidth="2" style={{ animation: 'pulseRing 2.4s ease-in-out infinite', transformOrigin: 'center' }} />
              <circle cx="405" cy="270" r="19" fill={C.high} />
              <text x="405" y="275" textAnchor="middle" fontFamily="monospace" fontSize="15" fontWeight="700" fill="#FBEFEC" style={{ animation: 'glowNum 2.4s ease-in-out infinite' }}>{featuredDealer ? featuredDealer.riskScore : 83}</text>
              <text x="296" y="128" fontFamily="monospace" fontSize="10.5" letterSpacing="1" fill={C.textFaint}>GSTR-3B RECORD</text>
            </svg>
          </div>
        </div>
      </div>

      <div style={{ background: C.ink2, borderBottom: `1px solid ${C.panelLine}`, padding: '44px 24px' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gridTemplateColumns: '1.3fr 1px 1fr 1px 1fr', gap: 32, alignItems: 'center' }} className="stat-grid">
          <div style={{ fontSize: 14.5, lineHeight: 1.6, color: C.textSoft, maxWidth: 400 }}>
            Nationally, GST intelligence officers detected <b style={{ color: C.text }}>over ₹2 lakh crore</b> in evasion in a single recent fiscal year — most of it found manually, case by case, well after the fact.
          </div>
          <div style={{ width: 1, height: 52, background: C.panelLine, justifySelf: 'center' }} />
          <div>
            <div style={{ fontFamily: "'Georgia', serif", fontSize: 32, fontWeight: 700, color: C.sealBright }}>15L+</div>
            <div style={{ fontSize: 12, color: C.textFaint, marginTop: 6, maxWidth: 200 }}>registered dealers in Tamil Nadu — the real-world target scale</div>
          </div>
          <div style={{ width: 1, height: 52, background: C.panelLine, justifySelf: 'center' }} />
          <div>
            <div style={{ fontFamily: "'Georgia', serif", fontSize: 32, fontWeight: 700, color: C.sealBright }}>{totalDealers.toLocaleString('en-IN')}</div>
            <div style={{ fontSize: 12, color: C.textFaint, marginTop: 6, maxWidth: 200 }}>dealers actually loaded and scored live in this demo</div>
          </div>
        </div>
      </div>

      <div id="signals" style={{ padding: '90px 24px' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div style={{ fontFamily: 'monospace', fontSize: 11.5, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 14 }}>HOW THE GAP IS FOUND — PER BUSINESS MODEL</div>
          <h2 style={{ fontSize: 'clamp(26px,3.2vw,36px)', fontWeight: 700, color: '#FBFAF6', maxWidth: 640, marginBottom: 12 }}>Evidence only counts when the business model makes it count.</h2>
          <p style={{ fontSize: 14, color: C.textSoft, maxWidth: 640, marginBottom: 40, lineHeight: 1.6 }}>
            A universal formula flags the wrong things in the wrong trades. INTELLITAX-AI conditions every signal on the dealer's segment: <b style={{ color: C.text }}>Manufacturers</b> are judged on production footprint (electricity + employee count), <b style={{ color: C.text }}>Traders</b> on the GSTR-2A − 3B stock-reconciliation checkpoint, and <b style={{ color: C.text }}>Logistics</b> on fleet economics.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 20 }} className="signal-grid">
            {SIGNAL_CARDS.map((s, i) => (
              <div key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 12, padding: '28px 24px', position: 'relative', overflow: 'hidden', transform: hover === i ? 'translateY(-3px)' : 'none', transition: 'transform .2s ease', boxShadow: hover === i ? '0 12px 30px -12px rgba(0,0,0,0.4)' : 'none' }}>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: s.color }} />
                <div style={{ width: 40, height: 40, borderRadius: 9, background: `${s.color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}><s.icon size={19} color={s.color} /></div>
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 9 }}>{s.title}</h3>
                <p style={{ fontSize: 13.3, lineHeight: 1.6, color: C.textSoft }}>{s.copy}</p>
                <span style={{ display: 'inline-block', marginTop: 14, fontFamily: 'monospace', fontSize: 10.5, color: C.textFaint, border: `1px solid ${C.panelLine}`, padding: '4px 9px', borderRadius: 5 }}>{s.seg} · {s.tag}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {featuredDealer && (
        <div style={{ background: C.ink2, borderTop: `1px solid ${C.panelLine}`, borderBottom: `1px solid ${C.panelLine}`, padding: '90px 24px' }}>
          <div style={{ maxWidth: 1180, margin: '0 auto' }}>
            <div style={{ fontFamily: 'monospace', fontSize: 11.5, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 14 }}>EXPLAINABLE, NOT A BLACK BOX — LIVE EXAMPLE</div>
            <h2 style={{ fontSize: 'clamp(26px,3.2vw,36px)', fontWeight: 700, color: '#FBFAF6', maxWidth: 600, marginBottom: 8 }}>Every score comes with its reasons, in rupees.</h2>
            <p style={{ fontSize: 13.5, color: C.textFaint, marginBottom: 40 }}>This is the actual highest-risk dealer from the live dataset below — not a mockup.</p>
            <div style={{ display: 'grid', gridTemplateColumns: '0.85fr 1.15fr', gap: 50, alignItems: 'center' }} className="gap-grid">
              <div style={{ background: C.paper, borderRadius: 14, padding: '28px 26px', color: C.inkOnPaper, boxShadow: '0 20px 60px -20px rgba(0,0,0,0.5)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, borderBottom: `1px solid ${C.paperLine}`, paddingBottom: 16 }}>
                  <div><div style={{ fontFamily: "'Georgia', serif", fontWeight: 700, fontSize: 16 }}>{featuredDealer.businessName}</div><div style={{ fontFamily: 'monospace', fontSize: 11, color: '#6B6250', marginTop: 4 }}>{featuredDealer.gstin} · {featuredDealer.district}</div></div>
                  <div style={{ background: C.high, color: '#FBEFEC', fontFamily: 'monospace', fontSize: 12, fontWeight: 700, padding: '6px 12px', borderRadius: 99 }}>RISK {featuredDealer.riskScore}</div>
                </div>
                {[
                  { label: 'Declared turnover', v: featuredDealer.declared, color: '#8B8168' },
                  { label: 'Implied by electricity', v: featuredDealer.impliedElec, color: C.elec },
                  { label: 'Stock on the books', v: featuredDealer.bookStock, color: C.freight },
                  { label: 'Implied by employment', v: featuredDealer.impliedEmp, color: C.emp },
                  { label: 'GSTR-1 invoiced sales', v: featuredDealer.gstr1Sales, color: C.gstp },
                ].map((row) => {
                  const vals = [featuredDealer.declared, featuredDealer.impliedElec, featuredDealer.bookStock, featuredDealer.impliedEmp, featuredDealer.gstr1Sales].filter((v) => v != null);
                  const maxV = Math.max(...vals);
                  if (row.v == null) return null;
                  return (
                    <div key={row.label} style={{ marginBottom: 13 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5, fontFamily: 'monospace', color: '#544B3B' }}><span>{row.label}</span><span>{fmtCr(row.v)}</span></div>
                      <div style={{ height: 8, background: '#E5DEC9', borderRadius: 99 }}><div style={{ height: '100%', width: `${(row.v / maxV) * 100}%`, background: row.color, borderRadius: 99 }} /></div>
                    </div>
                  );
                })}
              </div>
              <div>
                <p style={{ fontSize: 14.5, color: C.textSoft, lineHeight: 1.6, marginBottom: 22 }}>The dealer-profile screen doesn't just output a number — it tells the officer exactly why, from the same figures shown here.</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
                  {featuredDealer.reasons.map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 13, alignItems: 'flex-start' }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: C.high, marginTop: 8, flexShrink: 0 }} />
                      <p style={{ fontSize: 14, lineHeight: 1.6, color: C.textSoft }}>{r}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: '90px 24px' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div style={{ fontFamily: 'monospace', fontSize: 11.5, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 14 }}>BUILT FOR THE OFFICER, NOT JUST THE MODEL</div>
          <h2 style={{ fontSize: 'clamp(26px,3.2vw,36px)', fontWeight: 700, color: '#FBFAF6', maxWidth: 600, marginBottom: 40 }}>Detect, explain, act — in one screen.</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 30 }} className="flow-grid">
            {[
              { n: '01 — DETECT', t: 'Score every filing', c: 'Each return is scored the moment data refreshes — visible district-wide on the command center heatmap.' },
              { n: '02 — EXPLAIN', t: 'Show the reasoning', c: 'The dealer profile lays out the exact rupee gap behind the score — no black box to trust.' },
              { n: '03 — ACT', t: 'Flag or clear', c: 'Officers flag for investigation, assign, or clear as false positive — every action kept in an audit trail.' },
            ].map((f, i) => (
              <div key={i}><div style={{ fontFamily: "'Georgia', serif", fontSize: 12.5, color: C.sealBright, letterSpacing: '0.08em', marginBottom: 14 }}>{f.n}</div><h3 style={{ fontSize: 16.5, fontWeight: 600, marginBottom: 9 }}>{f.t}</h3><p style={{ fontSize: 13.5, lineHeight: 1.6, color: C.textSoft }}>{f.c}</p></div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ background: `linear-gradient(155deg, #16233D, ${C.ink} 60%)`, borderTop: `1px solid ${C.panelLine}`, textAlign: 'center', padding: '100px 24px' }}>
        <h2 style={{ fontFamily: "'Georgia', serif", fontSize: 'clamp(28px,3.6vw,42px)', fontWeight: 700, color: '#FBFAF6', marginBottom: 18 }}>See the gap for yourself.</h2>
        <p style={{ fontSize: 15.5, color: C.textSoft, maxWidth: 460, margin: '0 auto 32px', lineHeight: 1.6 }}>{totalDealers.toLocaleString('en-IN')} live-scored dealers across three business segments — click through and try flagging one.</p>
        <button onClick={onEnter} style={{ display: 'inline-flex', alignItems: 'center', gap: 9, background: C.seal, color: '#160F02', padding: '14px 26px', borderRadius: 7, fontSize: 14.5, fontWeight: 600, border: 'none', cursor: 'pointer' }}>
          Enter live dashboard <ArrowRight size={15} />
        </button>
      </div>

      <div style={{ borderTop: `1px solid ${C.panelLine}`, padding: '30px 24px', textAlign: 'center', fontSize: 12, color: C.textFaint, fontFamily: 'monospace' }}>
        GST Anomaly Detection — Hackathon 2026 Prototype
      </div>

      <style>{`
        @media (max-width: 880px) {
          .hero-grid { grid-template-columns: 1fr !important; }
          .stat-grid { grid-template-columns: 1fr !important; }
          .stat-grid > div[style*="width: 1px"] { display: none !important; }
          .signal-grid { grid-template-columns: 1fr !important; }
          .gap-grid { grid-template-columns: 1fr !important; }
          .flow-grid { grid-template-columns: 1fr !important; gap: 36px !important; }
        }
      `}</style>
    </div>
  );
}

/* ============================== MAIN APP ============================== */
export default function GSTAnomalySystem() {
  const [loading, setLoading] = useState(true);
  const [dealers, setDealers] = useState([]);
  const [api, setApi] = useState(null);
  const [screen, setScreen] = useState('landing');
  const [fade, setFade] = useState(true);
  const [view, setView] = useState('command');

  const [summary, setSummary] = useState(null);
  const [districtStats, setDistrictStats] = useState([]);
  const [sectorStats, setSectorStats] = useState([]);
  const [anomalyBreakdown, setAnomalyBreakdown] = useState({});

  const [search, setSearch] = useState('');
  const [filterDistrict, setFilterDistrict] = useState('All');
  const [filterSector, setFilterSector] = useState('All');
  const [filterSegment, setFilterSegment] = useState('All');
  const [filterRisk, setFilterRisk] = useState('All');
  const [page, setPage] = useState(1);
  const [dealerResult, setDealerResult] = useState({ results: [], total: 0 });
  const [listLoading, setListLoading] = useState(false);

  const [selectedGstin, setSelectedGstin] = useState(null);
  const [selectedDealer, setSelectedDealer] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);

  const [flags, setFlags] = useState({});
  const [actionNote, setActionNote] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      const d = genDealers();
      setDealers(d); setApi(createApi(d));
      const idx = await loadFlagIndex();
      const map = {}; idx.forEach((f) => { map[f.gstin] = f; });
      setFlags(map); setLoading(false);
    }, 500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!api) return;
    api.getSummaryStats().then(setSummary);
    api.getDistrictSummary().then(setDistrictStats);
    api.getSectorSummary().then(setSectorStats);
    api.getAnomalyBreakdown().then(setAnomalyBreakdown);
  }, [api]);

  useEffect(() => {
    if (!api || screen !== 'app' || view !== 'dealers') return;
    setListLoading(true);
    api.getDealers({ search, district: filterDistrict, sector: filterSector, segment: filterSegment, risk: filterRisk, page }).then((res) => { setDealerResult(res); setListLoading(false); });
  }, [api, screen, view, search, filterDistrict, filterSector, filterSegment, filterRisk, page]);

  useEffect(() => {
    if (!api || !selectedGstin) return;
    setProfileLoading(true);
    api.getDealer(selectedGstin).then((d) => { setSelectedDealer(d); setProfileLoading(false); });
  }, [api, selectedGstin]);

  const featuredDealer = useMemo(() => (dealers.length ? [...dealers].sort((a, b) => b.riskScore - a.riskScore)[0] : null), [dealers]);

  const goToApp = () => { setFade(false); setTimeout(() => { setScreen('app'); setView('command'); setFade(true); }, 300); };
  const goToLanding = () => { setFade(false); setTimeout(() => { setScreen('landing'); setFade(true); }, 300); };
  const openDealer = (gstin) => { setSelectedGstin(gstin); setView('profile'); };

  const runAction = async (action) => {
    if (!selectedDealer) return;
    setActionLoading(true); await wait(500);
    const now = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    const gstin = selectedDealer.gstin;
    setFlags((prev) => {
      const existing = prev[gstin] || { gstin, status: 'none', history: [] };
      const entry = { action, note: actionNote.trim() || '(no note)', at: now };
      let status = existing.status;
      if (action === 'flag_for_investigation') status = 'flagged';
      if (action === 'assign_officer') status = 'assigned';
      if (action === 'clear') status = 'cleared';
      const updated = { ...existing, status, history: [entry, ...existing.history] };
      const next = { ...prev, [gstin]: updated };
      saveFlagIndex(Object.values(next));
      return next;
    });
    setActionNote(''); setActionLoading(false);
  };

  if (loading) return <LoadingSkeleton />;

  if (screen === 'landing') {
    return <div style={{ opacity: fade ? 1 : 0, transition: 'opacity 300ms ease' }}><Landing featuredDealer={featuredDealer} totalDealers={dealers.length} onEnter={goToApp} /></div>;
  }

  const flaggedCount = Object.values(flags).filter((f) => f.status === 'flagged' || f.status === 'assigned').length;

  return (
    <div style={{ opacity: fade ? 1 : 0, transition: 'opacity 300ms ease', minHeight: '100vh', background: C.ink, color: C.text, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      <GlobalStyles />
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'rgba(10,15,28,0.92)', backdropFilter: 'blur(8px)', borderBottom: `1px solid ${C.panelLine}` }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 24px', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <button onClick={goToLanding} style={{ display: 'flex', alignItems: 'center', gap: 11, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
            <div style={{ width: 32, height: 32, borderRadius: 7, background: `linear-gradient(155deg, ${C.sealBright}, ${C.seal})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ShieldAlert size={16} color="#160F02" /></div>
            <div><div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>GST Anomaly Detection</div><div style={{ fontSize: 10.5, color: C.textFaint }}>Tamil Nadu Commercial Tax Department</div></div>
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={goToLanding} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 500, padding: '8px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', background: 'transparent', color: C.textSoft }}><Home size={14} /> Overview</button>
            {[{ key: 'command', label: 'Command Center', icon: LayoutGrid }, { key: 'dealers', label: 'Dealers', icon: List }, { key: 'analytics', label: 'Analytics', icon: BarChart2 }].map((t) => (
              <button key={t.key} onClick={() => setView(t.key)} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 500, padding: '8px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', background: view === t.key ? C.panel : 'transparent', color: view === t.key ? C.text : C.textSoft }}><t.icon size={14} /> {t.label}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 24px 80px' }}>
        {view === 'command' && summary && (
          <div>
            <div style={{ marginBottom: 26 }}><div style={{ fontSize: 20, fontWeight: 600 }}>Command Center</div><div style={{ fontSize: 13.5, color: C.textSoft, marginTop: 4 }}>Sector-conditioned risk overview across all registered dealers.</div></div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 28 }}>
              <StatCard icon={Activity} label="Total Dealers Scanned" value={summary.total.toLocaleString('en-IN')} accent={C.sealBright} />
              <StatCard icon={Flag} label="Flagged for Review" value={flaggedCount} accent={C.high} />
              <StatCard icon={TrendingUp} label="Avg Risk Score" value={summary.avgRisk} accent={C.med} />
              <StatCard icon={ShieldAlert} label="High Risk Dealers" value={summary.high.toLocaleString('en-IN')} accent={C.high} />
              <StatCard icon={IndianRupee} label="Est. Tax at Risk / Year" value={fmtCr(summary.estTaxAtRisk || 0)} accent={C.gstp} />
            </div>
            <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: 24, marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>District Risk Heatmap</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.textFaint }}>Low <div style={{ width: 60, height: 6, borderRadius: 99, background: `linear-gradient(90deg, ${C.low}, ${C.med}, ${C.high})` }} /> High</div>
              </div>
              <div style={{ fontSize: 12.5, color: C.textFaint, marginBottom: 18 }}>Click a district to filter the dealer list.</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                {districtStats.map((d) => { const t = riskTier(d.avg); return (
                  <button key={d.district} onClick={() => { setFilterDistrict(d.district); setPage(1); setView('dealers'); }} style={{ textAlign: 'left', border: `1px solid ${t.color}40`, background: `${t.color}14`, borderRadius: 10, padding: '14px 14px', cursor: 'pointer' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>{d.district}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: t.color, fontFamily: 'monospace' }}>{d.avg}</div>
                    <div style={{ fontSize: 10.5, color: C.textFaint, marginTop: 4 }}>{d.count.toLocaleString('en-IN')} dealers · {d.high} high</div>
                  </button>
                ); })}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }} className="cc-grid">
              <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: 24 }}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 18 }}>Risk Distribution</div>
                {[{ label: 'Low Risk / Compliant', value: summary.low, color: C.low }, { label: 'Medium Risk', value: summary.med, color: C.med }, { label: 'High Risk', value: summary.high, color: C.high }].map((r) => (
                  <Bar key={r.label} label={r.label} value={r.value} max={summary.total} color={r.color} sub={`${r.value.toLocaleString('en-IN')} (${Math.round((r.value / summary.total) * 100)}%)`} />
                ))}
              </div>
              <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: 24 }}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 18 }}>Anomaly Type Breakdown</div>
                {ANOMALY_ORDER.map((k) => { const val = anomalyBreakdown[k] || 0; const total = Object.values(anomalyBreakdown).reduce((a, b) => a + b, 0) || 1; return (
                  <Bar key={k} label={ANOMALY_LABELS[k]} value={val} max={total} color={ANOMALY_COLORS[k]} sub={`${val} (${Math.round((val / total) * 100)}%)`} />
                ); })}
              </div>
            </div>
          </div>
        )}

        {view === 'dealers' && (
          <div>
            <div style={{ marginBottom: 20 }}><div style={{ fontSize: 20, fontWeight: 600 }}>Dealer List</div><div style={{ fontSize: 13.5, color: C.textSoft, marginTop: 4 }}>{dealerResult.total.toLocaleString('en-IN')} dealers found</div></div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
              <div style={{ flex: '1 1 260px', position: 'relative' }}>
                <Search size={15} color={C.textFaint} style={{ position: 'absolute', left: 12, top: 12 }} />
                <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search by GSTIN or business name…" style={{ width: '100%', background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 8, padding: '10px 12px 10px 34px', color: C.text, fontSize: 13.5, outline: 'none' }} />
              </div>
              <select value={filterSegment} onChange={(e) => { setFilterSegment(e.target.value); setPage(1); }} style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 8, padding: '10px 12px', color: C.text, fontSize: 13 }}><option value="All">All Segments</option>{SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <select value={filterDistrict} onChange={(e) => { setFilterDistrict(e.target.value); setPage(1); }} style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 8, padding: '10px 12px', color: C.text, fontSize: 13 }}><option value="All">All Districts</option>{DISTRICTS.map((d) => <option key={d} value={d}>{d}</option>)}</select>
              <select value={filterSector} onChange={(e) => { setFilterSector(e.target.value); setPage(1); }} style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 8, padding: '10px 12px', color: C.text, fontSize: 13 }}><option value="All">All Sectors</option>{SECTOR_KEYS.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <select value={filterRisk} onChange={(e) => { setFilterRisk(e.target.value); setPage(1); }} style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 8, padding: '10px 12px', color: C.text, fontSize: 13 }}><option value="All">All Risk Levels</option><option value="High Risk">High Risk</option><option value="Medium Risk">Medium Risk</option><option value="Low Risk">Low Risk</option></select>
            </div>
            {listLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{Array.from({ length: 6 }).map((_, i) => <div key={i} style={{ height: 66, background: C.panel, borderRadius: 10, opacity: 0.5 }} />)}</div>
            ) : dealerResult.results.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 0', color: C.textFaint }}><div style={{ fontSize: 14 }}>No dealers match these filters.</div></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {dealerResult.results.map((d) => { const f = flags[d.gstin]; return (
                  <button key={d.gstin} onClick={() => openDealer(d.gstin)} style={{ display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left', background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 10, padding: '14px 18px', cursor: 'pointer', flexWrap: 'wrap' }}>
                    <RiskBadge score={d.riskScore} />
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14.5, fontWeight: 600 }}>{d.businessName}</span>
                        {f && (f.status === 'flagged' || f.status === 'assigned') && <span style={{ fontSize: 10, background: `${C.high}22`, color: C.high, padding: '2px 7px', borderRadius: 99, fontWeight: 600 }}>{f.status === 'flagged' ? 'FLAGGED' : 'ASSIGNED'}</span>}
                      </div>
                      <div style={{ fontSize: 12, color: C.textFaint, fontFamily: 'monospace', marginTop: 2 }}>{d.gstin} · {d.district} · {d.sector} · {d.segment}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}><div style={{ fontSize: 13.5, fontWeight: 600 }}>{fmtCr(d.declared)}</div><div style={{ fontSize: 10.5, color: C.textFaint }}>declared</div></div>
                    <TierPill score={d.riskScore} />
                  </button>
                ); })}
              </div>
            )}
            {dealerResult.total > PAGE_SIZE && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 24 }}>
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 8, padding: 8, color: C.text, cursor: page === 1 ? 'default' : 'pointer', opacity: page === 1 ? 0.4 : 1 }}><ChevronLeft size={15} /></button>
                <span style={{ fontSize: 13, color: C.textSoft, fontFamily: 'monospace' }}>Page {page} of {Math.max(1, Math.ceil(dealerResult.total / PAGE_SIZE))}</span>
                <button onClick={() => setPage((p) => p + 1)} disabled={page >= Math.ceil(dealerResult.total / PAGE_SIZE)} style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 8, padding: 8, color: C.text, cursor: 'pointer', opacity: page >= Math.ceil(dealerResult.total / PAGE_SIZE) ? 0.4 : 1 }}><ChevronRight size={15} /></button>
              </div>
            )}
          </div>
        )}

        {view === 'profile' && (
          <div>
            <button onClick={() => setView('dealers')} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', color: C.textSoft, fontSize: 13, cursor: 'pointer', marginBottom: 20 }}><ArrowLeft size={14} /> Back to Dealer List</button>
            {profileLoading || !selectedDealer ? (<div style={{ height: 300, background: C.panel, borderRadius: 14, opacity: 0.5 }} />) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
                  <div><div style={{ fontSize: 22, fontWeight: 700 }}>{selectedDealer.businessName}</div><div style={{ fontSize: 13, color: C.textFaint, fontFamily: 'monospace', marginTop: 6 }}>{selectedDealer.gstin} · {selectedDealer.district} · {selectedDealer.sector} · {selectedDealer.segment} · {selectedDealer.regType}</div></div>
                  <RiskBadge score={selectedDealer.riskScore} size="lg" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }} className="profile-grid">
                  <div style={{ background: C.paper, borderRadius: 14, padding: 26, color: C.inkOnPaper }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 18, fontFamily: 'monospace', color: '#6B6250', letterSpacing: 0.5 }}>DECLARED VS IMPLIED REVENUE</div>
                    {[
                      { label: 'Declared turnover', value: selectedDealer.declared, color: '#8B8168' },
                      { label: 'Implied by electricity', value: selectedDealer.impliedElec, color: C.elec },
                      { label: 'Stock on the books', value: selectedDealer.bookStock, color: C.freight },
                      { label: 'Implied by employment', value: selectedDealer.impliedEmp, color: C.emp },
                      { label: 'Implied by fleet activity', value: selectedDealer.fleetImplied, color: '#C9A227' },
                      { label: 'GSTR-1 invoiced sales', value: selectedDealer.gstr1Sales, color: C.gstp },
                    ].map((row) => {
                      if (row.value == null) return null;
                      const vals = [selectedDealer.declared, selectedDealer.impliedElec, selectedDealer.bookStock, selectedDealer.impliedEmp, selectedDealer.fleetImplied, selectedDealer.gstr1Sales].filter((v) => v != null);
                      const mx = Math.max(...vals);
                      return (<div key={row.label} style={{ marginBottom: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5, fontFamily: 'monospace', color: '#544B3B' }}><span>{row.label}</span><span>{fmtCr(row.value)}</span></div><div style={{ height: 9, background: '#E5DEC9', borderRadius: 99 }}><div style={{ height: '100%', width: `${(row.value / mx) * 100}%`, background: row.color, borderRadius: 99 }} /></div></div>);
                    })}
                  </div>
                  <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: 26 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 18, color: C.textFaint, letterSpacing: 0.5 }}>WHY FLAGGED</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{selectedDealer.reasons.map((r, i) => (<div key={i} style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}><div style={{ width: 6, height: 6, borderRadius: '50%', background: riskTier(selectedDealer.riskScore).color, marginTop: 7, flexShrink: 0 }} /><div style={{ fontSize: 13.5, lineHeight: 1.6, color: C.textSoft }}>{r}</div></div>))}</div>
                  </div>
                </div>
                <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: 24, marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16, color: C.textFaint, letterSpacing: 0.5 }}>RAW SIGNAL DETAIL</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20 }} className="signal-detail-grid">
                    {selectedDealer.segment === 'Manufacturer' ? (
                      <div><div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.elec, marginBottom: 6 }}><Zap size={13} /> ELECTRICITY</div><div style={{ fontSize: 13 }}>{selectedDealer.connectionType} · {selectedDealer.monthlyUnits.toFixed(0)} kWh/mo</div><div style={{ fontSize: 11.5, color: C.textFaint }}>{selectedDealer.sanctionedLoad.toFixed(1)} kW sanctioned</div></div>
                    ) : (
                      <div><div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.textFaint, marginBottom: 6 }}><Zap size={13} /> ELECTRICITY (NOT SCORED)</div><div style={{ fontSize: 13 }}>{selectedDealer.monthlyUnits != null ? `${selectedDealer.monthlyUnits.toFixed(0)} kWh/mo` : '—'}</div><div style={{ fontSize: 11.5, color: C.textFaint }}>premises load only — no production evidence for {selectedDealer.segment.toLowerCase()}s</div></div>
                    )}
                    {selectedDealer.segment === 'Trader' ? (
                      <div><div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.gstp, marginBottom: 6 }}><FileText size={13} /> GSTR CHECKPOINT</div><div style={{ fontSize: 13 }}>2A {fmtMoney(selectedDealer.purchases)} − 3B {fmtMoney(selectedDealer.gstr3bTurnover)}</div><div style={{ fontSize: 11.5, color: C.textFaint }}>balance {fmtMoney(Math.max(0, selectedDealer.stockBalance || 0))} vs books {fmtMoney(selectedDealer.bookStock || 0)}</div></div>
                    ) : selectedDealer.segment === 'Logistics' ? (
                      <div><div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.freight, marginBottom: 6 }}><Truck size={13} /> FREIGHT</div><div style={{ fontSize: 13 }}>{selectedDealer.ewayCountMonthly} e-way bills/mo</div><div style={{ fontSize: 11.5, color: C.textFaint }}>{fmtCr(selectedDealer.ewayValueMonthly)}/mo · {selectedDealer.avgDistance != null ? `${selectedDealer.avgDistance.toFixed(0)} km avg` : '—'}</div></div>
                    ) : (
                      <div><div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.freight, marginBottom: 6 }}><Package size={13} /> STOCK ON BOOKS</div><div style={{ fontSize: 13 }}>{fmtMoney(selectedDealer.bookStock || 0)} closing stock</div><div style={{ fontSize: 11.5, color: C.textFaint }}>inputs {fmtMoney(selectedDealer.purchases)} · sales {fmtMoney(selectedDealer.gstr3bTurnover)}</div></div>
                    )}
                    <div><div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.emp, marginBottom: 6 }}><Users size={13} /> EMPLOYMENT</div><div style={{ fontSize: 13 }}>{selectedDealer.headcount} EPF/ESI registered</div><div style={{ fontSize: 11.5, color: C.textFaint }}>{fmtCr(selectedDealer.wageBill)}/yr wage bill</div></div>
                    <div><div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.sealBright, marginBottom: 6 }}><IndianRupee size={13} /> FILING</div><div style={{ fontSize: 13 }}>{selectedDealer.filingStatus}</div><div style={{ fontSize: 11.5, color: C.textFaint }}>ITC: {fmtCr(selectedDealer.itcClaimed)} ({(selectedDealer.itcRatio * 100).toFixed(0)}%)</div></div>
                  </div>
                </div>
                <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: 24 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16, color: C.textFaint, letterSpacing: 0.5 }}>OFFICER ACTION</div>
                  <textarea value={actionNote} onChange={(e) => setActionNote(e.target.value)} placeholder="Add a note (optional)…" style={{ width: '100%', background: C.ink2, border: `1px solid ${C.panelLine}`, borderRadius: 8, padding: 10, color: C.text, fontSize: 13, resize: 'vertical', minHeight: 60, marginBottom: 14, outline: 'none' }} />
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <button disabled={actionLoading} onClick={() => runAction('flag_for_investigation')} style={{ display: 'flex', alignItems: 'center', gap: 7, background: C.high, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: actionLoading ? 0.6 : 1 }}><Flag size={14} /> Flag for Investigation</button>
                    <button disabled={actionLoading} onClick={() => runAction('assign_officer')} style={{ display: 'flex', alignItems: 'center', gap: 7, background: C.seal, color: '#160F02', border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: actionLoading ? 0.6 : 1 }}><UserPlus size={14} /> Assign to Officer</button>
                    <button disabled={actionLoading} onClick={() => runAction('clear')} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'transparent', color: C.low, border: `1px solid ${C.low}55`, borderRadius: 8, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: actionLoading ? 0.6 : 1 }}><CheckCircle2 size={14} /> Clear as False Positive</button>
                  </div>
                  {flags[selectedDealer.gstin] && flags[selectedDealer.gstin].history.length > 0 && (
                    <div style={{ marginTop: 22, borderTop: `1px solid ${C.panelLine}`, paddingTop: 18 }}>
                      <div style={{ fontSize: 11.5, color: C.textFaint, marginBottom: 12, letterSpacing: 0.5 }}>AUDIT TRAIL</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {flags[selectedDealer.gstin].history.map((h, i) => (
                          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 12.5 }}>
                            <Clock size={13} color={C.textFaint} style={{ marginTop: 2, flexShrink: 0 }} />
                            <div><span style={{ color: C.text, fontWeight: 500 }}>{h.action === 'flag_for_investigation' ? 'Flagged for investigation' : h.action === 'assign_officer' ? 'Assigned to officer' : 'Cleared as false positive'}</span><span style={{ color: C.textFaint }}> — {h.note} · {h.at}</span></div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {view === 'analytics' && (
          <div>
            <div style={{ marginBottom: 26 }}><div style={{ fontSize: 20, fontWeight: 600 }}>Analytics</div><div style={{ fontSize: 13.5, color: C.textSoft, marginTop: 4 }}>Sector-level risk comparison and anomaly composition.</div></div>
            <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: 24, marginBottom: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Sector-wise Risk Comparison</div>
              <div style={{ fontSize: 12.5, color: C.textFaint, marginBottom: 18 }}>Average risk score and dealer count by sector</div>
              {sectorStats.map((s) => { const t = riskTier(s.avg); return (
                <div key={s.sector} style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6, flexWrap: 'wrap', gap: 4 }}><span style={{ fontWeight: 500 }}>{s.sector}</span><span style={{ color: C.textFaint, fontFamily: 'monospace' }}>{s.count.toLocaleString('en-IN')} dealers · <span style={{ color: t.color }}>{s.avg} avg</span> · {s.high} high</span></div>
                  <div style={{ height: 8, background: C.panelLine, borderRadius: 99 }}><div style={{ height: '100%', width: `${s.avg}%`, background: t.color, borderRadius: 99 }} /></div>
                </div>
              ); })}
            </div>
            <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 18 }}>Anomaly Type Breakdown</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 32, flexWrap: 'wrap' }}>
                <DonutChart data={ANOMALY_ORDER.map((k) => ({ label: ANOMALY_LABELS[k], value: anomalyBreakdown[k] || 0, color: ANOMALY_COLORS[k] }))} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{ANOMALY_ORDER.map((k) => (<div key={k} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 }}><div style={{ width: 10, height: 10, borderRadius: 3, background: ANOMALY_COLORS[k] }} /><span style={{ color: C.textSoft }}>{ANOMALY_LABELS[k]}</span><span style={{ fontFamily: 'monospace', color: C.text, fontWeight: 600 }}>{anomalyBreakdown[k] || 0}</span></div>))}</div>
              </div>
            </div>
          </div>
        )}
      </div>
      <style>{`
        @media (max-width: 880px) {
          .cc-grid { grid-template-columns: 1fr !important; }
          .profile-grid { grid-template-columns: 1fr !important; }
          .signal-detail-grid { grid-template-columns: 1fr 1fr !important; }
        }
      `}</style>
    </div>
  );
}
