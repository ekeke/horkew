<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { EditorView } from '@codemirror/view'
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'
  import type { StatementInfo } from '../editor/howlLanguage.ts'
  import type { Statement } from '../../howl/statement.ts'
  import { buildPlayerNames } from '../editor/playerNames.ts'

  let { ctx, readonly = false }: {
    ctx: AnalysisContext
    readonly?: boolean
  } = $props()

  function toStmtInfo(s: Statement): StatementInfo {
    const stmt = s as Statement & Record<string, unknown>
    const info: StatementInfo = { type: stmt.type as StatementInfo['type'], line: s.line }
    if (stmt.type === 'videoSource') info.timestamp = { seconds: 0, raw: '0:00' }
    else if (stmt.type === 'timestamp') info.timestamp = { seconds: stmt.seconds as number, raw: stmt.raw as string }
    else if (stmt.timestamp !== undefined) {
      const ts = stmt.timestamp as number
      const m = Math.floor(ts / 60)
      const sec = ts % 60
      info.timestamp = { seconds: ts, raw: `${m}:${String(sec).padStart(2, '0')}` }
    }
    return info
  }

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

  // ctx state → CodeMirror effects (syntax highlight / completion).
  $effect(() => {
    const view = editorView
    const mod = editorModule
    if (!view || !mod) return
    const statements = ctx.statements
    const fullStatements = ctx.fullStatements
    const vs = ctx.villageStatus
    const setup = ctx.setup
    const dict = ctx.dict
    const cursorLine = ctx.cursorLine

    const stmtInfo = statements.map(toStmtInfo)
    const allStmtInfo = fullStatements.map(toStmtInfo)
    const playerNames = dict ? buildPlayerNames(statements, dict, view.state.doc.toString()) : []

    const playerList: { name: string, shortName?: string, aliases: string[], surviving: boolean, claimingRole?: string }[] = []
    let seat = 1
    for (const s of statements) {
      const stmt = s as Statement & Record<string, unknown>
      if (stmt.type === 'join') {
        const status = vs?.statuses.get(seat)
        playerList.push({
          name: stmt.name as string,
          shortName: stmt.shortName as string | undefined,
          aliases: (stmt.aliases as string[] | undefined) ?? [],
          surviving: status?.surviving ?? true,
          claimingRole: status?.claiming ? status.claimingRole : undefined,
        })
        seat++
      } else if (stmt.type === 'joinMulti') {
        for (const p of (stmt.players as string[])) {
          const status = vs?.statuses.get(seat)
          playerList.push({
            name: p,
            aliases: [],
            surviving: status?.surviving ?? true,
            claimingRole: status?.claiming ? status.claimingRole : undefined,
          })
          seat++
        }
      }
    }

    view.dispatch({
      effects: [
        mod.setStatements.of({ statements: stmtInfo, allStatements: allStmtInfo, cursorLine, playerNames }),
        mod.setPlayerList.of(playerList),
        mod.setSetup.of(setup),
        mod.setCurrentDay.of(vs?.day ?? 1),
        mod.setGameStats.of({ day: vs?.day ?? 1, executions: vs?.executions.size ?? 0 }),
      ],
    })
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
