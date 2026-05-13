<script lang="ts">
  import type { EnumSpecies } from '../../types/index.ts'

  let { species }: { species: EnumSpecies } = $props()
</script>

{#if species === 'human'}
  <svg class="species-icon" viewBox="0 0 10 10" aria-label="○"><circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
{:else if species === 'wolf'}
  <svg class="species-icon" viewBox="0 0 10 10" aria-label="●"><circle cx="5" cy="5" r="4.5" fill="currentColor" /></svg>
{/if}

<style>
  .species-icon {
    width: 1em;
    height: 1em;
    vertical-align: -0.05em;
    display: inline-block;
  }
</style>
