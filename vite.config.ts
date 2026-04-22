import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, extname, resolve } from 'node:path'

const scenariosSrc = 'src/retar/scenarios'
const skollModelsSrc = 'src/skoll/models'
const skollZeroModelsSrc = 'tmp/skoll-zero-multi-v1'
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

/** src/skoll/models/*.json を /horkew/models/ で配信 */
function serveSkollModels(): Plugin {
  let base = '/horkew/'
  return {
    name: 'serve-skoll-models',
    configResolved(config) { base = config.base },
    configureServer(server) {
      const prefix = `${base}models/`
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next()
        const filename = decodeURIComponent(req.url.slice(prefix.length))
        try {
          const content = readFileSync(join(skollModelsSrc, filename), 'utf-8')
          res.setHeader('Content-Type', 'application/json')
          res.end(content)
        } catch {
          next()
        }
      })
    },
    generateBundle() {
      if (!existsSync(skollModelsSrc)) return
      const files = readdirSync(skollModelsSrc).filter(f => f.endsWith('.json'))
      for (const file of files) {
        this.emitFile({
          type: 'asset',
          fileName: `models/${file}`,
          source: readFileSync(join(skollModelsSrc, file), 'utf-8'),
        })
      }
    },
  }
}

/**
 * skoll-zero の学習済みモデル (tmp/skoll-zero-multi-v1/{slot}/final.json) を
 * /horkew/models/zero/{slot}.json で配信。
 * 学習成果物なので dev のみ (build 時は未コミットのため emit しない)。
 */
function serveSkollZeroModels(): Plugin {
  let base = '/horkew/'
  return {
    name: 'serve-skoll-zero-models',
    configResolved(config) { base = config.base },
    configureServer(server) {
      const prefix = `${base}models/zero/`
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next()
        const filename = decodeURIComponent(req.url.slice(prefix.length))
        const slot = filename.replace(/\.json$/, '')
        const filePath = join(skollZeroModelsSrc, slot, 'final.json')
        if (!existsSync(filePath)) return next()
        try {
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

/**
 * Huginn 学習済みチェックポイントの配信。dev only。
 *
 * 最新 mtime の tmp/orch-huginn-* を自動選択する。
 *
 * ルート:
 *   /horkew/models/huginn/final.json
 *     → tmp/orch-huginn-*/phases/00-huginn/ckpt-huginn/final.json (mix 学習、実プレイ用)
 *   /horkew/models/huginn/scenarios/{name}.json
 *     → tmp/orch-huginn-*/phases/00-huginn/ckpt-huginn-{name}/final.json (scenario 別、評価用)
 */
function serveHuginnModels(): Plugin {
  let base = '/horkew/'

  const findLatestOrchHuginnBases = (): string[] => {
    if (!existsSync(orchBase)) return []
    return readdirSync(orchBase)
      .filter(d => d.startsWith('orch-huginn-'))
      .map(d => join(orchBase, d))
      .filter(p => existsSync(p) && statSync(p).isDirectory())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  }

  return {
    name: 'serve-huginn-models',
    configResolved(config) { base = config.base },
    configureServer(server) {
      const scenarioPrefix = `${base}models/huginn/scenarios/`
      const mixPath = `${base}models/huginn/final.json`
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        // mix 統合 NN
        if (req.url === mixPath || req.url.startsWith(`${mixPath}?`)) {
          try {
            for (const baseDir of findLatestOrchHuginnBases()) {
              const finalPath = join(baseDir, 'phases', '00-huginn', 'ckpt-huginn', 'final.json')
              if (existsSync(finalPath)) {
                res.setHeader('Content-Type', 'application/json')
                res.end(readFileSync(finalPath, 'utf-8'))
                return
              }
            }
          } catch { /* fall through */ }
          return next()
        }
        // scenario 別 NN
        if (req.url.startsWith(scenarioPrefix)) {
          const filename = decodeURIComponent(req.url.slice(scenarioPrefix.length))
          const scenarioName = filename.replace(/\.json$/, '')
          try {
            for (const baseDir of findLatestOrchHuginnBases()) {
              const finalPath = join(baseDir, 'phases', '00-huginn', `ckpt-huginn-${scenarioName}`, 'final.json')
              if (existsSync(finalPath)) {
                res.setHeader('Content-Type', 'application/json')
                res.end(readFileSync(finalPath, 'utf-8'))
                return
              }
            }
          } catch { /* fall through */ }
          return next()
        }
        return next()
      })
    },
  }
}

/**
 * Phase 2 pretrained checkpoints (tmp/phase2-pretrain-v1/{role}-{method}.json) を
 * /horkew/models/phase2/{file}.json で配信。dev only（tmp/ は .gitignore）。
 */
function servePhase2Models(): Plugin {
  let base = '/horkew/'
  const phase2Dir = 'tmp/phase2-pretrain-v1'
  return {
    name: 'serve-phase2-models',
    configResolved(config) { base = config.base },
    configureServer(server) {
      const prefix = `${base}models/phase2/`
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next()
        const filename = decodeURIComponent(req.url.slice(prefix.length))
        const filePath = join(phase2Dir, filename)
        if (!existsSync(filePath)) return next()
        try {
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
  plugins: [svelte({ configFile: '../svelte.config.js' }), serveInspect(), serveStats(), servePublicEarly(), serveScenarios(), serveSkollModels(), serveSkollZeroModels(), servePhase2Models(), serveHuginnModels(), servePretrainSnapshots()],
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
  worker: {
    // 'es' 形式を使用: top-level await（retar-bridge の wasm ロード）を許可するため
    format: 'es',
  },
})
