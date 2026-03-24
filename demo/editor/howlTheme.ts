import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

export const howlThemeExtension: Extension = EditorView.theme({
  '&': {
    backgroundColor: 'var(--color-bg)',
    color: 'var(--color-editor-text)',
    fontFamily: "'Consolas', 'Menlo', monospace",
    fontSize: '13px',
    lineHeight: '1.5',
    height: '100%',
  },
  '.cm-content': {
    padding: '8px 12px',
    caretColor: 'var(--color-text)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--color-text)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--color-surface)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--ctp-surface0) 50%, transparent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-bg)',
    color: 'var(--color-text-overlay)',
    borderRight: '1px solid var(--color-border)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 4px',
    minWidth: '2.5em',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },

  // Inline token marks
  '.hw-comment':  { color: 'var(--color-text-overlay)', fontStyle: 'italic' },
  '.hw-meta':     { color: 'var(--color-text-overlay)' },
  '.hw-keyword':  { color: 'var(--color-accent)' },
  '.hw-arrow':    { color: 'var(--color-vote-arrow)' },
  '.hw-role':     { color: 'var(--color-role)' },
  '.hw-human':    { color: 'var(--color-human-result)' },
  '.hw-wolf':     { color: 'var(--color-wolf-result)' },
  '.hw-co':       { color: 'var(--color-co)' },
  '.hw-over':     { color: 'var(--color-execution)' },

  // Line-level backgrounds
  '.hwl-join':     { backgroundColor: 'color-mix(in srgb, var(--ctp-blue) 6%, transparent)' },
  '.hwl-lynch':    { backgroundColor: 'color-mix(in srgb, var(--ctp-peach) 6%, transparent)' },
  '.hwl-attack':   { backgroundColor: 'color-mix(in srgb, var(--ctp-red) 6%, transparent)' },
  '.hwl-curse':    { backgroundColor: 'color-mix(in srgb, var(--ctp-mauve) 6%, transparent)' },
  '.hwl-follow':   { backgroundColor: 'color-mix(in srgb, var(--ctp-overlay0) 6%, transparent)' },
  '.hwl-peace':    { backgroundColor: 'color-mix(in srgb, var(--ctp-green) 6%, transparent)' },
  '.hwl-unknown':  { textDecoration: 'wavy underline var(--color-editor-unresolved)', textUnderlineOffset: '3px', backgroundColor: 'color-mix(in srgb, var(--color-editor-unresolved) 13%, transparent)' },
  '.hw-beyond-cursor': { opacity: '0.35' },
  '.hw-join-name':         { color: 'var(--color-vote-arrow)', fontWeight: 'bold' },
  '.hw-player-resolved':   { backgroundColor: 'color-mix(in srgb, var(--color-editor-resolved) 13%, transparent)', color: 'var(--color-editor-resolved)' },
  '.hw-player-unresolved': { textDecoration: 'wavy underline var(--color-editor-unresolved)', textUnderlineOffset: '3px', backgroundColor: 'color-mix(in srgb, var(--color-editor-unresolved) 9%, transparent)' },

  // Statement type gutter (left of line numbers)
  '.hwl-gutter': {
    width: '1.5em',
    textAlign: 'center',
  },
  '.hwl-gutter .cm-gutterElement': {
    padding: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  '.hwl-gutter .cm-gutterElement span': { fontSize: '1em', lineHeight: '1' },
  '.hwg-unknown': { color: 'var(--color-editor-unresolved)' },

  // Autocomplete tooltip
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    fontFamily: "'Consolas', 'Menlo', monospace",
    fontSize: '13px',
  },
  '.cm-tooltip-autocomplete ul li': {
    padding: '2px 8px',
    color: 'var(--color-text)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  '.cm-completionDetail': {
    marginLeft: '1.5em',
    fontSize: '11px',
    color: 'var(--color-text-overlay)',
    fontStyle: 'normal',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--ctp-surface1)',
    color: 'var(--color-text)',
  },
  '.cm-completionInfo': {
    padding: '4px 8px',
    fontSize: '12px',
    color: 'var(--color-text)',
    fontFamily: "'Consolas', 'Menlo', monospace",
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    marginLeft: '4px',
  },
  '.cm-completionIcon': {
    display: 'none',
  },
}, { dark: true })
