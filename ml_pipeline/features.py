"""
INTELLITAX-AI Phase 2 — Feature engineering (shared by training & serving).

The feature block mirrors the v29 sector-conditioned evidence lens:
  Manufacturers -> production footprint (electricity, employment)
  Traders       -> GSTR-1 / 2A / 3B triangulation + THE stock checkpoint
  Logistics     -> fleet economics
plus state economic calibration and registration posture. The training label
is the planted fraud typology baked into the synthetic generator (ground
truth), so the models learn the same identity checks the rule engine encodes —
without ever seeing the rule scores themselves.
"""

import math

# ---------------------------------------------------------------------------
# Feature schema (single source of truth, exported to artifacts/meta.json)
# ---------------------------------------------------------------------------
NUMERIC_FEATURES = [
    "log_declared",
    "log_purchases",
    "log_gstr1_sales",
    "log_gstr3b_turnover",
    "log_book_stock",
    "log_tax_paid",
    "itc_ratio",
    "purchase_flow_ratio",      # 2A purchases / GSTR-1 sales
    "purchase_no_sale",         # share of purchases with no matching sales
    "turnover_divergence",      # GSTR-1 sales not returned in 3B
    "stock_balance_ratio",      # (2A - 3B) / purchases
    "stock_cover_ratio",        # books / balance when balance > 0 (capped 5x)
    "stock_short",              # (balance - books) / purchases, books falling short
    "stock_excess",             # (books - 1.6x balance) / balance, paper-stock face
    "log_ratio_elec",           # log(electricity-implied revenue / declared)
    "log_ratio_emp",            # log(EPF-implied capacity / declared)
    "log_ratio_fleet",          # log(fleet-implied revenue / declared)
    "gap_elec",                 # upward-only electricity gap
    "gap_emp",                  # upward-only employment gap
    "gap_fleet",                # upward-only fleet gap
    "headcount_per_cr",         # employment footprint intensity
    "units_per_cr",             # electricity intensity (kWh per crore declared)
    "eway_per_cr",              # e-way bills per crore declared (logistics)
    "declared_near_composite",  # distance below the Rs.1.5 Cr line (negative = above)
    "tax_rate_effective",       # taxPaid / declared
    "is_manufacturer",
    "is_trader",
    "is_logistics",
    "log_headcount",
    "state_econ_factor",        # v29 state economic calibration factor
    "late_or_nonfiler",         # filing discipline (0/1)
]

CATEGORICAL_FEATURES = ["sector", "state", "reg_type"]

FEATURE_NAMES = NUMERIC_FEATURES + CATEGORICAL_FEATURES

# Composite scheme turnover cap (mirrors the engine constant)
COMPOSITE_LIMIT = 15_000_000.0

# v29 state economic factors (mirrors INDIA_STATES in gstDataEngine.js)
STATE_FACTORS = {
    "Maharashtra": 1.30, "Tamil Nadu": 1.15, "Gujarat": 1.25, "Karnataka": 1.20,
    "Uttar Pradesh": 0.90, "Delhi": 1.30, "Telangana": 1.15, "West Bengal": 1.00,
    "Rajasthan": 0.95, "Haryana": 1.15, "Andhra Pradesh": 0.95, "Kerala": 1.10,
    "Madhya Pradesh": 0.85, "Punjab": 1.05, "Bihar": 0.75, "Odisha": 0.85,
    "Assam": 0.85, "Jharkhand": 0.85, "Chhattisgarh": 0.85, "Uttarakhand": 0.95,
    "Goa": 1.10, "Himachal Pradesh": 0.95, "Jammu & Kashmir": 0.85,
    "Chandigarh": 1.25, "Puducherry": 1.05, "Tripura": 0.80, "Sikkim": 0.85,
    "Nagaland": 0.75, "Manipur": 0.75, "Meghalaya": 0.75, "Mizoram": 0.70,
    "Arunachal Pradesh": 0.70,
}


def _f(v):
    """Coerce to a finite float, defaulting to 0.0 on None/NaN/garbage."""
    try:
        if v is None:
            return 0.0
        v = float(v)
        return v if v == v else 0.0
    except (TypeError, ValueError):
        return 0.0


def _log1p(v):
    return math.log1p(max(_f(v), 0.0))


def _gap_up(declared, implied):
    """Upward-only gap: how much LARGER the evidence is than the declaration.
    Mirrors the engine's gapUp() — over-reporters never score."""
    if implied and implied > 0 and declared:
        return max(0.0, 1.0 - declared / implied)
    return 0.0


def make_features(dealer):
    """dealer: dict with the engine's raw fields -> ordered feature dict.

    Segment-conditional evidence ratios default to 1.0 (parity) when a feed
    is absent, so the trees can split on 'evidence exists vs not' exactly
    like the rule engine does.
    """
    declared = _f(dealer.get("declared"))
    purchases = _f(dealer.get("purchases"))
    gstr1 = _f(dealer.get("gstr1Sales"))
    gstr3b = _f(dealer.get("gstr3bTurnover"))
    book_stock = _f(dealer.get("bookStock"))
    tax_paid = _f(dealer.get("taxPaid"))
    itc_ratio = _f(dealer.get("itcRatio"))
    headcount = _f(dealer.get("headcount"))
    monthly_units = _f(dealer.get("monthlyUnits"))
    is_logistics = dealer.get("segment") == "Logistics"
    eway_count = _f(dealer.get("ewayCountMonthly")) if is_logistics else 0.0

    elec_implied = _f(dealer.get("impliedElec"))
    emp_implied = _f(dealer.get("impliedEmp"))
    fleet_implied = _f(dealer.get("fleetImplied"))

    # Evidence ratios: implied / declared, or 1.0 (parity) when no feed.
    ratio_elec = (elec_implied / declared) if (elec_implied > 0 and declared > 0) else 1.0
    ratio_emp = (emp_implied / declared) if (emp_implied > 0 and declared > 0) else 1.0
    ratio_fleet = (fleet_implied / declared) if (is_logistics and fleet_implied > 0 and declared > 0) else 1.0

    # --- stock checkpoint (the trader identity: 2A - 3B = book stock) -------
    balance = purchases - gstr3b
    if balance > 0 and purchases > 0:
        if book_stock < balance:
            stock_short = (balance - book_stock) / purchases
            stock_excess = 0.0
        elif book_stock > balance * 1.6:
            stock_short = 0.0
            stock_excess = (book_stock - balance * 1.6) / max(1.0, balance)
        else:
            stock_short = 0.0
            stock_excess = 0.0
        stock_cover = min(book_stock / balance, 5.0)
    else:
        stock_short = 0.0
        stock_excess = 0.0
        stock_cover = 0.0

    stock_balance_ratio = balance / purchases if purchases > 0 else 0.0

    purchase_flow = purchases / gstr1 if gstr1 > 0 else (2.0 if purchases > 0 else 0.0)
    purchase_no_sale = max(0.0, 1.0 - gstr1 / purchases) if purchases > 0 else 0.0
    turnover_div = max(0.0, 1.0 - gstr3b / gstr1) if gstr1 > 0 else 0.0

    cr = max(1.0, declared / 1e7)  # declared in crores, floored at 1

    state_name = str(dealer.get("state", "") or "")
    filing = str(dealer.get("filingStatus", "") or "").lower()

    return {
        "log_declared": _log1p(declared),
        "log_purchases": _log1p(purchases),
        "log_gstr1_sales": _log1p(gstr1),
        "log_gstr3b_turnover": _log1p(gstr3b),
        "log_book_stock": _log1p(book_stock),
        "log_tax_paid": _log1p(tax_paid),
        "itc_ratio": itc_ratio,
        "purchase_flow_ratio": purchase_flow,
        "purchase_no_sale": purchase_no_sale,
        "turnover_divergence": turnover_div,
        "stock_balance_ratio": stock_balance_ratio,
        "stock_cover_ratio": stock_cover,
        "stock_short": stock_short,
        "stock_excess": stock_excess,
        "log_ratio_elec": math.log1p(max(ratio_elec, 0.0)),
        "log_ratio_emp": math.log1p(max(ratio_emp, 0.0)),
        "log_ratio_fleet": math.log1p(max(ratio_fleet, 0.0)),
        "gap_elec": _gap_up(declared, elec_implied),
        "gap_emp": _gap_up(declared, emp_implied),
        "gap_fleet": _gap_up(declared, fleet_implied if is_logistics else 0.0),
        "headcount_per_cr": headcount / cr,
        "units_per_cr": monthly_units / cr,
        "eway_per_cr": eway_count / cr,
        "declared_near_composite": (COMPOSITE_LIMIT - declared) / COMPOSITE_LIMIT,
        "tax_rate_effective": (tax_paid / declared) if declared > 0 else 0.0,
        "is_manufacturer": 1.0 if dealer.get("segment") == "Manufacturer" else 0.0,
        "is_trader": 1.0 if dealer.get("segment") == "Trader" else 0.0,
        "is_logistics": 1.0 if is_logistics else 0.0,
        "log_headcount": _log1p(headcount),
        "state_econ_factor": STATE_FACTORS.get(state_name, 1.0),
        "late_or_nonfiler": 1.0 if ("late" in filing or "non-filer" in filing) else 0.0,
        "sector": str(dealer.get("sector", "") or ""),
        "state": state_name,
        "reg_type": str(dealer.get("regType", "") or ""),
    }
