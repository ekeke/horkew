<script lang="ts">
  import type { EnumSpecies } from '../../types/index.ts'

  let { species }: { species: EnumSpecies } = $props()
</script>

{#if species === 'human'}
  <span class="species-icon-wrap"><span class="species-ghost">○</span><svg class="species-icon" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg></span>
{:else if species === 'wolf'}
  <span class="species-icon-wrap"><span class="species-ghost">●</span><svg class="species-icon" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4.5" fill="currentColor" /></svg></span>
{:else if species === 'kogitsune'}
  <span class="species-text" aria-label="子狐">子狐</span>
{/if}

<style>
  .species-icon-wrap {
    position: relative;
    display: inline-block;
    line-height: 1;
  }
  /* ○/● 文字を通常の inline-block として置き、ラップの baseline を
     この文字の baseline に追従させる。これにより flex (align-items: baseline)
     でも非 flex の文中でも、 周囲の文字と同じ高さに揃う。
     色は transparent で見た目は出ないが、 範囲選択で ○/● 文字が
     クリップボードに乗る。 */
  .species-ghost {
    display: inline-block;
    width: 1em;
    height: 1em;
    font-size: 1em;
    line-height: 1em;
    color: transparent;
    user-select: text;
    text-align: center;
  }
  /* SVG はゴースト文字に重ねる視覚レイヤー。 ゴーストと同サイズで覆い、
     クリックがゴーストに届くよう pointer-events を切る。 */
  .species-icon {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .species-text {
    font-size: 0.85em;
    display: inline-block;
  }
</style>
