<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Writable } from 'svelte/store'
  import { getContext } from 'svelte'
  import type { NameStatus } from './playerStatus.ts'

  let { dead, nightKill = false, executed = false, claim, seat, status = 'default', showClaim = true, outline = false, children }: {
    dead: boolean
    nightKill?: boolean
    executed?: boolean
    claim?: string
    seat?: number
    status?: NameStatus
    showClaim?: boolean
    outline?: boolean
    children: Snippet
  } = $props()

  const onplayerclick = getContext<((seat: number) => void) | undefined>('playerclick')
  const hoveredSeat = getContext<Writable<number | null> | undefined>('hoveredSeat')
  const shortNamesStore = getContext<Writable<Map<number, string>> | undefined>('shortNames')
  let clickable = $derived(seat != null && onplayerclick != null)
  let highlighted = $derived(seat != null && hoveredSeat != null && $hoveredSeat === seat)
  let displayShortName = $derived.by(() => {
    if (seat == null || !shortNamesStore) return undefined
    return $shortNamesStore!.get(seat)
  })
  let effectiveClaim = $derived(showClaim ? claim : undefined)

  function handleClick() {
    if (seat != null && onplayerclick) onplayerclick(seat)
  }

  function handleMouseEnter() {
    if (seat != null && hoveredSeat) hoveredSeat.set(seat)
  }

  function handleMouseLeave() {
    if (hoveredSeat) hoveredSeat.set(null)
  }
</script>

{#snippet nameText()}{#if displayShortName}{displayShortName}{:else}{@render children()}{/if}{/snippet}

{#snippet inner()}
  {#if nightKill}
    <span class="night-kill" class:dead>
      <span class="sizer">{@render nameText()}{#if effectiveClaim}<span class="claim">({effectiveClaim})</span>{/if}</span>
      <span class="strip s0">{@render nameText()}{#if effectiveClaim}<span class="claim">({effectiveClaim})</span>{/if}</span>
      <span class="strip s1">{@render nameText()}{#if effectiveClaim}<span class="claim">({effectiveClaim})</span>{/if}</span>
      <span class="strip s2">{@render nameText()}{#if effectiveClaim}<span class="claim">({effectiveClaim})</span>{/if}</span>
      <span class="strip s3">{@render nameText()}{#if effectiveClaim}<span class="claim">({effectiveClaim})</span>{/if}</span>
    </span>
  {:else if executed}
    <span class="executed" class:dead>
      <span class="exec-sizer">{@render nameText()}{#if effectiveClaim}<span class="claim">({effectiveClaim})</span>{/if}</span>
      <span class="exec-sharp">{@render nameText()}{#if effectiveClaim}<span class="claim">({effectiveClaim})</span>{/if}</span>
      <span class="exec-blur">{@render nameText()}{#if effectiveClaim}<span class="claim">({effectiveClaim})</span>{/if}</span>
    </span>
  {:else}
    <span class="pn" class:dead={dead} class:outline={outline}>{@render nameText()}{#if effectiveClaim}<span class="claim">({effectiveClaim})</span>{/if}</span>
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<span
  class="player-name-root"
  class:clickable
  class:highlighted
  class:status-village={status === 'village'}
  class:status-wolf={status === 'wolf'}
  class:status-fox={status === 'fox'}
  class:status-not-village={status === 'not-village'}
  onclick={clickable ? handleClick : undefined}
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
>{@render inner()}</span>

<style>
  .player-name-root {
    display: inline-block;
    white-space: nowrap;
  }

  /* 村陣営の可能性がゼロ (確実に人外) のとき、名前の文字色を赤系で警告。
     背景色は密度ペインで邪魔になるため使わない。村陣営可能性が残る状態
     (village / default) は通常テキスト色のまま。 */
  .status-wolf,
  .status-fox,
  .status-not-village {
    color: var(--color-wolf);
  }

  /* 退場済み + 人外確定: dead の text-faint が赤を打ち消すのを防ぐため、
     status × dead の組み合わせは暗赤に明示。赤情報を維持しつつトーンダウン
     感を出す。 */
  .status-wolf .dead,
  .status-fox .dead,
  .status-not-village .dead {
    color: color-mix(in srgb, var(--color-wolf) 20%, var(--color-text-faint));
  }

  .clickable {
    cursor: pointer;
    border-radius: 2px;
  }

  .clickable:hover {
    text-decoration: underline;
    text-decoration-color: var(--color-accent);
    text-underline-offset: 2px;
  }

  .highlighted {
    background-color: color-mix(in srgb, var(--color-accent) 25%, transparent);
    border-radius: 2px;
    text-shadow: 0 0 6px color-mix(in srgb, var(--color-accent) 70%, transparent);
  }

  /* CO 短縮名サフィックスは「直前のプレイヤー名と同じ色」になるよう、
     明示的な色指定を持たず親 .pn の color を継承する。
     これにより dead / outline / status-* など全状態で名前と一体感が出る。 */
  .claim {
    font-size: 0.85em;
    margin-left: 1px;
  }

  /* 退場済みは透明度ではなく文字色で表現。透明度だと bold が知覚的に
     痩せて見える錯覚を引き起こすため、color トーンダウンに切り替える。 */
  .dead {
    color: var(--color-text-faint);
  }

  /* 中抜き表示 (判定結果が ● のときなど)。 背景塗りは親要素 (.va-result.wolf
     等) 側で行う前提。 ここでは文字を --color-bg (= 背景色) でくり抜くだけ。
     specificity (.pn.outline = 0,2,0) が .dead (0,1,0) より高いので、
     outline モードでは dead の color オーバーライドより優先される。
     .claim も color 指定を持たないので、 そのまま --color-bg を継承して
     名前と一緒にくり抜かれる。 */
  .pn.outline {
    color: var(--color-bg);
  }

  .night-kill {
    display: inline-block;
    position: relative;
    vertical-align: baseline;
  }

  /* 視覚エフェクト用に名前テキストを多重複製しているため、選択コピーで
     名前が重複しないよう、 sizer をカノニカルな選択対象として残し、
     絶対配置の strips は user-select と pointer-events から除外する。
     sizer は visibility: hidden ではなく color: transparent にする
     (前者は一部ブラウザで選択範囲から除外され、 strips を user-select:none
     にすると結果ゼロコピーになるため)。 */
  .sizer {
    color: transparent;
    white-space: nowrap;
  }

  .strip {
    position: absolute;
    inset: 0;
    white-space: nowrap;
    color: inherit;
    user-select: none;
    pointer-events: none;
  }

  .executed {
    display: inline-block;
    position: relative;
    vertical-align: baseline;
  }

  .exec-sizer {
    color: transparent;
    white-space: nowrap;
  }

  .exec-sharp,
  .exec-blur {
    position: absolute;
    inset: 0;
    white-space: nowrap;
    user-select: none;
    pointer-events: none;
  }

  /* Excite skin: dissolve effect (sharp top → blurred bottom) */
  :global(.skin-excite) .executed.dead {
    opacity: 1;
    text-decoration: none;
  }

  :global(.skin-excite) .exec-sharp {
    mask-image: linear-gradient(to bottom, black 20%, transparent 80%);
    -webkit-mask-image: linear-gradient(to bottom, black 20%, transparent 80%);
  }

  :global(.skin-excite) .exec-blur {
    filter: blur(1.5px);
    mask-image: linear-gradient(to bottom, transparent 0%, black 60%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 60%);
    opacity: 0.5;
  }

  /* Excite skin: slash effect */
  :global(.skin-excite) .night-kill.dead {
    opacity: 1;
    text-decoration: none;
  }

  :global(.skin-excite) .s0 {
    clip-path: polygon(0% 0%, 25% 0%, 0% 100%);
  }
  :global(.skin-excite) .s1 {
    clip-path: polygon(25% 0%, 50% 0%, 25% 100%, 0% 100%);
    transform: translate(0, -1.5px) rotate(-5deg);
  }
  :global(.skin-excite) .s2 {
    clip-path: polygon(50% 0%, 75% 0%, 50% 100%, 25% 100%);
    transform: translate(0, 1.5px) rotate(10deg);
  }
  :global(.skin-excite) .s3 {
    clip-path: polygon(75% 0%, 100% 0%, 100% 100%, 50% 100%);
    transform: rotate(5deg);
  }
</style>
