import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { howlLanguage } from './howlLanguage.ts'
import { howlThemeExtension, howlHighlighting } from './howlTheme.ts'

export { EditorView } from '@codemirror/view'

export function createHowlEditor(parent: HTMLElement, opts: {
  doc: string
  onChange: (value: string) => void
  onCursorChange: (line: number) => void
}): EditorView {
  const state = EditorState.create({
    doc: opts.doc,
    extensions: [
      howlLanguage,
      howlThemeExtension,
      howlHighlighting,
      history(),
      drawSelection(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          opts.onChange(update.state.doc.toString())
        }
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head
          const line = update.state.doc.lineAt(head).number
          opts.onCursorChange(line)
        }
      }),
    ],
  })

  return new EditorView({ state, parent })
}
