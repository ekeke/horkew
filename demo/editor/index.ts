import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { completionKeymap } from '@codemirror/autocomplete'
import { howlLanguageExtension, setStatements, type StatementInfo } from './howlLanguage.ts'
import { howlThemeExtension } from './howlTheme.ts'
import { howlCompletionExtension, setPlayerList } from './howlCompletion.ts'

export { EditorView } from '@codemirror/view'
export { setStatements, type StatementInfo, type HighlightPayload, type PlayerNameInfo } from './howlLanguage.ts'
export { setPlayerList, setSetup, type PlayerEntry } from './howlCompletion.ts'

export function createHowlEditor(parent: HTMLElement, opts: {
  doc: string
  onChange: (value: string) => void
  onCursorChange: (line: number) => void
}): EditorView {
  const state = EditorState.create({
    doc: opts.doc,
    extensions: [
      howlLanguageExtension,
      howlThemeExtension,
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      howlCompletionExtension,
      keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap]),
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
