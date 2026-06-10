import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // Listen on all interfaces
    strictPort: true,
    port: 5173,
    allowedHosts: true, // Allow all hosts
    watch: {
      ignored: ['**/node_modules_trash_1/**', '**/backup-*/**']
    },
  },
  clearScreen: false // Keep logs visible
})

