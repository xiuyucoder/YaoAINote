import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the React app runs at localhost:5173 and we proxy /api → backend.
// In prod, the frontend is served from a different origin (Vercel) and talks
// to Railway via VITE_API_BASE_URL — see src/api.js.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
