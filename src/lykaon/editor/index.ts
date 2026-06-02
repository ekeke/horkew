import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, tooltips } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { completionKeymap } from '@codemirror/autocomplete'
import { howlLanguageExtension } from './howlLanguage.ts'
import { howlThemeExtension } from './howlTheme.ts'
import { howlCompletionExtension } from './howlCompletion.ts'

export { EditorView } from '@codemirror/view'
export { setStatements, setOnSeek, type StatementInfo, type HighlightPayload, type PlayerNameInfo } from './howlLanguage.ts'
export { setPlayerList, setSetup, setCurrentDay, setGameStats, setVideoTimeGetter, type PlayerEntry } from './howlCompletion.ts'

import type { Extension } from '@codemirror/state'

const editableCompartment = new Compartment()

export function setEditable(view: EditorView, editable: boolean) {
  view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(editable)) })
}

export function createHowlEditor(parent: HTMLElement, opts: {
  doc: string
  onChange: (value: string) => void
  onCursorChange: (line: number) => void
  extensions?: Extension[]
}): EditorView {
  const state = EditorState.create({
    doc: opts.doc,
    extensions: [
      // autocomplete tooltip を `.editor-pane` (= `.lyk-pane`) 配下に portal して
      // host CSS 流入を遮断する (default は body 直下 = 防御の外側)。
      tooltips({ parent }),
      howlLanguageExtension,
      howlThemeExtension,
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      howlCompletionExtension,
      EditorView.lineWrapping,
      editableCompartment.of(EditorView.editable.of(true)),
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
      ...(opts.extensions ?? []),
    ],
  })

  return new EditorView({ state, parent })
}
