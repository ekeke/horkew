import type {
  Statement, JoinStatement, JoinMultiStatement, VoteStatement, MultiVoteStatement,
  AttackStatement, LynchStatement, CurseStatement, FollowStatement,
  RevoteStatement, OverStatement,
  AssertStatement, RevealStatement, UnknownStatement,
  Assertion,
} from '../src/howl/statement.ts'
import { FlexibleDictionary } from '../src/howl/flexibleDictionary.ts'

const gameResultLabels: Record<string, string> = {
  villageWin: '村人陣営が勝利しました。',
  wolfWin: '狼陣営が勝利しました。',
  hamsterWin: '妖狐陣営が勝利しました。',
  draw: '引き分けになりました。',
}

const roleLabels: Record<string, string> = {
  seer: '占い師',
  medium: '霊能者',
  bodyguard: '狩人',
  mason: '共有者',
  nekomata: '猫又',
  nonVillage: '非村',
}

export type StringifiedLine = {
  text: string
  type: 'normal' | 'unknown' | 'blank' | 'day'
}

export function stringifyStatements(statements: Statement[]): StringifiedLine[] {
  const dict = new FlexibleDictionary()

  function resolve(name: string): string {
    const results = dict.search(name)
    return results.length > 0 ? results[0] : name
  }

  function p(name: string): string {
    return `【${resolve(name)}】`
  }

  function ps(names: string[]): string {
    return names.map(p).join(', ')
  }

  const claimedRoles = new Map<string, string>()

  const divineVerbs: Record<string, string> = {
    seer: '占った',
    medium: '霊視した',
  }

  function assertionToString(actor: string, role: string | undefined, a: Assertion, dayIndex?: number): string {
    const parts: string[] = []
    if (dayIndex !== undefined) parts.push(`${dayIndex}d`)
    parts.push(p(actor))
    if (a.target && a.result) {
      const species = a.result === 'isWolf' ? '人狼' : '人間'
      const verb = (role && divineVerbs[role]) ?? '主張した'
      parts.push(`${p(a.target)}は${species}と${verb}`)
    } else if (a.target && a.action === 'guard') {
      parts.push(`${p(a.target)}を護衛した`)
    }
    return parts.join(' ')
  }

  function stringifyOne(s: Statement): StringifiedLine[] {
    switch (s.type) {
      case 'join': {
        const st = s as JoinStatement
        dict.add(st.name, [st.name, ...st.aliases])
        return [{ text: `${p(st.name)}が参加しました。`, type: 'normal' }]
      }
      case 'joinMulti': {
        const st = s as JoinMultiStatement
        for (const player of st.players) {
          dict.add(player, [player])
        }
        return [{ text: `${ps(st.players)}が参加しました。`, type: 'normal' }]
      }
      case 'vote': {
        const st = s as VoteStatement
        return [{ text: `${p(st.voter)}は${p(st.target)}に投票しました。`, type: 'normal' }]
      }
      case 'multiVote': {
        const st = s as MultiVoteStatement
        if (st.voters.length === 0) return [{ text: `${p(st.target)}には誰も投票しませんでした。`, type: 'normal' }]
        return [{ text: `${ps(st.voters)}は${p(st.target)}に投票しました。`, type: 'normal' }]
      }
      case 'attack': {
        const st = s as AttackStatement
        return [{ text: `${ps(st.target)}が襲撃されました。`, type: 'normal' }]
      }
      case 'lynch': {
        const st = s as LynchStatement
        if (st.target === null) return [{ text: '処刑はありませんでした。', type: 'normal' }]
        return [{ text: `${p(st.target)}が処刑されました。`, type: 'normal' }]
      }
      case 'revote': {
        const st = s as RevoteStatement
        if (st.targets.length === 0) return [{ text: '再投票になりました。', type: 'normal' }]
        return [{ text: `${ps(st.targets)}の決選投票になりました。`, type: 'normal' }]
      }
      case 'over': {
        const st = s as OverStatement
        return [{ text: gameResultLabels[st.result] ?? st.result, type: 'normal' }]
      }
      case 'assert': {
        const st = s as AssertStatement
        const lines: StringifiedLine[] = []
        const claimAssertion = st.assertions.find(a => a.roles)
        if (claimAssertion) {
          const roleNames = claimAssertion.roles!.map(r => roleLabels[r] ?? r).join('')
          lines.push({ text: `${p(st.actor)}が${roleNames}COしました。`, type: 'normal' })
          claimedRoles.set(resolve(st.actor), claimAssertion.roles![0])
        }
        const role = claimedRoles.get(resolve(st.actor))
        const history = st.assertions.filter(a => !a.roles)
        const baseDay = (st.day ?? 1) - history.length
        for (let i = 0; i < history.length; i++) {
          lines.push({ text: `  ${assertionToString(st.actor, role, history[i], baseDay + i)}`, type: 'normal' })
        }
        return lines
      }
      case 'curse': {
        const st = s as CurseStatement
        return [{ text: `${p(st.target)}が道連れになりました。`, type: 'normal' }]
      }
      case 'follow': {
        const st = s as FollowStatement
        return [{ text: `${p(st.target)}が後追いしました。`, type: 'normal' }]
      }
      case 'peace':
        return [{ text: '平和な朝を迎えました。', type: 'normal' }]
      case 'reveal': {
        const st = s as RevealStatement
        return [{ text: `${p(st.player)}は${st.role}でした。`, type: 'normal' }]
      }
      case 'unknown': {
        const st = s as UnknownStatement
        return [{ text: st.text, type: 'unknown' }]
      }
      default:
        return []
    }
  }

  const result: StringifiedLine[] = []
  let prevLine = -1
  let prevDay = -1
  for (const s of statements) {
    if (s.day !== undefined && s.day !== prevDay) {
      if (prevDay >= 0) result.push({ text: '', type: 'blank' })
      result.push({ text: `${s.day}日目`, type: 'day' })
      prevDay = s.day
    } else if (prevLine >= 0 && s.line > prevLine + 1) {
      result.push({ text: '', type: 'blank' })
    }
    result.push(...stringifyOne(s))
    prevLine = s.line
  }
  return result
}
