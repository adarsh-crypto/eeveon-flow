/**
 * Four separate bundles, because an MV3 extension needs several different module formats:
 *
 *   sidepanel      — an HTML entry with React, code-split is fine
 *   dashboard      — a second, independent HTML entry with React (reuses sidepanel/RunPanel)
 *   service-worker — a single ES module (manifest declares "type": "module")
 *   content        — a single IIFE; content scripts cannot use ES imports at all
 *
 * A single vite build cannot satisfy all of these, so this drives vite four times into one
 * dist/ and copies the static files itself.
 */
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 1. Side panel — HTML entry, React, hashed asset names.
await build({
  root: resolve(root, 'src/sidepanel'),
  base: './',
  plugins: [react()],
  build: {
    outDir: dist,
    emptyOutDir: false,
    watch: watch ? {} : null,
    rollupOptions: {
      input: resolve(root, 'src/sidepanel/index.html'),
    },
  },
});

// The manifest points at sidepanel.html; vite names an HTML entry after its file.
if (existsSync(resolve(dist, 'index.html'))) {
  await rename(resolve(dist, 'index.html'), resolve(dist, 'sidepanel.html'));
}

// 2. Dashboard — separate HTML entry, opened as a full tab (chrome.tabs.create).
await build({
  root: resolve(root, 'src/dashboard'),
  base: './',
  plugins: [react()],
  build: {
    outDir: dist,
    emptyOutDir: false,
    watch: watch ? {} : null,
    rollupOptions: {
      input: resolve(root, 'src/dashboard/index.html'),
    },
  },
});

if (existsSync(resolve(dist, 'index.html'))) {
  await rename(resolve(dist, 'index.html'), resolve(dist, 'dashboard.html'));
}

// 3. Service worker — one ES module, no code splitting (a worker cannot fetch chunks).
await build({
  root,
  build: {
    outDir: dist,
    emptyOutDir: false,
    watch: watch ? {} : null,
    lib: {
      entry: resolve(root, 'src/background/service-worker.ts'),
      formats: ['es'],
      fileName: () => 'service-worker.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});

// 4. Content script — IIFE, self-contained, injected into arbitrary pages.
await build({
  root,
  build: {
    outDir: dist,
    emptyOutDir: false,
    watch: watch ? {} : null,
    lib: {
      entry: resolve(root, 'src/record/content.ts'),
      formats: ['iife'],
      name: 'EeveonFlowRecorder',
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true, extend: true },
    },
  },
});

// 5. Static files.
for (const entry of await readdir(resolve(root, 'public'))) {
  await cp(resolve(root, 'public', entry), resolve(dist, entry), { recursive: true });
}

console.log(`\nBuilt ${dist}`);
console.log('Load it: chrome://extensions → Developer mode → Load unpacked → select dist/');
