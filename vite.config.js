import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  // Google Maps key ay pinapayagan sa .env bilang GOOGLE_MAPS_API_KEY
  // (import.meta.env.GOOGLE_MAPS_API_KEY)
  envPrefix: ['VITE_', 'GOOGLE_MAPS_'],
  server: {
    host: '0.0.0.0',
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
});
