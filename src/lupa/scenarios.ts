import type { SystemRole } from '../types/index.ts'
import type { RevoteConfig } from './types.ts'

export type ScenarioMeta = {
  popularName: string
  description: string
  winRate: {
    village: number
    werewolf: number
    fox: number
    draw: number
  }
  gameTimeMin: number
  source: { url: string; name: string }
}

export type Scenario = {
  name: string
  roles: Record<string, number>
  hasFirstGhost?: boolean
  revoteConfig?: RevoteConfig
  meta?: ScenarioMeta
}

export const scenarios: Scenario[] = [
  { name: 'basic-5p', roles: { werewolf: 1, villager: 3, seer: 1 } },
  { name: 'basic-7p', roles: { werewolf: 1, villager: 4, seer: 1, medium: 1 } },
  { name: 'standard-10p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, possessed: 1 } },
  { name: 'guard-8p', roles: { werewolf: 2, villager: 3, seer: 1, bodyguard: 1, possessed: 1 } },
  { name: 'mason-10p', roles: { werewolf: 2, villager: 3, seer: 1, medium: 1, mason: 2, possessed: 1 } },
  { name: 'mason-guard-12p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, mason: 2, possessed: 1 } },
  { name: 'nekomata-6p', roles: { werewolf: 1, villager: 3, seer: 1, nekomata: 1 } },
  { name: 'nekomata-10p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, nekomata: 1, possessed: 1 } },
  { name: 'hamster-9p', roles: { werewolf: 2, villager: 3, seer: 1, medium: 1, werehamster: 1, possessed: 1 } },
  { name: 'hamster-11p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, werehamster: 1, possessed: 1 } },
  { name: 'hamster-imm-12p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, werehamster: 1, immoralist: 1, possessed: 1 } },
  { name: 'fanatic-10p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, fanatic: 1 } },
  { name: 'full-15p', roles: { werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1, mason: 2, nekomata: 1, possessed: 1, fanatic: 1, werehamster: 1, immoralist: 1 } },
  { name: 'full-17p', roles: { werewolf: 3, villager: 4, seer: 1, medium: 1, bodyguard: 1, mason: 2, nekomata: 1, possessed: 1, fanatic: 1, werehamster: 1, immoralist: 1 } },
  { name: '14d-neko', roles: { werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1, mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1 }, hasFirstGhost: true, revoteConfig: { maxRevotes: 2, style: 'full_revote', tiebreaker: 'draw' } },
]

export function findScenario(name: string): Scenario | undefined {
  return scenarios.find(s => s.name === name)
}

export function scenarioToRoles(scenario: Scenario): Map<SystemRole, number> {
  return new Map(Object.entries(scenario.roles) as [SystemRole, number][])
}
