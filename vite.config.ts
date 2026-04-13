import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, extname, resolve } from 'node:path'

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

/**
 * Stats CLI を CGI 風に spawn して JSON を返す（dev only）
 *
 * GET /horkew/stats/day1-formation.json[?base=<path>]
 *   - base 省略時は train-status.json の checkpointBase を使用
 *   - eval-howl/ の最新 mtime でキャッシュキーを作り、同一ならキャッシュ返却
 */
function serveStats(): Plugin {
  let base = '/horkew/'
  const cache = new Map<string, { key: string, body: string }>()

  return {
    name: 'serve-stats',

    configResolved(config) { base = config.base },

    configureServer(server) {
      const prefix = `${base}stats/`
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next()
        try {
          const url = new URL(req.url, 'http://localhost')
          const filename = decodeURIComponent(url.pathname.slice(prefix.length))
          if (filename !== 'day1-formation.json') return next()

          // base 解決: ?base=... 優先、なければ train-status.json
          let ckptBase = url.searchParams.get('base') ?? ''
          if (!ckptBase) {
            const statusPath = 'train-status.json'
            if (!existsSync(statusPath)) {
              res.statusCode = 404
              res.end('No train-status.json and no ?base=... provided')
              return
            }
            ckptBase = JSON.parse(readFileSync(statusPath, 'utf-8')).checkpointBase
          }
          const evalDir = join(ckptBase, 'eval-howl')
          if (!existsSync(evalDir)) {
            res.statusCode = 404
            res.end(`eval-howl/ not found in ${ckptBase}`)
            return
          }

          // キャッシュキー = base + 直下 iter_* ディレクトリの mtime 合計
          let mtimeSum = 0
          for (const d of readdirSync(evalDir)) {
            if (!d.startsWith('iter_')) continue
            mtimeSum += statSync(join(evalDir, d)).mtimeMs
          }
          const cacheKey = `${ckptBase}|${mtimeSum}`
          const hit = cache.get(filename)
          if (hit && hit.key === cacheKey) {
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('X-Stats-Cache', 'hit')
            res.end(hit.body)
            return
          }

          const cli = spawnSync(
            process.execPath,
            ['--experimental-strip-types', 'src/fenrir/src/stats/cli.ts', '--base', ckptBase],
            { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
          )
          if (cli.status !== 0) {
            res.statusCode = 500
            res.end(`stats CLI failed: ${cli.stderr || cli.error}`)
            return
          }
          cache.set(filename, { key: cacheKey, body: cli.stdout })
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('X-Stats-Cache', 'miss')
          res.end(cli.stdout)
        } catch (e) {
          res.statusCode = 500
          res.end(`stats middleware error: ${e}`)
        }
      })
    },
  }
}

/** demo/public/ の静的ファイルを SPA フォールバックより先に配信 */
function servePublicEarly(): Plugin {
  let base = '/horkew/'
  const publicDir = 'demo/public'
  const mimeTypes: Record<string, string> = {
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.js': 'application/javascript',
  }

  return {
    name: 'serve-public-early',
    configResolved(config) { base = config.base },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(base)) return next()
        const relative = decodeURIComponent(req.url.slice(base.length))
        const filePath = join(publicDir, relative)
        const ext = extname(filePath)
        if (!ext || !existsSync(filePath) || statSync(filePath).isDirectory()) return next()
        const content = readFileSync(filePath)
        res.setHeader('Content-Type', mimeTypes[ext] ?? 'application/octet-stream')
        res.end(content)
      })
    },
  }
}

export default defineConfig({
  plugins: [svelte({ configFile: '../svelte.config.js' }), serveInspect(), serveStats(), servePublicEarly(), serveScenarios(), servePretrainSnapshots()],
  root: 'demo',
  base: '/horkew/',
  server: { port: 5375, strictPort: true },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'demo/index.html'),
        overlay: resolve(__dirname, 'demo/overlay.html'),
      },
    },
  },
})
