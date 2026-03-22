import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

// Catppuccin Mocha palette
const base     = '#1e1e2e'
const surface0 = '#313244'
const overlay0 = '#6c7086'
const text     = '#cdd6f4'
const subtext0 = '#a6adc8'
const purple   = '#cba6f7'
const blue     = '#89b4fa'
const yellow   = '#f9e2af'
const green    = '#a6e3a1'
const red      = '#f38ba8'
const peach    = '#fab387'

export const howlThemeExtension: Extension = EditorView.theme({
  '&': {
    backgroundColor: base,
    color: text,
    fontFamily: "'Consolas', 'Menlo', monospace",
    fontSize: '13px',
    lineHeight: '1.5',
    height: '100%',
  },
  '.cm-content': {
    padding: '8px 12px',
    caretColor: text,
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: text,
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: surface0,
  },
  '.cm-activeLine': {
    backgroundColor: `${surface0}80`,
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },

  // Inline token marks
  '.hw-comment':  { color: overlay0, fontStyle: 'italic' },
  '.hw-meta':     { color: overlay0 },
  '.hw-keyword':  { color: purple },
  '.hw-arrow':    { color: blue },
  '.hw-role':     { color: yellow },
  '.hw-human':    { color: green },
  '.hw-wolf':     { color: red },
  '.hw-co':       { color: purple },
  '.hw-over':     { color: peach },
}, { dark: true })
