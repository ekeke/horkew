import type { ResolvedRules } from '../types/index.ts'

type RuleBase = {
  description: string,
}

type BooleanRule = RuleBase & {
  type: "boolean"
  default: boolean
}

type ChoiceRule = RuleBase & {
  type: "choice"
  choices: string[]
  default: string
}

type NumericRule = RuleBase & {
  type: "numeric"
  default: number
}

type Rule = BooleanRule | ChoiceRule | NumericRule

export const Rules: { [key: string]: Rule } = {
  "general.omitFirstDay": {
    type: "boolean",
    description: "Omit the first day of the game story; the first night becomes Night 0, the first discussion becomes Day 1. When false (default), the first night is Night 1 and the first discussion is Day 2.",
    default: false,
  },

  "vote.style": {
    type: "choice",
    description: "The style of voting to use. 'ordered' fixes the voting order so the last voter is determined; 'free' / 'concurrent' leave it open. Reserved for future retar reasoning (e.g. 'last voter = wolf' counter-pruning). Currently not enforced by lupa engine — all three behave identically.",
    choices: [
      "free",
      "ordered",
      "concurrent",
    ],
    default: "free",
  },

  "vote.final": {
    type: "choice",
    description: "The final voting rule to use.",
    choices: [
      "revote",
      "final",
    ],
    default: "revote",
  },

  "vote.tiebreaker": {
    type: "choice",
    description: "The tiebreaker rule to use.",
    choices: [
      "random",
      "no-lynch",
      "draw",
    ],
    default: "draw",
  },

  "general.first-victim": {
    type: "choice",
    description: "The first victim of the game.",
    choices: [
      "none",
      "random",
      "first-vote",
    ],
    default: "random",
  },

  "role.seer.first-seek": {
    type: "choice",
    description: "The first night action of the seer.",
    choices: [
      "none",
      "no-wolf",
      "all",
    ],
    default: "all",
  },

  "role.bodyguard.allow-continuous-protection": {
    type: "boolean",
    description: "Whether the bodyguard can protect the same player on consecutive nights.",
    default: true,
  },

  "role.nekomata.curse-target": {
    type: "choice",
    description: "The target of the curse.",
    choices: [
      "all-survivors",
      "villager",
    ],
    default: "all-survivors",
  },

  "role.nekomata.curse-immediately": {
    type: "boolean",
    description: "Whether the nekomata's curse takes effect immediately. If false, it takes effect the next morning.",
    default: true,
  },

  "role.immoralist.follow-immediately": {
    type: "boolean",
    description: "Whether the immoralist follows lynched werehamster immediately, (or, if false, next morning).",
    default: true,
  },

  "role.immoralist.reveal-following": {
    type: "boolean",
    description: "Whether the death of a werehamster (execution / fox_kill) is publicly revealed as-is. When false, all werehamster deaths are suppressed and re-emitted as a night_kill the next morning, hiding the original cause from retar reasoning.",
    default: true,
  },

  "phase.lastwill": {
    type: "boolean",
    description: "Whether executed players get a last-will phase to CO before death takes effect. Affects retar reasoning (when false, silently-dying executed players may still have hidden roles — cannot be eliminated from possibilities). lupa engine consults handlers.onLastWill; howl-adapter currently does not wire one, so this rule has no observable effect via spec/runner — covered in retar-side tests.",
    default: true,
  },
}

const defaultRules: ResolvedRules = Object.fromEntries(
  Object.entries(Rules).map(([key, rule]) => [key, rule.default])
) as unknown as ResolvedRules

export function resolveRules(raw?: Record<string, any>): ResolvedRules {
  if (!raw) return defaultRules
  const result = { ...defaultRules }
  for (const [key, value] of Object.entries(raw)) {
    if (key in Rules && value !== undefined) {
      (result as any)[key] = value
    }
  }
  return result
}
