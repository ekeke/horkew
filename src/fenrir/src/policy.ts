/**
 * Re-export shim — agents/ へのリダイレクト
 * Phase 8 で削除予定
 */

export { NeuralAgent as FenrirStrategy, computeRefPlanLogits } from './agents/neural-agent.ts'
export type { NeuralAgentConfig as FenrirStrategyConfig } from './agents/neural-agent.ts'
export { WolfTeamAgent as WolfTeamStrategy } from './agents/wolf-collective.ts'
export { WolfCollective as WolfCollectiveStrategy } from './agents/wolf-collective.ts'
export { MasonTeamAgent as MasonTeamStrategy } from './agents/mason-collective.ts'
export { MasonCollective as MasonCollectiveStrategy } from './agents/mason-collective.ts'
export { FanaticAgent as FanaticStrategy } from './agents/fanatic-agent.ts'
