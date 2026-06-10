<script lang="ts">
  /*
   * AnalysisErrorBanner — preprocess / parse / bridge の例外を UI に出す。
   *
   * これらの段階で throw されると VillageStatus が組み立てられず、 StatusPane や
   * AnalysisTable は何も描画しない (= ペインが「空」 に見える)。 黙って空になると
   * ユーザーは原因に気付けないので、 ctx の error state を読んで赤い banner に
   * メッセージをそのまま出す。 throw メッセージには `(line N)` のような位置ヒントが
   * 含まれている前提 (howl bridge / parser はその規約)。
   *
   * 表示優先度: preprocess → parse → bridge (上流の方を先に出す)。
   */
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'

  let { ctx }: { ctx: AnalysisContext } = $props()

  type ErrorView = { stage: 'preprocess' | 'parse' | 'bridge', message: string } | null

  let view = $derived.by<ErrorView>(() => {
    if (ctx.preprocessError) return { stage: 'preprocess', message: ctx.preprocessError.message }
    if (ctx.parseError)      return { stage: 'parse',      message: ctx.parseError.message }
    if (ctx.bridgeError)     return { stage: 'bridge',     message: ctx.bridgeError.message }
    return null
  })

  const STAGE_LABEL: Record<'preprocess' | 'parse' | 'bridge', string> = {
    preprocess: '前処理エラー',
    parse:      'howl 構文エラー',
    bridge:     '解析準備エラー',
  }
</script>

{#if view}
  <div class="lyk-error-banner" role="alert">
    <div class="stage">{STAGE_LABEL[view.stage]}</div>
    <div class="message">{view.message}</div>
  </div>
{/if}

<style>
  .lyk-error-banner {
    padding: 8px 12px;
    background: var(--color-wolf-bg-tint);
    border-bottom: 2px solid var(--color-error);
    color: var(--color-text);
    font-family: var(--font-ui);
    font-size: 13px;
    line-height: 1.5;
  }
  .stage {
    color: var(--color-error);
    font-weight: 600;
    font-size: 12px;
    margin-bottom: 2px;
  }
  .message {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono, monospace);
  }
</style>
