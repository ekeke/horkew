/**
 * ckpt-base から推論専用 SlotMap を構築する共通ヘルパ。
 *
 * 学習側 ([phase/runner.ts] の `buildSlot`) と意味的に同じ NN 構造を Pure JS で組む。
 * 特に `SKOLLZ_WOLF_IMITATION=1` のとき wolf を `WolfImitationNetwork` で wrap し、
 * 同じ ckpt-base の village 重みを frozen として注入する (= 学習側で round 冒頭に
 * `syncWolfImitationFrozen` で行われている挙動を ckpt-load 時に再現)。
 *
 * self-play-howl CLI はこの関数経由で SlotMap を作る。これにより
 * 「ckpt をどう SlotMap に組むか」の経路が一本化され、学習側 NN 構造から乖離しない
 * (実例の再発防止: 2026-05-13 に self-play-howl が wolf を旧 `createWolfZeroNetwork`
 * で読んでいて、wolf imitation の deviation/α head がバイパスされていた問題)。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loadCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import type { AnyNetwork } from '../../fenrir/src/ml/nn.ts'
import { MasonZeroNetwork } from '../network/mason-zero.ts'
import { WolfImitationNetwork } from '../network/wolf-imitation-network.ts'
import {
  createSkollZeroNetwork,
  createStandardZeroNetwork,
  createWolfZeroNetwork,
  createWolfImitationZeroNetwork,
  createFanaticZeroNetwork,
} from '../network/config.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import type { SlotMap } from '../selfplay/multi-runner.ts'

export type EvalSlotsConfig = {
  /** phase dir (e.g. `tmp/orch-skollz-.../phases/00-skoll-zero`) */
  ckptBase: string
  /** null = final.json、整数なら round_NNNN/weights.json */
  round: number | null
}

function weightFileName(round: number | null): string {
  if (round == null) return 'final.json'
  return join(`round_${String(round).padStart(4, '0')}`, 'weights.json')
}

function loadInto<T extends AnyNetwork>(net: T, ckptBase: string, slotKey: string, fileName: string): T {
  const path = join(ckptBase, slotKey, fileName)
  if (!existsSync(path)) throw new Error(`${slotKey} ckpt not found: ${path}`)
  loadCheckpoint(net, path)
  return net
}

/**
 * ckpt-base から SlotMap を構築。Pure JS NN のみ (TF.js は使わない)。
 * SKOLLZ_WOLF_IMITATION env が学習時と同じ値であることを呼び出し側で保証すること。
 */
export function buildEvalSlots(cfg: EvalSlotsConfig): SlotMap {
  const fileName = weightFileName(cfg.round)
  const wolfImitation = process.env.SKOLLZ_WOLF_IMITATION === '1'

  const masonPure = loadInto(createSkollZeroNetwork(), cfg.ckptBase, 'mason', fileName)
  const villagePure = loadInto(createStandardZeroNetwork(), cfg.ckptBase, 'village', fileName)
  const wolfPure = loadInto(
    wolfImitation ? createWolfImitationZeroNetwork() : createWolfZeroNetwork(),
    cfg.ckptBase, 'wolf', fileName,
  )
  const fanaticPure = loadInto(createFanaticZeroNetwork(), cfg.ckptBase, 'fanatic', fileName)
  const hamsterPure = loadInto(createStandardZeroNetwork(), cfg.ckptBase, 'hamster', fileName)
  const immoralistPure = loadInto(createStandardZeroNetwork(), cfg.ckptBase, 'immoralist', fileName)

  // Wolf imitation の場合、frozen village 用に別 instance の village net をロード
  // (学習側 `syncWolfImitationFrozen` が round 冒頭に行う「同 ckpt の village 重みコピー」と等価)
  const frozenVillagePure = wolfImitation
    ? loadInto(createStandardZeroNetwork(), cfg.ckptBase, 'village', fileName)
    : null

  const wolfNN = wolfImitation && frozenVillagePure
    ? new WolfImitationNetwork(frozenVillagePure, wolfPure, { zeroValueHead: false })
    : new MasonZeroNetwork(wolfPure, { zeroValueHead: false })

  return {
    mason:      { nn: new MasonZeroNetwork(masonPure,      { zeroValueHead: false }), buffer: new TrainingBuffer() },
    village:    { nn: new MasonZeroNetwork(villagePure,    { zeroValueHead: false }), buffer: new TrainingBuffer() },
    wolf:       { nn: wolfNN, buffer: new TrainingBuffer() },
    fanatic:    { nn: new MasonZeroNetwork(fanaticPure,    { zeroValueHead: false }), buffer: new TrainingBuffer() },
    hamster:    { nn: new MasonZeroNetwork(hamsterPure,    { zeroValueHead: false }), buffer: new TrainingBuffer() },
    immoralist: { nn: new MasonZeroNetwork(immoralistPure, { zeroValueHead: false }), buffer: new TrainingBuffer() },
  }
}
