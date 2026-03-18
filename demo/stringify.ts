import type {
  Statement, JoinStatement, VoteStatement, MultiVoteStatement,
  AttackStatement, LynchStatement, RevoteStatement, OverStatement,
  AssertStatement, PeaceStatement, RevealStatement, UnknownStatement,
  Assertion,
} from '../src/howl/statement.ts'

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

function p(name: string): string {
  return `【${name}】`
}

function ps(names: string[]): string {
  return names.map(p).join(', ')
}

function speciesLabel(species: string): string {
  return species === 'isWolf' ? '●' : '○'
}

function assertionToString(a: Assertion, dayIndex?: number): string {
  const parts: string[] = []
  if (dayIndex !== undefined) parts.push(`${dayIndex}d`)
  if (a.target) parts.push(p(a.target))
  if (a.result) parts.push(speciesLabel(a.result))
  if (a.action === 'guard') parts.push('護衛')
  return parts.join(' ')
}

function stringifyOne(s: Statement): string {
  switch (s.type) {
    case 'join': {
      const st = s as JoinStatement
      return `${ps(st.players)}が参加しました。`
    }
    case 'vote': {
      const st = s as VoteStatement
      return `${p(st.voter)}は${p(st.target)}に投票しました。`
    }
    case 'multiVote': {
      const st = s as MultiVoteStatement
      if (st.voters.length === 0) return `${p(st.target)}には誰も投票しませんでした。`
      return `${ps(st.voters)}は${p(st.target)}に投票しました。`
    }
    case 'attack': {
      const st = s as AttackStatement
      return `${ps(st.target)}が襲撃されました。`
    }
    case 'lynch': {
      const st = s as LynchStatement
      if (st.target === null) return '処刑はありませんでした。'
      return `${p(st.target)}が処刑されました。`
    }
    case 'revote': {
      const st = s as RevoteStatement
      if (st.targets.length === 0) return '再投票になりました。'
      return `${ps(st.targets)}の決選投票になりました。`
    }
    case 'over': {
      const st = s as OverStatement
      return gameResultLabels[st.result] ?? st.result
    }
    case 'assert': {
      const st = s as AssertStatement
      const lines: string[] = []
      const claimAssertion = st.assertions.find(a => a.roles)
      if (claimAssertion) {
        const roleNames = claimAssertion.roles!.map(r => roleLabels[r] ?? r).join('')
        lines.push(`${p(st.actor)}が${roleNames}COしました。`)
      }
      const history = st.assertions.filter(a => !a.roles)
      for (let i = 0; i < history.length; i++) {
        lines.push(`  ${assertionToString(history[i], i + 1)}`)
      }
      return lines.join('\n')
    }
    case 'peace':
      return '平和な朝を迎えました。'
    case 'reveal': {
      const st = s as RevealStatement
      return `${p(st.player)}は${st.role}でした。`
    }
    case 'unknown': {
      const st = s as UnknownStatement
      return st.text
    }
    default:
      return ''
  }
}

export function stringifyStatements(statements: Statement[]): string {
  return statements.map(stringifyOne).join('\n')
}
