/* ================================================================================
   INTELLITAX-AI Phase 2 — live backend client
   --------------------------------------------------------------------------------
   When VITE_API_BASE is set, every API call goes to the FastAPI backend serving
   XGBoost + IsolationForest + SHAP inference. Any failure — server down,
   network error — transparently falls back to the in-browser simulation API,
   so the demo NEVER breaks. Empty VITE_API_BASE + the Vite dev proxy keeps
   every call same-origin (/api -> localhost:8000).
   ================================================================================ */

const API_BASE = (import.meta.env && import.meta.env.VITE_API_BASE) || '';
export const isLiveBackend = () => !!API_BASE;

async function req(path, options) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  /* text()+JSON.parse instead of res.json(): some embedded webviews ship a
     fetch shim whose json() is unreliable — text() is universally safe. */
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

/* Wraps the same contract as createApi(dealers) in gstDataEngine.js.
   Each method IS the wrapped async function: remote first, sim on failure. */
export function remoteApi(fallbackApi) {
  const wrap = (remoteCall, fallbackCall) => async (...args) => {
    try {
      return await remoteCall(...args);
    } catch (e) {
      console.warn('[intellitax] backend unreachable — falling back to in-browser simulation:', e.message);
      return fallbackCall(...args);
    }
  };

  return {
    getDealers: wrap(
      (params = {}) => req(`/api/dealers?${new URLSearchParams({
        search: params.search || '',
        state: params.state || 'All',
        district: params.district || 'All',
        sector: params.sector || 'All',
        segment: params.segment || 'All',
        risk: params.risk || 'All',
        page: params.page || 1,
        pageSize: params.pageSize || 15,
      }).toString()}`),
      (params = {}) => fallbackApi.getDealers(params),
    ),
    getDealer: wrap(
      (gstin) => req(`/api/dealer/${encodeURIComponent(gstin)}`),
      (gstin) => fallbackApi.getDealer(gstin),
    ),
    getDistrictSummary: wrap(
      () => req('/api/district-summary'),
      () => fallbackApi.getDistrictSummary(),
    ),
    getSectorSummary: wrap(
      () => req('/api/sector-summary'),
      () => fallbackApi.getSectorSummary(),
    ),
    getAnomalyBreakdown: wrap(
      () => req('/api/anomaly-breakdown'),
      () => fallbackApi.getAnomalyBreakdown(),
    ),
    getSummaryStats: wrap(
      () => req('/api/summary-stats'),
      () => fallbackApi.getSummaryStats(),
    ),
  };
}

/* Officer audit actions persist to the backend when live (fire-and-forget:
   the UI already updates local state + localStorage as the primary path). */
export async function postFlagRemote(gstin, action, note) {
  try {
    await req('/api/flags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gstin, action, note }),
    });
    return true;
  } catch (e) {
    console.warn('[intellitax] audit action not persisted to backend:', e.message);
    return false;
  }
}
