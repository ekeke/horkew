import { parse } from '../src/howl/index.ts'
import { buildVillageStatus } from '../src/howl/bridge.ts'
import { VillageRetar } from '../src/retar/index.ts'

export type AnalysisRequest = {
  input: string
}

export type AnalysisResponse =
  | { type: 'result'; rawStatements: string; analysisOutput: string }
  | { type: 'error'; message: string }

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  try {
    const { input } = e.data

    const { meta, statements } = parse(input)
    const rawStatements = JSON.stringify(statements, null, 2)
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

    let analysisOutput = ''
    if (result && 'result' in result) {
      const lines: string[] = []
      for (const [seat, roles] of result.result) {
        const name = players.get(seat) ?? `#${seat}`
        lines.push(`${name}: ${[...roles].join(', ')}`)
      }
      analysisOutput = lines.join('\n')
    }

    self.postMessage({ type: 'result', rawStatements, analysisOutput } satisfies AnalysisResponse)
  } catch (e: any) {
    console.error(e)
    self.postMessage({ type: 'error', message: e.message } satisfies AnalysisResponse)
  }
}
