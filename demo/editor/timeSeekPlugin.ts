import { ViewPlugin, Decoration, WidgetType, type DecorationSet, type ViewUpdate, EditorView } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

function parseTimestamp(s: string): number {
  const parts = s.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] ?? 0
}

let onSeek: ((seconds: number, line: number) => void) | undefined

export function setOnSeek(fn: (seconds: number, line: number) => void) {
  onSeek = fn
}

class TimeSeekWidget extends WidgetType {
  constructor(readonly seconds: number, readonly label: string, readonly line: number) { super() }
  toDOM() {
    const btn = document.createElement('button')
    btn.textContent = `\u25B6 ${this.label}`
    btn.className = 'cm-time-seek'
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onSeek?.(Math.max(0, this.seconds - 3), this.line)
    })
    return btn
  }
  ignoreEvent() { return false }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i)
    const m = line.text.match(/[@\uFF20](\d{1,2}(?::\d{2}){1,2})\s*$/)
    if (m) {
      builder.add(line.to, line.to, Decoration.widget({
        widget: new TimeSeekWidget(parseTimestamp(m[1]), m[1], i),
        side: 1,
      }))
    }
  }
  return builder.finish()
}

export const timeSeekPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) {
    this.decorations = buildDecorations(view)
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.transactions.some(t => t.effects.length > 0)) {
      this.decorations = buildDecorations(update.view)
    }
  }
}, {
  decorations: v => v.decorations,
})
