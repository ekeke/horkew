/**
 * MasonZeroAgent — mason 視点の zero agent。
 *
 * Agent 層は RoleZeroAgent の薄い wrapper、MCTS/NN 詳細は MasonSkollZeroModule に委譲。
 */

import { RoleZeroAgent, type RoleZeroAgentOptions } from './role-zero-agent.ts'
import { MasonSkollZeroModule } from '../module/mason-module.ts'

export type MasonZeroAgentOptions = RoleZeroAgentOptions

export class MasonZeroAgent extends RoleZeroAgent {
  constructor(opts: MasonZeroAgentOptions) {
    const module = new MasonSkollZeroModule({
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      determinizerMaxWorlds: opts.determinizerMaxWorlds,
      phase2Nets: opts.phase2Nets,
    })
    super(module, opts.selectionMode ?? 'sample')
  }
}
