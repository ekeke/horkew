/**
 * Anthropic Tool Use schema definitions for Bloodhound.
 *
 * Static catalog of every action tool. `legal-actions.ts` selects
 * the subset to expose per phase/role.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { ToolName } from './types.ts'

export type ToolDef = Anthropic.Tool

// ---------------------------------------------------------------------------
// Discussion: speak / pass
// ---------------------------------------------------------------------------

export const sayTool: ToolDef = {
  name: 'say',
  description: 'Utter a free-form message in the current discussion phase. The text becomes a speech event visible to all other players.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Your utterance in Japanese.' },
    },
    required: ['text'],
  },
}

export const passTool: ToolDef = {
  name: 'pass',
  description: 'Skip your turn in the current discussion round. The engine will advance to the next seat; nothing is recorded in the game log.',
  input_schema: { type: 'object', properties: {} },
}

// ---------------------------------------------------------------------------
// CO (role claim) tools — every seat may call any of these (truth or bluff)
// ---------------------------------------------------------------------------

// All CO / report tools take a required `text` argument: the Japanese
// utterance the player will speak alongside the structured action. Without
// this, other players see the CO event but no voice — they read it as
// suspicious silence. text MUST be in your persona's voice.

export const seerCoTool: ToolDef = {
  name: 'seer_co',
  description: 'Claim to be the seer. text is the Japanese utterance you speak when announcing the CO.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Japanese spoken announcement (e.g. "占い師としてCOします。").' },
    },
    required: ['text'],
  },
}

export const mediumCoTool: ToolDef = {
  name: 'medium_co',
  description: 'Claim to be the medium. text is the Japanese utterance you speak.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Japanese spoken announcement.' },
    },
    required: ['text'],
  },
}

export const bodyguardCoTool: ToolDef = {
  name: 'bodyguard_co',
  description: 'Claim to be the bodyguard. text is the Japanese utterance you speak.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Japanese spoken announcement.' },
    },
    required: ['text'],
  },
}

export const masonCoTool: ToolDef = {
  name: 'mason_co',
  description: 'Claim to be a mason. partner_seat is the seat number of your fellow mason. text is the Japanese utterance you speak.',
  input_schema: {
    type: 'object',
    properties: {
      partner_seat: { type: 'integer', minimum: 1, description: 'Seat number of your mason partner.' },
      text: { type: 'string', description: 'Japanese spoken announcement.' },
    },
    required: ['partner_seat', 'text'],
  },
}

export const nekomataCoTool: ToolDef = {
  name: 'nekomata_co',
  description: 'Claim to be the nekomata. text is the Japanese utterance you speak.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Japanese spoken announcement.' },
    },
    required: ['text'],
  },
}

// ---------------------------------------------------------------------------
// Result disclosure (only meaningful after the corresponding role CO)
// ---------------------------------------------------------------------------

export const reportDivinationTool: ToolDef = {
  name: 'report_divination',
  description: 'Disclose a divination result. Use only if you have COed as seer (truthful seer or false-CO). target_seat = the seat YOU CHOSE to divine that night (NOT a victim of an attack or first ghost — the seer learns species, not death). text is the Japanese utterance you speak when reporting.',
  input_schema: {
    type: 'object',
    properties: {
      target_seat: { type: 'integer', minimum: 1 },
      species: { type: 'string', enum: ['human', 'wolf'] },
      day: { type: 'integer', minimum: 0, description: 'Night number the divination was performed on (0-indexed).' },
      text: { type: 'string', description: 'Japanese spoken report (e.g. "昨夜は seat-4 を占って、結果は●（人狼）でした。").' },
    },
    required: ['target_seat', 'species', 'day', 'text'],
  },
}

export const reportMediumTool: ToolDef = {
  name: 'report_medium',
  description: 'Disclose a medium result. Use only if you have COed as medium. target_seat MUST be the player who was EXECUTED (処刑) at the end of the previous day — NEVER a player who died by night attack (噛み/襲撃), first ghost, curse, or follow-kill. The medium has NO information on night deaths. Check your private knowledge "Your medium history" block for the correct seat (formatted as 「Day N の処刑者 seat-X → species」). text is the Japanese utterance you speak when reporting.',
  input_schema: {
    type: 'object',
    properties: {
      target_seat: { type: 'integer', minimum: 1 },
      species: { type: 'string', enum: ['human', 'wolf'] },
      day: { type: 'integer', minimum: 0 },
      text: { type: 'string', description: 'Japanese spoken report.' },
    },
    required: ['target_seat', 'species', 'day', 'text'],
  },
}

// ---------------------------------------------------------------------------
// Voting / night action
// ---------------------------------------------------------------------------

export const voteTool: ToolDef = {
  name: 'vote',
  description: 'Cast your execution vote. target_seat must be one of the legal candidates listed in the user prompt.',
  input_schema: {
    type: 'object',
    properties: { target_seat: { type: 'integer', minimum: 1 } },
    required: ['target_seat'],
  },
}

export const divineTool: ToolDef = {
  name: 'divine',
  description: 'Choose a target to divine tonight (seer only).',
  input_schema: {
    type: 'object',
    properties: { target_seat: { type: 'integer', minimum: 1 } },
    required: ['target_seat'],
  },
}

export const guardTool: ToolDef = {
  name: 'guard',
  description: 'Choose a target to guard tonight (bodyguard only). You cannot guard yourself.',
  input_schema: {
    type: 'object',
    properties: { target_seat: { type: 'integer', minimum: 1 } },
    required: ['target_seat'],
  },
}

export const attackTool: ToolDef = {
  name: 'attack',
  description: 'Nominate an attack target (werewolf only). The actual victim is decided by majority among living wolves.',
  input_schema: {
    type: 'object',
    properties: { target_seat: { type: 'integer', minimum: 1 } },
    required: ['target_seat'],
  },
}

// ---------------------------------------------------------------------------
// Retar (always available within the tool-use loop)
// ---------------------------------------------------------------------------

export const retarTool: ToolDef = {
  name: 'retar',
  description: 'Run role-possibility analysis with optional hypothetical assumptions. Returns possible role bitmask per seat. Use this when you want to test a hypothesis (e.g., "if seat-3 is wolf, what is consistent?").',
  input_schema: {
    type: 'object',
    properties: {
      assumptions: {
        type: 'array',
        description: 'Hypothetical role assignments to constrain the analysis. Empty array means analyze with no extra assumptions.',
        items: {
          type: 'object',
          properties: {
            seat: { type: 'integer', minimum: 1 },
            role: { type: 'string', description: 'System role identifier (e.g. werewolf, seer, fanatic).' },
          },
          required: ['seat', 'role'],
        },
      },
    },
    required: ['assumptions'],
  },
}

// ---------------------------------------------------------------------------
// Skoll (always available within the tool-use loop)
// ---------------------------------------------------------------------------

export const skollTool: ToolDef = {
  name: 'skoll',
  description: 'Estimate the village win rate for executing each surviving seat today, enumerated over every world consistent with the public log. Output: per-seat win rate (-1.3..+1.0), the tied-best seat group, and the overall win rate of the best move. Supports optional hypothetical assumptions to ask "if seat-3 is wolf, which lynch maximises village win rate?".',
  input_schema: {
    type: 'object',
    properties: {
      assumptions: {
        type: 'array',
        description: 'Hypothetical role assignments to constrain the analysis. Empty array means analyze with no extra assumptions (your own role is always assumed).',
        items: {
          type: 'object',
          properties: {
            seat: { type: 'integer', minimum: 1 },
            role: { type: 'string', description: 'System role identifier (e.g. werewolf, seer, fanatic).' },
          },
          required: ['seat', 'role'],
        },
      },
    },
    required: ['assumptions'],
  },
}

// ---------------------------------------------------------------------------
// Hati (always available within the tool-use loop)
// ---------------------------------------------------------------------------

export const hatiTool: ToolDef = {
  name: 'hati',
  description: 'Check if the village has a forced winning strategy ("tsumi") from the current position. Returns a boolean judgment plus the threat profile (rope count, required executions, surviving non-village threats). If tsumi is found, also returns the AND-OR strategy tree showing the execution plan. Supports optional hypothetical assumptions to ask "if seat-3 is wolf, is the village in tsumi?".',
  input_schema: {
    type: 'object',
    properties: {
      assumptions: {
        type: 'array',
        description: 'Hypothetical role assignments to constrain the analysis. Empty array means analyze with no extra assumptions (your own role is always assumed).',
        items: {
          type: 'object',
          properties: {
            seat: { type: 'integer', minimum: 1 },
            role: { type: 'string', description: 'System role identifier (e.g. werewolf, seer, fanatic).' },
          },
          required: ['seat', 'role'],
        },
      },
    },
    required: ['assumptions'],
  },
}

// ---------------------------------------------------------------------------
// Deception speech-writer (non-village roles only)
// ---------------------------------------------------------------------------

export const craftDeceptionTool: ToolDef = {
  name: 'craft_deception',
  description: 'Internal helper for non-village roles. Calls a separate LLM that writes one polished Japanese utterance disguised as villager-style. Use this when you want to lie or bluff and need help producing wording that does NOT leak your faction. The returned text can be used verbatim as the argument to a subsequent `say` call.',
  input_schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'What this utterance should accomplish (e.g. "fake_seer_co", "shift suspicion off self", "appear sympathetic to village", "discredit seat-7\'s CO").',
      },
      topic: {
        type: 'string',
        description: 'The concrete content to convey (e.g. "I divined seat-4 and they were black"; "seat-2 has been suspicious because X and Y").',
      },
      style_hint: {
        type: 'string',
        description: 'Optional brevity/tone hint (e.g. "very short", "calm", "match my usual register").',
      },
    },
    required: ['intent', 'topic'],
  },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const allTools: Record<ToolName, ToolDef> = {
  say: sayTool,
  pass: passTool,
  seer_co: seerCoTool,
  medium_co: mediumCoTool,
  bodyguard_co: bodyguardCoTool,
  mason_co: masonCoTool,
  nekomata_co: nekomataCoTool,
  report_divination: reportDivinationTool,
  report_medium: reportMediumTool,
  vote: voteTool,
  divine: divineTool,
  guard: guardTool,
  attack: attackTool,
  retar: retarTool,
  skoll: skollTool,
  hati: hatiTool,
  craft_deception: craftDeceptionTool,
}
