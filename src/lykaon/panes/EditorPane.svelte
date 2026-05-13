<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { EditorView } from '@codemirror/view'
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'

  let { ctx, readonly = false }: {
    ctx: AnalysisContext
    readonly?: boolean
  } = $props()

  let editorParent = $state<HTMLDivElement | undefined>(undefined)
  let editorView = $state<EditorView | undefined>(undefined)
  let editorModule = $state<typeof import('../editor/index.ts') | undefined>(undefined)

  // Initialize CodeMirror once the parent <div> is mounted.
  $effect(() => {
    if (!editorParent) return
    if (editorView) return
    const parent = editorParent
    import('../editor/index.ts').then(mod => {
      if (editorView) return
      editorModule = mod

      // Seek wiring (gutter ▶ button → ctx.emitSeek listeners).
      // Note: setOnSeek is module-global; multiple EditorPane instances will share state.
      mod.setOnSeek((seconds, line) => {
        ctx.emitSeek({ seconds, line })
      })

      editorView = mod.createHowlEditor(parent, {
        doc: ctx.howlText,
        onChange(value) {
          ctx.howlText = value
        },
        onCursorChange(line) {
          ctx.cursorLine = line
        },
      })
    })
  })

  // External writes to ctx.howlText → push into the editor doc.
  $effect(() => {
    const text = ctx.howlText
    if (!editorView) return
    const current = editorView.state.doc.toString()
    if (current === text) return
    editorView.dispatch({
      changes: { from: 0, to: current.length, insert: text },
    })
  })

  // Readonly toggle.
  $effect(() => {
    if (!editorView || !editorModule) return
    editorModule.setEditable(editorView, !readonly)
  })

  // pane → editor jump bus.
  $effect(() => {
    if (!editorView) return
    const view = editorView
    const unsubscribe = ctx.onJump(({ line, column }) => {
      const doc = view.state.doc
      if (line < 1 || line > doc.lines) return
      const lineInfo = doc.line(line)
      const pos = column != null ? Math.min(lineInfo.from + column, lineInfo.to) : lineInfo.from
      view.dispatch({
        selection: { anchor: pos, head: pos },
        scrollIntoView: true,
      })
      view.focus()
    })
    return unsubscribe
  })

  onDestroy(() => {
    editorView?.destroy()
    editorView = undefined
  })
</script>

<div class="editor-pane" bind:this={editorParent}></div>

<style>
  .editor-pane {
    height: 100%;
    overflow: auto;
  }
</style>
