/**
 * commandPlayStore ユニットテスト
 *
 * demo/ 配下だが node:test で実行可能（Svelte 依存なし）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../src/types/index.ts'
import { CommandPlayStore } from './commandPlayStore.ts'

// ============================================================
// Store 基本
// ============================================================

test('CommandPlayStore: 初期状態は全て null/空', () => {
  const store = new CommandPlayStore()
  const s = store.getState()
  assert.equal(s.pending, null)
  assert.equal(s.finished, false)
  assert.equal(s.result, null)
  assert.equal(s.humanSeats.size, 0)
  assert.equal(s.gameState, null)
  assert.deepEqual(s.events, [])
  assert.equal(s.seatRoles, null)
  assert.equal(s.humanRole, null)
  assert.equal(s.running, false)
})

test('CommandPlayStore: subscribe は初期状態を即時通知', () => {
  const store = new CommandPlayStore()
  let received: unknown = null
  const unsub = store.subscribe(s => { received = s })
  assert.ok(received !== null)
  unsub()
})

test('CommandPlayStore: unsubscribe で通知停止', () => {
  const store = new CommandPlayStore()
  let count = 0
  const unsub = store.subscribe(() => count++)
  assert.equal(count, 1)
  unsub()
  store.reset()
  assert.equal(count, 1)
})

// ============================================================
// startGame + humanSeats
// ============================================================

/** pending が来たら即 legal[0] を submit するオートパイロット */
function attachAutoSubmit(store: CommandPlayStore): () => void {
  return store.subscribe(s => {
    if (s.pending) {
      try {
        store.submit(s.pending.legal[0])
      } catch { /* race 条件無視 */ }
    }
  })
}

function small14D(): Map<SystemRole, number> {
  // 小さめの構成: seer/bodyguard/mason×2/villager/werewolf×2/fanatic = 8
  return new Map<SystemRole, number>([
    ['seer', 1], ['bodyguard', 1], ['mason', 2], ['villager', 1],
    ['werewolf', 2], ['fanatic', 1],
  ])
}

test('CommandPlayStore: humanRole=seer は 1 席のみ', async () => {
  const store = new CommandPlayStore()
  attachAutoSubmit(store)
  await store.startGame({ humanRole: 'seer', roles: small14D(), seed: 42 })
  const final = store.getState()
  assert.ok(final.finished, '完走')
  assert.equal(final.humanSeats.size, 1, 'seer は 1 席のみ')
  for (const seat of final.humanSeats) {
    assert.equal(final.seatRoles!.get(seat), 'seer')
  }
})

test('CommandPlayStore: humanRole=werewolf は全狼席', async () => {
  const store = new CommandPlayStore()
  attachAutoSubmit(store)
  await store.startGame({ humanRole: 'werewolf', roles: small14D(), seed: 7 })
  const final = store.getState()
  assert.equal(final.humanSeats.size, 2, '狼は全席 (2)')
  for (const seat of final.humanSeats) {
    assert.equal(final.seatRoles!.get(seat), 'werewolf')
  }
})

test('CommandPlayStore: humanRole=mason は全共有席', async () => {
  const store = new CommandPlayStore()
  attachAutoSubmit(store)
  await store.startGame({ humanRole: 'mason', roles: small14D(), seed: 13 })
  const final = store.getState()
  assert.equal(final.humanSeats.size, 2, '共有は全席 (2)')
  for (const seat of final.humanSeats) {
    assert.equal(final.seatRoles!.get(seat), 'mason')
  }
})

test('CommandPlayStore: humanRole=villager は 1 席のみ（複数いても）', async () => {
  const store = new CommandPlayStore()
  attachAutoSubmit(store)
  // villager を 2 人以上入れた構成
  const roles = new Map<SystemRole, number>([
    ['seer', 1], ['villager', 3], ['werewolf', 1], ['fanatic', 1],
  ])
  await store.startGame({ humanRole: 'villager', roles, seed: 31 })
  const final = store.getState()
  assert.equal(final.humanSeats.size, 1, 'villager 複数いても人間は 1 席')
})

test('CommandPlayStore: 実行中に二重 startGame は throw', async () => {
  const store = new CommandPlayStore()
  attachAutoSubmit(store)
  const p = store.startGame({ humanRole: 'seer', roles: small14D(), seed: 1 })
  await assert.rejects(
    async () => store.startGame({ humanRole: 'werewolf', roles: small14D(), seed: 2 }),
    /ゲームが既に実行中/,
  )
  await p
})

test('CommandPlayStore: reset で初期状態に戻る', async () => {
  const store = new CommandPlayStore()
  attachAutoSubmit(store)
  await store.startGame({ humanRole: 'seer', roles: small14D(), seed: 3 })
  store.reset()
  const s = store.getState()
  assert.equal(s.finished, false)
  assert.equal(s.humanSeats.size, 0)
  assert.equal(s.seatRoles, null)
  assert.equal(s.humanRole, null)
})

test('CommandPlayStore: humanRole=mason で片側 mason_co を出すと相方席も自動連動 CO', async () => {
  const store = new CommandPlayStore()
  // 手動オート: mason 席では mason_co、それ以外の自席では legal[0]
  let observedMasonSubmissions = 0
  const unsub = store.subscribe(s => {
    if (!s.pending) return
    const seat = s.pending.mySeat
    // 人間席 (mason) の場合のみ特別処理
    if (s.humanSeats.has(seat)) {
      // 自席の相方 mason 席を探す
      const masonPartner = [...s.humanSeats].find(h => h !== seat)
      if (masonPartner != null) {
        const masonCoCmd = s.pending.legal.find(c =>
          c.type === 'role_co'
          && c.claim.type === 'mason_co'
          && c.claim.partner === masonPartner,
        )
        if (masonCoCmd) {
          observedMasonSubmissions++
          try { store.submit(masonCoCmd) } catch { /* 二重 submit は無視 */ }
          return
        }
      }
    }
    try { store.submit(s.pending.legal[0]) } catch { /* race 無視 */ }
  })
  // seed 42 は両 mason 席 (1, 7) が D0 夜を生存するケース
  await store.startGame({ humanRole: 'mason', roles: small14D(), seed: 42 })
  unsub()
  const final = store.getState()
  assert.ok(final.finished)
  // 人間は 1 回しか mason_co を能動的に出していないが、相方も連動して mason_co を出している筈
  // → events に mason_claim が 2 つ (両 mason 席) 存在する
  const masonClaims = final.events.filter(e => (e as { type: string }).type === 'mason_claim')
  assert.ok(
    masonClaims.length >= 2,
    `両 mason 席が mason_claim を出す (got ${masonClaims.length}, humanSubmit=${observedMasonSubmissions})`,
  )
})

test('CommandPlayStore: 実行中 reset は throw', async () => {
  const store = new CommandPlayStore()
  const startPromise = store.startGame({ humanRole: 'seer', roles: small14D(), seed: 5 })
  await new Promise<void>((resolve) => {
    const unsub = store.subscribe(s => {
      if (s.pending !== null) { unsub(); resolve() }
    })
  })
  assert.equal(store.getState().running, true)
  assert.throws(() => store.reset(), /実行中はリセット不可/)
  attachAutoSubmit(store)
  await startPromise
})
