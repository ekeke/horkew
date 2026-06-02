import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

export const howlThemeExtension: Extension = EditorView.theme({
  '&': {
    backgroundColor: 'var(--color-bg)',
    color: 'var(--color-editor-text)',
    fontFamily: 'var(--font-mono)',
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
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--color-selection)',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
    boxShadow: 'inset 0 -1px 0 color-mix(in srgb, var(--color-text) 15%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--color-text)',
    fontWeight: 'bold',
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
    scrollbarWidth: 'none', // Firefox
  },
  '.cm-scroller::-webkit-scrollbar': {
    display: 'none', // Chrome / Safari / Edge
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

  '.hwl-unknown':  { textDecoration: 'wavy underline var(--color-editor-unresolved)', textUnderlineOffset: '3px' },
  '.hw-beyond-cursor': { opacity: '0.35' },
  '.hw-join-name':         { color: 'var(--color-vote-arrow)', fontWeight: 'bold' },
  '.hw-player-resolved':   { color: 'var(--color-editor-resolved)' },
  '.hw-player-unresolved': { textDecoration: 'wavy underline var(--color-editor-unresolved)', textUnderlineOffset: '3px' },

  // Timestamp seek gutter
  '.hwl-gutter': {
    width: '1.5em',
  },
  '.hwl-gutter .cm-gutterElement': {
    padding: '0',
  },
  '.hwg-seek': {
    display: 'block',
    width: '100%',
    padding: '0 2px',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-accent)',
    fontSize: '11px',
    lineHeight: '18px',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'var(--font-mono)',
  },
  '.hwg-seek:hover': {
    background: 'var(--color-accent)',
    color: 'var(--color-bg)',
  },

  // Autocomplete tooltip
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    fontFamily: 'var(--font-mono)',
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
    fontFamily: 'var(--font-mono)',
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    marginLeft: '4px',
  },
  '.cm-completionIcon': {
    display: 'none',
  },
}, { dark: true })
