import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./web/', import.meta.url)),
  envDir: fileURLToPath(new URL('./', import.meta.url)),
  publicDir: fileURLToPath(new URL('./public/', import.meta.url)),
  base: process.env.GITHUB_PAGES_BASE_PATH || './',
  build: { outDir: '../dist-pages', emptyOutDir: true },
});
