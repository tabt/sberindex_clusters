import { defineConfig } from 'vite';

// База './' — чтобы сборка работала и на Vercel, и из любой подпапки
export default defineConfig({
  base: './',
  build: { outDir: 'dist', assetsInlineLimit: 0 },
});
