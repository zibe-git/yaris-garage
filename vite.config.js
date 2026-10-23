import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5182, strictPort: true },
  preview: { port: 4175, strictPort: true },
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
