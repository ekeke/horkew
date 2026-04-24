/**
 * MasonRoleAgent — mason 視点の zero agent。
 *
 * Agent 層は SkollZeroRoleAgent の薄い wrapper、MCTS/NN 詳細は MasonSkollZeroModule に委譲。
 */

import { SkollZeroRoleAgent, type SkollZeroRoleAgentOptions } from './role-zero-agent.ts'
import { MasonSkollZeroModule } from '../module/mason-module.ts'

export type MasonRoleAgentOptions = SkollZeroRoleAgentOptions

export class MasonRoleAgent extends SkollZeroRoleAgent {
  constructor(opts: MasonRoleAgentOptions) {
    const module = new MasonSkollZeroModule({
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      determinizerMaxWorlds: opts.determinizerMaxWorlds,
    })
    super(module, opts.selectionMode ?? 'sample')
  }
}
