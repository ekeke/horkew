<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Writable } from 'svelte/store'
  import { getContext } from 'svelte'
  import type { NameStatus } from './playerStatus.ts'

  let { dead, nightKill = false, executed = false, claim, seat, status = 'default', broken = false, showClaim = true, children }: {
    dead: boolean
    nightKill?: boolean
    executed?: boolean
    claim?: string
    seat?: number
    status?: NameStatus
    broken?: boolean
    showClaim?: boolean
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
    <span class="pn" class:dead={dead}>{@render nameText()}{#if effectiveClaim}<span class="claim">({effectiveClaim})</span>{/if}</span>
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
>{#if broken}<span class="broken-badge" title="推理矛盾">!</span>{/if}{@render inner()}</span>

<style>
  .player-name-root {
    display: inline-block;
    white-space: nowrap;
  }

  .status-village { background: var(--color-village-bg); }
  .status-wolf { background: var(--color-wolf-bg); }
  .status-fox { background: var(--color-fox-bg); }
  .status-not-village { background: var(--color-unknown-team-bg); }

  .broken-badge {
    display: inline-block;
    background: var(--color-wolf);
    color: var(--color-bg);
    font-weight: 900;
    font-family: var(--font-mono);
    font-size: 0.85em;
    padding: 0 4px;
    border-radius: 2px;
    margin-right: 3px;
    line-height: 1.2;
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

  .claim {
    color: var(--color-co);
    font-size: 0.85em;
    margin-left: 1px;
  }

  .dead {
    opacity: var(--opacity-dead-player);
  }

  .night-kill {
    display: inline-block;
    position: relative;
    vertical-align: baseline;
  }

  .sizer {
    visibility: hidden;
    white-space: nowrap;
  }

  .strip {
    position: absolute;
    inset: 0;
    white-space: nowrap;
    color: inherit;
  }

  .executed {
    display: inline-block;
    position: relative;
    vertical-align: baseline;
  }

  .exec-sizer {
    visibility: hidden;
    white-space: nowrap;
  }

  .exec-sharp,
  .exec-blur {
    position: absolute;
    inset: 0;
    white-space: nowrap;
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
