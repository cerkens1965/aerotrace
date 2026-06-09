import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Date de build injectée dans le bundle (cf src/version.js) — indicateur anti-cache.
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  server: {
    proxy: {
      '/safesky': 'http://localhost:3001',
    },
  },
})
