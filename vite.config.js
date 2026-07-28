import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // dxf-viewer's worker (src/utils/dxfViewerWorker.js) uses static ES imports
  // internally — 'es' format keeps those working in both dev and the built
  // worker chunk, unlike the default 'iife' format.
  worker: {
    format: 'es',
  },
  server: {
    host: '0.0.0.0', // Listen on all interfaces
    strictPort: true,
    port: 5173,
    allowedHosts: true, // Allow all hosts
    watch: {
      ignored: ['**/node_modules_trash_1/**', '**/backup-*/**']
    },
    // Same-origin proxying for local dev, mirroring nginx.conf.template's
    // /normalizer and /bcf routes in prod — needed so the dashboard's
    // login session cookie (httpOnly, set by bim-normalizer's /auth/login)
    // actually gets sent back on subsequent requests. Cross-origin fetches
    // to a raw http://localhost:8002 (this app's default VITE_NORMALIZER_URL
    // outside Docker) never carry that cookie, and main.py's CORS is a
    // wildcard origin, which browsers refuse to combine with credentials
    // anyway — proxying keeps everything same-origin instead of loosening
    // that. Only takes effect if VITE_NORMALIZER_URL/VITE_BCF_URL are set to
    // the relative '/normalizer'/'/bcf' (as the Docker build already does
    // via docker-compose.yml's build args) rather than the default absolute
    // localhost URLs used for non-Docker local dev.
    proxy: {
      '/normalizer': {
        target: 'http://localhost:8002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/normalizer/, ''),
      },
      '/bcf': {
        target: 'http://localhost:8004',
        changeOrigin: true,
      },
    },
  },
  clearScreen: false // Keep logs visible
})

