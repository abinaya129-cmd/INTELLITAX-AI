import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Phase 2: same-origin proxy to the FastAPI ML backend (XGBoost +
    // Isolation Forest + SHAP). The frontend calls /api/... with
    // VITE_API_BASE empty — no CORS, identical shape in production behind
    // any reverse proxy.
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
