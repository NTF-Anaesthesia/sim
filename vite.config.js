// The app runs with no build step. This config exists so CI can prove the code builds as part of any Vite app.
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    lib: { entry: 'src/vite-entry.js', formats: ['es'], fileName: 'sim' },
  },
});
