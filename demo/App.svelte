<script lang="ts">
  import { parse } from '../src/howl/index.ts'
  import { buildVillageStatus } from '../src/howl/bridge.ts'
  import { VillageRetar } from '../src/retar/index.ts'

  let input = $state(`---
title: Demo
---

+A、B、C、D、E、F、G、H、I、J、K、L、M

噛み A

B 占いCO C白
D 占いCO E白

F 霊CO

共有 G H

B D黒

吊り D

噛み G

B E白
F 白

吊り I

噛み J

F 黒

吊り K

村勝利
`)

  let output = $state('')

  function run() {
    try {
      const { meta, statements } = parse(input)
      console.log('=== Parsed Statements ===', statements)

      const { vs, setup, players } = buildVillageStatus(statements, meta)
      console.log('=== VillageStatus ===', vs)
      console.log('=== Setup ===', setup)
      console.log('=== Players ===', players)

      const options = {
        seerClaimingDueDate: 2,
        mediumClaimingDueDate: 2,
        bodyguardClaimingDueDate: 99,
        masonClaimingDueDate: 2,
        nekomataClaimingDueDate: 99,
        dayCountFrom: 1,
        hasFirstGhost: false,
        assumptions: new Map(),
        hocusPocus: new Map(),
        id: 0,
        batches: 1,
        batch: 0,
      }

      const retar = new VillageRetar(vs, setup, options)
      const result = retar.analyze()
      console.log('=== Retar Result ===', result)

      if (result && 'result' in result) {
        const lines: string[] = []
        for (const [seat, roles] of result.result) {
          const name = players.get(seat) ?? `#${seat}`
          lines.push(`${name}: ${[...roles].join(', ')}`)
        }
        output = lines.join('\n')
      }
    } catch (e: any) {
      console.error(e)
      output = `Error: ${e.message}`
    }
  }
</script>

<main>
  <h1>Horkew Demo</h1>
  <textarea bind:value={input} rows="25" cols="60"></textarea>
  <div>
    <button onclick={run}>Parse & Analyze</button>
  </div>
  <pre>{output}</pre>
</main>

<style>
  main {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
    font-family: system-ui, sans-serif;
  }
  textarea {
    width: 100%;
    font-family: monospace;
    font-size: 14px;
  }
  button {
    margin: 1rem 0;
    padding: 0.5rem 1rem;
    font-size: 16px;
    cursor: pointer;
  }
  pre {
    background: #f5f5f5;
    padding: 1rem;
    overflow-x: auto;
    white-space: pre-wrap;
  }
</style>
