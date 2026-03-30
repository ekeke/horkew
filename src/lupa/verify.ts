/**
 * Lupa × Retar 検証スクリプト
 *
 * Lupaで生成したゲームをRetarに通し、
 * 真の役職がRetarの可能性集合から除外されていないことを検証する。
 *
 * Retarの前提条件:
 * - 村役職(占い/霊能/狩人/共有/猫又)がCOせずに処刑された場合、その役職を否定する
 * - 誰もCOしていない役職はテスト対象外とする
 * これらの前提に反するチェックポイントはスキップされる（連鎖的な影響があるため）
 *
 * 実行:
 *   npm run verify:retar                                    # 全シナリオ
 *   npm run verify:retar -- --outdir tmp/verify             # 失敗howl出力
 *   npm run verify:retar -- --scenario full-15p             # シナリオ指定
 *   npm run verify:retar -- --seed 114                      # 単一seed
 *   npm run verify:retar -- --seeds 100-200                 # seed範囲
 *   npm run verify:retar -- --scenario full-15p --seed 114  # 組み合わせ
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { deepStrictEqual } from 'node:assert'
import { join } from 'node:path'
import type { SystemRole } from '../types/index.ts'
import type { LupaConfig, GameEvent, GameState } from './types.ts'
import type { GameConfig as EngineGameConfig } from './handlers.ts'
import { runGame } from './engine.ts'
import { strategyAdapter } from './adapters/strategy-adapter.ts'
import { RandomStrategy } from './random-strategy.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions, AnalyzedPossibilities, AnalyzeResult } from '../retar/index.ts'
import { serializeVillageStatus, serializeOptions, parseWasmResult } from '../retar/wasm-helpers.ts'
import { buildAssumptions } from './retar-bridge.ts'
import { enableDump, disableDump, resetDump, getDump } from '../retar/dump.ts'

// WASM ロード（--compat 時のみ使用）
let wasmAnalyze: ((village: string, setup: string, options: string) => string) | null = null
try {
  const wasm = await import('../retar-rs/pkg/retar.js')
  wasmAnalyze = wasm.analyze
} catch {
  // WASM not available
}

const lupaOptions: AnalyzeOptions = {
  seerClaimingDueDate: 99,
  mediumClaimingDueDate: 99,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 99,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

const VILLAGE_ROLES: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']

type CheckpointType = 'post-execution' | 'post-morning'

type Checkpoint = {
  index: number
  type: CheckpointType
}

function findCheckpoints(events: GameEvent[]): Checkpoint[] {
  const checkpoints: Checkpoint[] = []
  const seen = new Set<number>()

  for (let i = 0; i < events.length; i++) {
    const e = events[i]

    if (e.type === 'execution') {
      let j = i + 1
      if (j < events.length && events[j].type === 'comment') j++
      while (j < events.length && (events[j].type === 'curse_kill' || events[j].type === 'follow_kill')) j++
      if (j < events.length && events[j].type === 'game_over') j++
      if (!seen.has(j)) {
        checkpoints.push({ index: j, type: 'post-execution' })
        seen.add(j)
      }
    }

    if (e.type === 'night_kill' || e.type === 'fox_kill' || e.type === 'peace') {
      let j = i + 1
      while (j < events.length && (
        events[j].type === 'night_kill' ||
        events[j].type === 'fox_kill' ||
        events[j].type === 'curse_kill' ||
        events[j].type === 'follow_kill'
      )) j++
      if (j < events.length && events[j].type === 'game_over') j++
      if (!seen.has(j)) {
        checkpoints.push({ index: j, type: 'post-morning' })
        seen.add(j)
      }
    }
  }

  return checkpoints
}

type FailedCheckpoint = {
  config: string
  seed: number
  checkpoint: Checkpoint
  howl: string
  players: { name: string, message: string }[]
}

type VerifyResult = {
  failure: FailedCheckpoint | null
  skipped: boolean
  retarMs: number
}

function verifyCheckpoint(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  checkpoint: Checkpoint,
  configName: string,
  seed: number,
): VerifyResult {
  const partialEvents = events.slice(0, checkpoint.index)
  const partialHowl = formatHowl(partialEvents, state, config)

  // パースチェック
  const { meta, statements } = parse(partialHowl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    const annotatedHowl = partialHowl.trimEnd() + '\n\n'
      + `# パース失敗: ${unknowns.map((s: any) => s.raw).join(', ')}\n`
    return {
      failure: {
        config: configName, seed, checkpoint, howl: annotatedHowl,
        players: [{ name: '(parse)', message: `unknown statements: ${unknowns.map((s: any) => s.raw).join(', ')}` }],
      },
      skipped: false, retarMs: 0,
    }
  }

  const { vs, setup } = buildVillageStatus(statements, meta)

  // Retarの前提条件チェック
  for (const player of state.players) {
    if (!VILLAGE_ROLES.includes(player.role)) continue
    const seatStatus = vs.statuses.get(player.seat)
    if (!seatStatus) continue
    if (!seatStatus.surviving && seatStatus.causeOfDeath === 'execution' && !seatStatus.claiming) {
      return { failure: null, skipped: true, retarMs: 0 }
    }
  }

  const options = config.hasFirstGhost
    ? { ...lupaOptions, hasFirstGhost: true }
    : lupaOptions
  const retar = new VillageRetar(vs, setup, options)
  const t0 = performance.now()
  const result = retar.analyze()
  const retarMs = performance.now() - t0

  if (result.error) {
    const annotatedHowl = partialHowl.trimEnd() + '\n\n'
      + `# analyze()エラー: ${result.error}\n`
    return {
      failure: {
        config: configName, seed, checkpoint, howl: annotatedHowl,
        players: [{ name: '(analyze)', message: `${result.error}` }],
      },
      skipped: false, retarMs,
    }
  }

  // 真の役職が可能性に含まれているか検証
  const failedPlayers: { name: string, trueRole: SystemRole, possibilities: Set<SystemRole> | undefined }[] = []

  for (const player of state.players) {
    const possibilities = result.result.get(player.seat)
    if (!possibilities || possibilities.size === 0) {
      failedPlayers.push({ name: player.name, trueRole: player.role, possibilities })
    } else if (!possibilities.has(player.role)) {
      failedPlayers.push({ name: player.name, trueRole: player.role, possibilities })
    }
  }

  if (failedPlayers.length === 0) {
    return { failure: null, skipped: false, retarMs }
  }

  // アノテーション付きhowlを生成
  const annotationLines: string[] = []
  const playerMessages: { name: string, message: string }[] = []
  for (const p of failedPlayers) {
    annotationLines.push(`# @expect ${p.name}: [${p.trueRole}...]`)
    if (p.possibilities && p.possibilities.size > 0) {
      annotationLines.push(`# 実際: [${[...p.possibilities].join(', ')}]`)
      playerMessages.push({ name: p.name, message: `真の役職 ${p.trueRole} が可能性 [${[...p.possibilities].join(', ')}] に含まれていない` })
    } else {
      annotationLines.push(`# 実際: 空`)
      playerMessages.push({ name: p.name, message: '可能性が空' })
    }
  }
  const annotatedHowl = partialHowl.trimEnd() + '\n\n' + annotationLines.join('\n') + '\n'

  return {
    failure: { config: configName, seed, checkpoint, howl: annotatedHowl, players: playerMessages },
    skipped: false, retarMs,
  }
}

/**
 * Prior検証: 各座席の真の役職をassumptionにしてprior再計算 → 他席の真の役職が矛盾しないか
 */
function verifyPriorCheckpoint(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  checkpoint: Checkpoint,
  configName: string,
  seed: number,
): VerifyResult {
  const partialEvents = events.slice(0, checkpoint.index)
  const partialHowl = formatHowl(partialEvents, state, config)

  const { meta, statements } = parse(partialHowl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    const annotatedHowl = partialHowl.trimEnd() + '\n\n'
      + `# パース失敗: ${unknowns.map((s: any) => s.raw).join(', ')}\n`
    return {
      failure: {
        config: configName, seed, checkpoint, howl: annotatedHowl,
        players: [{ name: '(parse)', message: `unknown statements: ${unknowns.map((s: any) => s.raw).join(', ')}` }],
      },
      skipped: false, retarMs: 0,
    }
  }

  const { vs, setup } = buildVillageStatus(statements, meta)

  // Retarの前提条件チェック
  for (const player of state.players) {
    if (!VILLAGE_ROLES.includes(player.role)) continue
    const seatStatus = vs.statuses.get(player.seat)
    if (!seatStatus) continue
    if (!seatStatus.surviving && seatStatus.causeOfDeath === 'execution' && !seatStatus.claiming) {
      return { failure: null, skipped: true, retarMs: 0 }
    }
  }

  const options = config.hasFirstGhost
    ? { ...lupaOptions, hasFirstGhost: true }
    : lupaOptions

  // ベースRetarを実行してprior（analyze結果）を取得
  const baseRetar = new VillageRetar(vs, setup, options)
  const baseResult = baseRetar.analyze()
  const prior = baseResult.result

  const t0 = performance.now()
  const failedPlayers: { name: string, message: string }[] = []

  // 各座席について: 真の役職をassumptionにしてprior再計算
  for (const player of state.players) {
    const assumptions = new Map<number, SystemRole>([[player.seat, player.role]])

    // priorに含まれない役職 → この座席はスキップ（ベースRetarの前提条件で既に除外済み）
    const priorRoles = prior.get(player.seat)
    if (!priorRoles || !priorRoles.has(player.role)) continue

    const priorRetar = new VillageRetar(vs, setup, { ...options, assumptions, prior })
    const result = priorRetar.analyzeSafe()

    if (result.error) {
      failedPlayers.push({ name: player.name, message: `analyze()エラー: ${result.error}` })
      continue
    }

    // 他の全座席について真の役職が可能性に含まれるか
    for (const other of state.players) {
      if (other.seat === player.seat) continue
      const possibilities = result.result.get(other.seat)
      if (!possibilities || !possibilities.has(other.role)) {
        const possStr = possibilities ? `[${[...possibilities].join(', ')}]` : '空'
        failedPlayers.push({
          name: player.name,
          message: `${player.name}=${player.role}仮定時、${other.name}の真の役職${other.role}が可能性${possStr}に含まれない`,
        })
        break
      }
    }
  }

  const retarMs = performance.now() - t0

  if (failedPlayers.length === 0) {
    return { failure: null, skipped: false, retarMs }
  }

  const annotatedHowl = partialHowl.trimEnd() + '\n\n'
    + failedPlayers.map(p => `# [prior] ${p.name}: ${p.message}`).join('\n') + '\n'

  return {
    failure: {
      config: configName, seed, checkpoint, howl: annotatedHowl,
      players: failedPlayers,
    },
    skipped: false, retarMs,
  }
}

/**
 * Compat検証: JS版とWASM版の出力が完全一致するか
 * 不一致時は dump を有効にして再実行し、最初に差異が出た中間ステップを特定する
 */
function verifyCompatCheckpoint(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  checkpoint: Checkpoint,
  configName: string,
  seed: number,
): VerifyResult {
  if (!wasmAnalyze) {
    return { failure: null, skipped: true, retarMs: 0 }
  }

  const partialEvents = events.slice(0, checkpoint.index)
  const partialHowl = formatHowl(partialEvents, state, config)

  const { meta, statements } = parse(partialHowl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    return { failure: null, skipped: true, retarMs: 0 }
  }

  const { vs, setup } = buildVillageStatus(statements, meta)

  const options = config.hasFirstGhost
    ? { ...lupaOptions, hasFirstGhost: true }
    : lupaOptions

  // JS版
  const retar = new VillageRetar(vs, setup, options)
  const jsResult = retar.analyze()

  // WASM版
  const vsJson = JSON.stringify(serializeVillageStatus(vs))
  const setupJson = JSON.stringify(Object.fromEntries(setup))
  const optJson = JSON.stringify(serializeOptions(options))
  const t0 = performance.now()
  const wasmRaw = parseWasmResult(wasmAnalyze!(vsJson, setupJson, optJson))
  const retarMs = performance.now() - t0

  // deepEqual で完全一致を検証（elapsedは実行時間のため除外）
  try {
    deepStrictEqual({ ...wasmRaw, elapsed: undefined }, { ...jsResult, elapsed: undefined })
    return { failure: null, skipped: false, retarMs }
  } catch (e: any) {
    // 不一致検出 → dump 有効で再実行し中間結果を収集
    const tsDump = collectTsDump(vs, setup, options)
    const rsDump = collectRsDump(vsJson, setupJson, optJson)
    const diffSummary = formatCompatDiff(jsResult, wasmRaw, tsDump, rsDump)

    const message = diffSummary
    const annotatedHowl = partialHowl.trimEnd() + '\n\n'
      + `# [compat] ${message}\n`
    return {
      failure: {
        config: configName, seed, checkpoint, howl: annotatedHowl,
        players: [{ name: '(compat)', message }],
      },
      skipped: false, retarMs,
    }
  }
}

/**
 * dump を有効にして TS 版を再実行し、中間結果を収集する
 */
function collectTsDump(
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  options: AnalyzeOptions,
): string[] {
  resetDump()
  enableDump()
  try {
    const retar2 = new VillageRetar(vs, setup, options)
    retar2.analyze()
  } finally {
    disableDump()
  }
  return getDump()
}

/**
 * WASM 版を dump 有効で実行し、中間結果を収集する
 */
let wasmAnalyzeWithDump: ((village: string, setup: string, options: string) => string) | null = null
try {
  const wasm = await import('../retar-rs/pkg/retar.js')
  wasmAnalyzeWithDump = wasm.analyze_with_dump ?? null
} catch {
  // WASM not available
}

function collectRsDump(vsJson: string, setupJson: string, optJson: string): string[] {
  if (!wasmAnalyzeWithDump) return []
  const raw = wasmAnalyzeWithDump(vsJson, setupJson, optJson)
  try {
    const parsed = JSON.parse(raw)
    return parsed.dump ?? []
  } catch {
    return []
  }
}

/**
 * TS dump と Rust dump を行単位で比較し、最初の差分箇所を報告する
 */
function formatCompatDiff(
  jsResult: AnalyzeResult,
  wasmResult: AnalyzeResult,
  tsDump: string[],
  rsDump: string[],
): string {
  const lines: string[] = []

  // 最終結果の seat 差分
  const allSeats = new Set([...jsResult.result.keys(), ...wasmResult.result.keys()])
  for (const seat of [...allSeats].sort((a, b) => a - b)) {
    const jsRoles = jsResult.result.get(seat)
    const wasmRoles = wasmResult.result.get(seat)
    const jsSet = jsRoles ? [...jsRoles].sort() : []
    const wasmSet = wasmRoles ? [...wasmRoles].sort() : []
    if (JSON.stringify(jsSet) !== JSON.stringify(wasmSet)) {
      const tsOnly = jsSet.filter(r => !wasmSet.includes(r))
      const rsOnly = wasmSet.filter(r => !jsSet.includes(r))
      const parts: string[] = [`seat ${seat}:`]
      if (tsOnly.length > 0) parts.push(`TS+[${tsOnly.join(',')}]`)
      if (rsOnly.length > 0) parts.push(`Rust+[${rsOnly.join(',')}]`)
      lines.push(parts.join(' '))
    }
  }
  if (jsResult.maxSurvivingNV !== wasmResult.maxSurvivingNV) {
    lines.push(`maxSurvivingNV: TS=${jsResult.maxSurvivingNV} Rust=${wasmResult.maxSurvivingNV}`)
  }

  // dump diff: 最初に異なる行を特定
  if (rsDump.length === 0) {
    lines.push(`\n[dump] Rust dump が取得できません。dump 付き WASM をビルドしてください:`)
    lines.push(`  bash src/retar-rs/build.sh build-dump`)
    if (tsDump.length > 0) {
      lines.push(`\n--- TS dump (${tsDump.length} steps, Rust 比較なし) ---`)
      for (const line of tsDump.slice(0, 10)) lines.push(`  ${line}`)
      if (tsDump.length > 10) lines.push(`  ... (${tsDump.length - 10} more)`)
    }
  } else {
    const maxLen = Math.max(tsDump.length, rsDump.length)
    for (let i = 0; i < maxLen; i++) {
      const ts = tsDump[i] ?? '(missing)'
      const rs = rsDump[i] ?? '(missing)'
      if (ts !== rs) {
        lines.push(`\nfirst diff at step ${i}:`)
        lines.push(`  TS:   ${ts}`)
        lines.push(`  Rust: ${rs}`)
        break
      }
    }
    if (tsDump.length > 0 && tsDump.length === rsDump.length && tsDump.every((l, i) => l === rsDump[i])) {
      lines.push(`\ndump identical (${tsDump.length} steps) — diff is in non-instrumented code`)
    }
  }

  return lines.join('\n')
}

/**
 * Prior等価性検証: buildAssumptions を使い prior+assumptions と assumptions のみの結果が完全一致するか
 */
function verifyPriorEquivCheckpoint(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  checkpoint: Checkpoint,
  configName: string,
  seed: number,
): VerifyResult {
  const partialEvents = events.slice(0, checkpoint.index)
  const partialHowl = formatHowl(partialEvents, state, config)

  const { meta, statements } = parse(partialHowl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    return { failure: null, skipped: true, retarMs: 0 }
  }

  const { vs, setup } = buildVillageStatus(statements, meta)

  // Retarの前提条件チェック
  for (const player of state.players) {
    if (!VILLAGE_ROLES.includes(player.role)) continue
    const seatStatus = vs.statuses.get(player.seat)
    if (!seatStatus) continue
    if (!seatStatus.surviving && seatStatus.causeOfDeath === 'execution' && !seatStatus.claiming) {
      return { failure: null, skipped: true, retarMs: 0 }
    }
  }

  const options = config.hasFirstGhost
    ? { ...lupaOptions, hasFirstGhost: true }
    : lupaOptions

  // ベースRetarを実行してpriorを取得
  const baseRetar = new VillageRetar(vs, setup, options)
  const baseResult = baseRetar.analyze()
  if (baseResult.error) {
    return { failure: null, skipped: true, retarMs: 0 }
  }
  const prior = baseResult.result

  const t0 = performance.now()
  const failedPlayers: { name: string, message: string }[] = []

  for (const player of state.players) {
    // prior ありの assumptions（buildAssumptions が prior を参照してフィルタする）
    const assumptionsWithPrior = buildAssumptions(state, player, prior)
    if (assumptionsWithPrior.size === 0) continue

    // prior なしの assumptions（直接実行用）
    const assumptionsWithout = buildAssumptions(state, player)

    // A: prior + assumptions
    const retarA = new VillageRetar(vs, setup, { ...options, assumptions: assumptionsWithPrior, prior })
    const resultA = retarA.analyzeSafe()

    // B: assumptions のみ（prior なし）
    const retarB = new VillageRetar(vs, setup, { ...options, assumptions: assumptionsWithout })
    const resultB = retarB.analyzeSafe()

    // エラー状態の比較
    if (resultA.error && resultB.error) continue
    if (resultA.error || resultB.error) {
      failedPlayers.push({
        name: player.name,
        message: `エラー不一致: prior=${resultA.error ?? 'ok'}, direct=${resultB.error ?? 'ok'}`,
      })
      continue
    }

    // 各座席の可能性を比較
    for (const [seat, rolesB] of resultB.result) {
      const rolesA = resultA.result.get(seat)
      if (!rolesA) {
        failedPlayers.push({
          name: player.name,
          message: `${player.name}視点: seat${seat}がprior結果に欠落`,
        })
        break
      }
      const sortedA = [...rolesA].sort()
      const sortedB = [...rolesB].sort()
      if (sortedA.length !== sortedB.length || sortedA.some((r, i) => r !== sortedB[i])) {
        failedPlayers.push({
          name: player.name,
          message: `${player.name}(${player.role})視点 seat${seat}: prior=[${sortedA}] direct=[${sortedB}]`,
        })
        break
      }
    }
  }

  const retarMs = performance.now() - t0

  if (failedPlayers.length === 0) {
    return { failure: null, skipped: false, retarMs }
  }

  const annotatedHowl = partialHowl.trimEnd() + '\n\n'
    + failedPlayers.map(p => `# [prior-equiv] ${p.name}: ${p.message}`).join('\n') + '\n'

  return {
    failure: {
      config: configName, seed, checkpoint, howl: annotatedHowl,
      players: failedPlayers,
    },
    skipped: false, retarMs,
  }
}

type VerifyGameConfig = {
  name: string
  roles: Record<string, number>
  seeds: [number, number]
  hasFirstGhost?: boolean
  revoteConfig?: import('./types.ts').RevoteConfig
}

const configs: VerifyGameConfig[] = [
  // 基本構成
  { name: 'basic-5p', roles: { werewolf: 1, villager: 3, seer: 1 }, seeds: [0, 2000] },
  { name: 'basic-7p', roles: { werewolf: 1, villager: 4, seer: 1, medium: 1 }, seeds: [0, 2000] },
  { name: 'standard-10p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, possessed: 1 }, seeds: [0, 2000] },
  // 狩人・共有
  { name: 'guard-8p', roles: { werewolf: 2, villager: 3, seer: 1, bodyguard: 1, possessed: 1 }, seeds: [0, 1000] },
  { name: 'mason-10p', roles: { werewolf: 2, villager: 3, seer: 1, medium: 1, mason: 2, possessed: 1 }, seeds: [0, 1000] },
  { name: 'mason-guard-12p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, mason: 2, possessed: 1 }, seeds: [0, 1000] },
  // 猫又
  { name: 'nekomata-6p', roles: { werewolf: 1, villager: 3, seer: 1, nekomata: 1 }, seeds: [0, 2000] },
  { name: 'nekomata-10p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, nekomata: 1, possessed: 1 }, seeds: [0, 1000] },
  // 妖狐・背徳
  { name: 'hamster-9p', roles: { werewolf: 2, villager: 3, seer: 1, medium: 1, werehamster: 1, possessed: 1 }, seeds: [0, 1000] },
  { name: 'hamster-11p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, werehamster: 1, possessed: 1 }, seeds: [0, 1000] },
  { name: 'hamster-imm-12p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, werehamster: 1, immoralist: 1, possessed: 1 }, seeds: [0, 1000] },
  // 狂信者
  { name: 'fanatic-10p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, fanatic: 1 }, seeds: [0, 1000] },
  // 大規模・全役職
  { name: 'full-15p', roles: { werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1, mason: 2, nekomata: 1, possessed: 1, fanatic: 1, werehamster: 1, immoralist: 1 }, seeds: [0, 1000] },
  { name: 'full-17p', roles: { werewolf: 3, villager: 4, seer: 1, medium: 1, bodyguard: 1, mason: 2, nekomata: 1, possessed: 1, fanatic: 1, werehamster: 1, immoralist: 1 }, seeds: [0, 500] },
  // 初日犠牲者あり
  { name: '14d-neko', roles: { werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1, mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1 }, seeds: [0, 1000], hasFirstGhost: true, revoteConfig: { maxRevotes: 2, style: 'full_revote', tiebreaker: 'draw' } },
]

type Args = {
  outdir: string | null
  scenario: string | null
  seed: number | null
  seeds: [number, number] | null
  quiet: boolean
  prior: boolean
  priorEquiv: boolean
  compat: boolean
}

function showHelp(): never {
  const scenarioNames = configs.map(c => c.name).join(', ')
  console.log(`Lupa × Retar 検証スクリプト

Usage: npm run verify:retar [-- options]

Options:
  --scenario <name>   指定シナリオのみ実行
  --seed <n>          単一seedで実行
  --seeds <from>-<to> seed範囲を指定 (例: 100-200)
  --outdir <dir>      失敗howlファイルの出力先ディレクトリ
  --prior             priorモード検証: 各座席の真の役職でprior再計算し他席と矛盾しないか
  --prior-equiv       prior等価性検証: buildAssumptionsでprior有無の結果が完全一致するか
  --compat            JS版とWASM版の出力が完全一致するか検証
  --quiet, -q         プログレスバーを非表示
  --help, -h          このヘルプを表示

シナリオ一覧:
  ${scenarioNames}

Examples:
  npm run verify:retar
  npm run verify:retar -- --outdir tmp/verify
  npm run verify:retar -- --scenario full-15p --seed 114
  npm run verify:retar -- --scenario 14d-neko --seeds 0-100 --outdir tmp/verify`)
  process.exit(0)
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) showHelp()
  const result: Args = { outdir: null, scenario: null, seed: null, seeds: null, quiet: false, prior: false, priorEquiv: false, compat: false }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--outdir':
        result.outdir = args[++i]
        break
      case '--scenario':
        result.scenario = args[++i]
        break
      case '--seed':
        result.seed = parseInt(args[++i], 10)
        break
      case '--seeds': {
        const m = args[++i].match(/^(\d+)-(\d+)$/)
        if (m) result.seeds = [parseInt(m[1], 10), parseInt(m[2], 10)]
        break
      }
      case '--prior':
        result.prior = true
        break
      case '--prior-equiv':
        result.priorEquiv = true
        break
      case '--compat':
        result.compat = true
        break
      case '--quiet':
      case '-q':
        result.quiet = true
        break
    }
  }
  return result
}

function renderProgress(
  current: number, total: number,
  configName: string, seed: number,
  failures: number, elapsed: number,
): void {
  const pct = total > 0 ? current / total : 0
  const barWidth = 30
  const filled = Math.round(pct * barWidth)
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
  const pctStr = (pct * 100).toFixed(0).padStart(3)
  const rate = current > 0 ? (elapsed / current).toFixed(1) : '—'
  const eta = current > 0 ? ((elapsed / current) * (total - current) / 1000).toFixed(0) : '?'
  const failStr = failures > 0 ? `\x1b[31mFails: ${failures}\x1b[0m` : `\x1b[32mFails: 0\x1b[0m`
  process.stderr.write(
    `\r\x1b[K  ${bar} ${pctStr}% ${current}/${total} | ${configName} s${seed} | ${rate}ms/game ETA ${eta}s | ${failStr}`
  )
}

async function main() {
  const { outdir, scenario, seed: singleSeed, seeds: seedRange, quiet, prior, priorEquiv, compat } = parseArgs()
  if (compat && !wasmAnalyze) {
    console.error('--compat: WASM版が利用できません。npm run build:wasm:node でビルドしてください。')
    process.exit(1)
  }
  const showProgress = !!outdir && !quiet
  const allFailures: FailedCheckpoint[] = []
  let totalGames = 0
  let totalCheckpoints = 0
  let totalSkipped = 0
  const totalResults = { villager_won: 0, werewolf_won: 0, werehamster_won: 0, draw: 0 }

  // 時間計測
  const gameTimes: number[] = []
  const retarTimes: number[] = []
  const totalStart = performance.now()

  const activeConfigs = scenario
    ? configs.filter(c => c.name === scenario)
    : configs

  if (scenario && activeConfigs.length === 0) {
    console.error(`シナリオ "${scenario}" が見つかりません。利用可能: ${configs.map(c => c.name).join(', ')}`)
    process.exit(1)
  }

  // 総ゲーム数を事前計算（プログレスバー用）
  const expectedTotal = activeConfigs.reduce((sum, gc) => {
    const [s, e] = singleSeed != null ? [singleSeed, singleSeed + 1] : seedRange ?? gc.seeds
    return sum + (e - s)
  }, 0)

  // outdir指定時は即時書き出し用に事前準備
  const nameCount = new Map<string, number>()
  if (outdir) mkdirSync(outdir, { recursive: true })

  const defaultStrategy = new RandomStrategy()

  for (const gc of activeConfigs) {
    const roles = new Map(Object.entries(gc.roles) as [SystemRole, number][])
    const lupaConfig: LupaConfig = {
      roles,
      hasFirstGhost: gc.hasFirstGhost,
      revoteConfig: gc.revoteConfig,
    }
    let configCheckpoints = 0
    let configSkipped = 0
    const configResults = { villager_won: 0, werewolf_won: 0, werehamster_won: 0, draw: 0 }

    const [seedStart, seedEnd] = singleSeed != null
      ? [singleSeed, singleSeed + 1]
      : seedRange ?? gc.seeds

    for (let seed = seedStart; seed < seedEnd; seed++) {
      const gameStart = performance.now()
      lupaConfig.seed = seed
      const engineConfig: EngineGameConfig = {
        roles,
        seed,
        hasFirstGhost: gc.hasFirstGhost,
        revoteConfig: gc.revoteConfig,
      }
      const handlers = strategyAdapter({ defaultStrategy, seed, roles })
      const { events, state } = await runGame(engineConfig, handlers)
      totalGames++
      if (state.result) configResults[state.result]++

      const checkpoints = findCheckpoints(events)
      let gameFailed = false
      for (const cp of checkpoints) {
        totalCheckpoints++
        configCheckpoints++
        if (gameFailed) continue
        const { failure, skipped, retarMs } = compat
          ? verifyCompatCheckpoint(events, state, lupaConfig, cp, gc.name, seed)
          : priorEquiv
          ? verifyPriorEquivCheckpoint(events, state, lupaConfig, cp, gc.name, seed)
          : prior
          ? verifyPriorCheckpoint(events, state, lupaConfig, cp, gc.name, seed)
          : verifyCheckpoint(events, state, lupaConfig, cp, gc.name, seed)
        if (failure) {
          allFailures.push(failure)
          gameFailed = true
          // 即時ファイル書き出し
          if (outdir) {
            const base = `${failure.config}_s${failure.seed}_${failure.checkpoint.type}`
            const count = nameCount.get(base) ?? 0
            nameCount.set(base, count + 1)
            const suffix = count > 0 ? `_${count + 1}` : ''
            writeFileSync(join(outdir, `${base}${suffix}.howl`), failure.howl, 'utf-8')
          }
        }
        if (skipped) {
          configSkipped++
          totalSkipped++
        }
        if (retarMs > 0) retarTimes.push(retarMs)
      }
      gameTimes.push(performance.now() - gameStart)
      if (showProgress) {
        renderProgress(totalGames, expectedTotal, gc.name, seed, allFailures.length, performance.now() - totalStart)
      }
    }

    if (showProgress) process.stderr.write('\r\x1b[K')
    const skippedStr = configSkipped > 0 ? ` (${configSkipped} skipped)` : ''
    const numGames = seedEnd - seedStart
    const r = configResults
    const resultStr = `村${r.villager_won} 狼${r.werewolf_won} 狐${r.werehamster_won}` + (r.draw > 0 ? ` 分${r.draw}` : '')
    console.log(`  ${gc.name}: ${numGames} games [${resultStr}], ${configCheckpoints} checkpoints${skippedStr}`)
    totalResults.villager_won += r.villager_won
    totalResults.werewolf_won += r.werewolf_won
    totalResults.werehamster_won += r.werehamster_won
    totalResults.draw += r.draw
  }

  const totalMs = performance.now() - totalStart

  const tr = totalResults
  const totalResultStr = `村${tr.villager_won} 狼${tr.werewolf_won} 狐${tr.werehamster_won}` + (tr.draw > 0 ? ` 分${tr.draw}` : '')
  console.log(`\n合計: ${totalGames} games [${totalResultStr}], ${totalCheckpoints} checkpoints, ${totalSkipped} skipped`)

  // 時間統計
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  const max = (arr: number[]) => arr.reduce((m, v) => v > m ? v : m, 0)
  console.log(`時間: total ${totalMs.toFixed(0)}ms`)
  console.log(`  game: avg ${avg(gameTimes).toFixed(1)}ms, max ${max(gameTimes).toFixed(1)}ms (${totalGames} games)`)
  console.log(`  retar: avg ${avg(retarTimes).toFixed(1)}ms, max ${max(retarTimes).toFixed(1)}ms (${retarTimes.length} runs)`)

  const verified = totalCheckpoints - totalSkipped
  if (allFailures.length === 0) {
    console.log(`検証済み ${verified} checkpoints: 全通過`)
    return
  }

  console.error(`\n検証済み ${verified} checkpoints: ${allFailures.length} チェックポイントで失敗`)

  if (outdir) {
    console.log(`${allFailures.length} 件の .howl ファイルを ${outdir}/ に出力済み`)
  }

  // コンソールにもサマリー表示
  for (const f of allFailures) {
    const players = f.players.map(p => `${p.name}: ${p.message}`).join(', ')
    console.error(`  [${f.config} seed=${f.seed} ${f.checkpoint.type}] ${players}`)
  }

  process.exit(1)
}

await main()
