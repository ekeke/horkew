import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const scenariosSrc = 'src/retar/scenarios'
const orchBase = 'tmp'

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

/** tmp/orch-* から最新の pretrain-snapshots.json を自動配信 */
function servePretrainSnapshots(): Plugin {
  let base = '/horkew/'

  return {
    name: 'serve-pretrain-snapshots',

    configResolved(config) {
      base = config.base
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== `${base}pretrain-snapshots.json`) return next()
        // tmp/orch-* の中から最新の pretrain-snapshots.json を探す
        try {
          const dirs = readdirSync(orchBase)
            .filter(d => d.startsWith('orch-') && !d.endsWith('.log'))
            .map(d => join(orchBase, d, 'pretrain-snapshots.json'))
            .filter(p => existsSync(p))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
          if (dirs.length === 0) {
            res.statusCode = 404
            res.end('No pretrain-snapshots.json found')
            return
          }
          const content = readFileSync(dirs[0], 'utf-8')
          res.setHeader('Content-Type', 'application/json')
          res.end(content)
        } catch {
          next()
        }
      })
    },
  }
}

/** train-status.json の checkpointBase から inspect/ を配信（dev only） */
function serveInspect(): Plugin {
  let base = '/horkew/'

  return {
    name: 'serve-inspect',

    configResolved(config) {
      base = config.base
    },

    configureServer(server) {
      const prefix = `${base}inspect/`
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next()
        const filename = decodeURIComponent(req.url.slice(prefix.length))
        try {
          const statusPath = 'train-status.json'
          if (!existsSync(statusPath)) {
            res.statusCode = 404
            res.end('No train-status.json found')
            return
          }
          const status = JSON.parse(readFileSync(statusPath, 'utf-8'))
          const inspectDir = join(status.checkpointBase, 'inspect')
          const filePath = join(inspectDir, filename)
          if (!existsSync(filePath)) {
            res.statusCode = 404
            res.end('Not found')
            return
          }
          const content = readFileSync(filePath, 'utf-8')
          res.setHeader('Content-Type', 'application/json')
          res.end(content)
        } catch {
          next()
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [svelte({ configFile: '../svelte.config.js' }), serveScenarios(), servePretrainSnapshots(), serveInspect()],
  root: 'demo',
  base: '/horkew/',
  server: { port: 5375, strictPort: true },
  build: { chunkSizeWarningLimit: 600 },
})
