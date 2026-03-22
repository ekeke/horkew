import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte({ configFile: '../svelte.config.js' })],
  root: 'demo',
  server: { port: 5375, strictPort: true },
  build: { chunkSizeWarningLimit: 600 },
})
