import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'

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
  plugins: [svelte({ configFile: '../svelte.config.js' }), servePublicEarly(), serveScenarios()],
  root: 'demo',
  base: '/horkew/',
  server: { port: 5375, strictPort: true, allowedHosts: ['zinrou.test'] },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'demo/index.html'),
        overlay: resolve(__dirname, 'demo/overlay.html'),
        plain: resolve(__dirname, 'demo/plain.html'),
        hostile: resolve(__dirname, 'demo/hostile.html'),
        hostileFrame: resolve(__dirname, 'demo/hostile-frame.html'),
      },
    },
  },
  worker: {
    // 'es' 形式を使用: top-level await（retar-bridge の wasm ロード）を許可するため
    format: 'es',
  },
})
