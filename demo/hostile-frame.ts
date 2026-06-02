import { mount } from 'svelte'
import HostileFrame from './HostileFrame.svelte'

type Mode = 'baseline' | 'defended' | 'undefended'

const params = new URLSearchParams(window.location.search)
const raw = params.get('mode') ?? 'baseline'
const mode: Mode = raw === 'defended' || raw === 'undefended' ? raw : 'baseline'

// 敵対 host CSS を <head> に注入する (defended / undefended で適用)。
// 受け入れ条件で指定された 5 規則をそのまま再現。
function injectHostileCss() {
  const style = document.createElement('style')
  style.id = 'hostile-css'
  style.textContent = `
    * { box-sizing: content-box; }
    table { border-collapse: separate; border-spacing: 4px; }
    button, input { font-family: "Comic Sans MS"; font-size: 20px; }
    body { line-height: 2.4; font-family: serif; text-align: center; color: hotpink; }
    ul, ol { list-style: square; padding-left: 40px; }
  `
  document.head.appendChild(style)
}

if (mode !== 'baseline') injectHostileCss()

const app = mount(HostileFrame, {
  target: document.getElementById('app')!,
})

// undefended では mount 後に lykaon の防御 class を全部剥がす (lykaon の公開 API は触らず DOM 直接操作で)。
// MutationObserver で動的追加 (PlayerDialog 等) にも追従する。
if (mode === 'undefended') {
  const strip = () => document.querySelectorAll('.lyk-pane').forEach(el => el.classList.remove('lyk-pane'))
  queueMicrotask(strip)
  new MutationObserver(strip).observe(document.body, { childList: true, subtree: true })
}

export default app
