"""
INTELLITAX-AI Phase 2 — SHAP explanation service.

Converts local SHAP attributions into plain-language, rupee-specific reasons
in the exact style of the v29 engine's `reasons` array — so the UI's profile
section works unchanged while the explanations become model-derived
(XGBoost + SHAP), not just rule-derived.
"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from features import CATEGORICAL_FEATURES, _f  # noqa: E402


def fmt_money(n):
    """Rupee money formatting matching the engine's fmtMoney()."""
    n = _f(n)
    if n >= 1e7:
        return f"₹{n / 1e7:.2f} Cr"
    if n >= 1e5:
        return f"₹{n / 1e5:.2f} L"
    return f"₹{int(round(n)):,}"


# Human labels per canonical feature name.
FEATURE_LABELS = {
    "turnover_divergence": "GSTR-1 vs 3B divergence",
    "purchase_no_sale": "Purchases without sales (conduit)",
    "purchase_flow_ratio": "Purchase-to-sales flow",
    "stock_short": "Stock checkpoint — goods unaccounted",
    "stock_excess": "Stock checkpoint — paper stock",
    "log_ratio_elec": "Electricity-implied production",
    "gap_elec": "Upward electricity gap",
    "log_ratio_emp": "Employment-implied capacity",
    "gap_emp": "Upward employment gap",
    "log_ratio_fleet": "Fleet-implied freight revenue",
    "gap_fleet": "Upward fleet gap",
    "itc_ratio": "Excessive Input Tax Credit",
    "declared_near_composite": "Threshold-gaming posture",
    "tax_rate_effective": "Effective tax rate",
    "late_or_nonfiler": "Filing discipline",
    "headcount_per_cr": "Employment intensity",
    "units_per_cr": "Power intensity",
    "eway_per_cr": "E-way intensity",
    "state_econ_factor": "State economic calibration",
    "stock_balance_ratio": "Returns-implied stock balance",
    "stock_cover_ratio": "Stock vs returns balance",
    "reg_type": "Registration type",
    "sector": "Sector posture",
    "state": "State",
    "log_declared": "Declared turnover scale",
    "log_headcount": "Workforce scale",
}

# Features only cited for the matching segment (mirrors the engine's lens).
SEGMENT_SCOPED = {
    "log_ratio_elec": ("Manufacturer",),
    "gap_elec": ("Manufacturer",),
    "units_per_cr": ("Manufacturer",),
    "log_ratio_emp": ("Manufacturer", "Logistics"),
    "gap_emp": ("Manufacturer", "Logistics"),
    "log_ratio_fleet": ("Logistics",),
    "gap_fleet": ("Logistics",),
    "eway_per_cr": ("Logistics",),
    "stock_short": ("Trader",),
    "stock_excess": ("Trader",),
    "stock_balance_ratio": ("Trader",),
    "stock_cover_ratio": ("Trader",),
    "purchase_no_sale": ("Trader",),
    "purchase_flow_ratio": ("Trader",),
}


def rupee_context(feature, d):
    """Build the rupee-specific clause for a feature from the raw dealer dict."""
    declared = _f(d.get("declared"))
    purchases = _f(d.get("purchases"))
    gstr1 = _f(d.get("gstr1Sales"))
    gstr3b = _f(d.get("gstr3bTurnover"))
    books = _f(d.get("bookStock"))
    balance = purchases - gstr3b

    if feature == "turnover_divergence":
        pct = round(100 * max(0.0, 1 - gstr3b / gstr1)) if gstr1 > 0 else 0
        return (f"GSTR-1 shows {fmt_money(gstr1)} of invoiced sales but GSTR-3B returns only "
                f"{fmt_money(gstr3b)} — {pct}% of invoiced turnover never reached the exchequer.")
    if feature == "purchase_no_sale":
        return (f"GSTR-2A purchases of {fmt_money(purchases)} exceed GSTR-1 sales of {fmt_money(gstr1)} — "
                f"ITC claimed at input with no matching output invoices (conduit pattern).")
    if feature == "purchase_flow_ratio":
        flow = purchases / gstr1 if gstr1 > 0 else 0.0
        return (f"GSTR-2A purchases of {fmt_money(purchases)} flow at {flow:.2f}× GSTR-1 sales of "
                f"{fmt_money(gstr1)} — inputs never resurfacing as invoiced output.")
    if feature == "stock_short":
        return (f"GSTR-2A purchases of {fmt_money(purchases)} minus GSTR-3B sales of {fmt_money(gstr3b)} "
                f"leave a {fmt_money(balance)} balance, but the books show only {fmt_money(books)} of stock — "
                f"goods that left without being invoiced.")
    if feature == "stock_excess":
        mult = books / balance if balance > 0 else 0.0
        return (f"The books claim {fmt_money(books)} of closing stock, {mult:.1f}× the {fmt_money(balance)} "
                f"implied by 2A purchases minus 3B sales — a paper-stock pattern propping up ITC.")
    if feature in ("log_ratio_elec", "gap_elec"):
        ie = _f(d.get("impliedElec"))
        gap = max(0.0, 1 - declared / ie) if ie > 0 else 0.0
        return (f"Electricity consumption implies ~{fmt_money(ie)} of annual production against "
                f"{fmt_money(declared)} declared — a {round(gap * 100)}% unexplained gap.")
    if feature in ("log_ratio_emp", "gap_emp"):
        ie = _f(d.get("impliedEmp"))
        hc = int(_f(d.get("headcount")))
        return (f"EPF/ESI headcount of {hc} implies ~{fmt_money(ie)} revenue capacity against "
                f"{fmt_money(declared)} declared.")
    if feature in ("log_ratio_fleet", "gap_fleet"):
        fi = _f(d.get("fleetImplied"))
        trips = int(_f(d.get("ewayCountMonthly")))
        dist = _f(d.get("avgDistance"))
        dist_txt = f"{dist:.0f} km" if dist else "—"
        return (f"Fleet activity ({trips} e-way bills/mo × ~{dist_txt}) implies ~{fmt_money(fi)} of freight "
                f"revenue against {fmt_money(declared)} declared.")
    if feature == "itc_ratio":
        itc = _f(d.get("itcClaimed"))
        r = _f(d.get("itcRatio"))
        return (f"Input Tax Credit of {fmt_money(itc)} is {round(r * 100)}% of declared turnover, far above "
                f"the 5–17% segment norm.")
    if feature == "declared_near_composite":
        pct_under = round(100 * (15_000_000 - declared) / 15_000_000)
        return (f"Composite-scheme dealer declaring {fmt_money(declared)} — parked just {pct_under}% under "
                f"the ₹1.5 Cr threshold.")
    if feature == "tax_rate_effective":
        tax = _f(d.get("taxPaid"))
        pct = round(100 * tax / declared) if declared > 0 else 0
        return f"Net GST paid is {pct}% of declared turnover ({fmt_money(tax)}) — thin for this segment."
    if feature == "late_or_nonfiler":
        filing = d.get("filingStatus", "")
        return f"Filing status is '{filing}' — late or missing returns compound the other signals."
    if feature == "headcount_per_cr":
        hc = int(_f(d.get("headcount")))
        cr = declared / 1e7 if declared > 0 else 0.0
        return (f"{hc} EPF/ESI-registered employees against ₹{cr:.1f} Cr of declared turnover — "
                f"employment intensity above the segment band.")
    if feature == "units_per_cr":
        u = _f(d.get("monthlyUnits"))
        return (f"Power draw of {u:,.0f} kWh per crore of declared turnover — production intensity "
                f"without matching revenue.")
    if feature == "eway_per_cr":
        e = _f(d.get("ewayCountMonthly"))
        return (f"{int(e)} e-way bills per month against ₹{declared / 1e7:.1f} Cr declared — goods movement "
                f"without matching revenue.")
    return None


def group_shap_row(feature_names_out, shap_row):
    """Map one transformed SHAP row back to canonical feature names.

    num__log_declared      -> log_declared   (1:1)
    cat__reg_type_Regular  -> reg_type       (longest-prefix match)
    Returns [(feature, summed_shap)] sorted by |shap| desc.
    """
    cat_sorted = sorted(CATEGORICAL_FEATURES, key=len, reverse=True)
    groups = {}
    for col, fname in enumerate(feature_names_out):
        base = str(fname).split("__", 1)[-1]
        if base.startswith("num__"):
            name = base[5:]
        else:
            name = next((f for f in cat_sorted if base.startswith(f + "_")), base)
        groups[name] = groups.get(name, 0.0) + float(shap_row[col])
    return sorted(groups.items(), key=lambda kv: abs(kv[1]), reverse=True)


CLEAN_MESSAGES = {
    "Trader": ("GSTR-1/2A/3B triangulation passes the stock-reconciliation checkpoint: purchases, sales and "
               "book stock are proportionate — the model finds no evasion signal."),
    "Logistics": "Fleet activity and filings are consistent with declared revenue — no anomaly isolated.",
    "Manufacturer": "Electricity and employment signals are consistent with declared turnover — no anomaly isolated.",
}


def explain_dealer(shap_pairs, dealer, top_k=6):
    """shap_pairs: [(feature, shap_value)] sorted by |value| desc (from group_shap_row).

    Returns reason strings for the risk-RAISING factors, tagged with the
    feature's SHAP contribution, e.g.
      "[turnover_divergence +1.83] GSTR-1 shows ₹2.4 Cr ... never reached the exchequer."
    For clean dealers, returns the exoneration message plus the strongest
    factor keeping the score down.
    """
    segment = dealer.get("segment", "")
    out = []
    for name, val in shap_pairs:
        if len(out) >= top_k:
            break
        if val <= 0:
            continue
        scoped = SEGMENT_SCOPED.get(name)
        if scoped and segment not in scoped:
            continue
        ctx = rupee_context(name, dealer)
        if ctx is None:
            label = FEATURE_LABELS.get(name, name)
            ctx = f"{label} pushes the model's risk estimate up for this dealer."
        out.append(f"[{name} +{val:.2f}] {ctx}")

    if out:
        return out

    # Clean dealer: say WHY the model exonerates it (top negative contribution).
    neg = next(((n, v) for n, v in shap_pairs if v < 0), None)
    clean = CLEAN_MESSAGES.get(segment, "All evidence blocks are consistent with the declaration.")
    if neg:
        label = FEATURE_LABELS.get(neg[0], neg[0])
        clean += f" Strongest exonerating factor: {label} ({neg[1]:.2f})."
    return [clean]
