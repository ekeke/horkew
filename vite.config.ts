import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'

const scenariosSrc = 'src/retar/scenarios'

function serveScenarios(): Plugin {
  let base = '/horkew/'

  return {
    name: 'serve-scenarios',

    configResolved(config) {
      base = config.base
    },

    // dev: src/retar/scenarios/ から直接配信
    configureServer(server) {
      const prefix = `${base}scenarios/`
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next()
        const filename = decodeURIComponent(req.url.slice(prefix.length))
        try {
          const content = readFileSync(join(scenariosSrc, filename), 'utf-8')
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end(content)
        } catch {
          next()
        }
      })
    },

    // build: ビルド出力に scenarios/ をコピー
    generateBundle() {
      const files = readdirSync(scenariosSrc).filter(f => f.endsWith('.howl'))
      for (const file of files) {
        this.emitFile({
          type: 'asset',
          fileName: `scenarios/${file}`,
          source: readFileSync(join(scenariosSrc, file), 'utf-8'),
        })
      }
    },
  }
}

export default defineConfig({
  plugins: [svelte({ configFile: '../svelte.config.js' }), serveScenarios()],
  root: 'demo',
  base: '/horkew/',
  server: { port: 5375, strictPort: true },
  build: { chunkSizeWarningLimit: 600 },
})
