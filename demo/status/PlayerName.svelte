<script lang="ts">
  import type { Snippet } from 'svelte'

  let { dead, nightKill = false, executed = false, children }: {
    dead: boolean
    nightKill?: boolean
    executed?: boolean
    children: Snippet
  } = $props()
</script>

{#if nightKill}
  <span class="night-kill" class:dead>
    <span class="sizer">{@render children()}</span>
    <span class="strip s0">{@render children()}</span>
    <span class="strip s1">{@render children()}</span>
    <span class="strip s2">{@render children()}</span>
    <span class="strip s3">{@render children()}</span>
  </span>
{:else if executed}
  <span class="executed" class:dead>
    <span class="exec-sizer">{@render children()}</span>
    <span class="exec-sharp">{@render children()}</span>
    <span class="exec-blur">{@render children()}</span>
  </span>
{:else}
  <span class="pn" class:dead={dead}>{@render children()}</span>
{/if}

<style>
  .dead {
    opacity: 0.5;
    text-decoration: line-through;
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
    color: #cdd6f4;
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
