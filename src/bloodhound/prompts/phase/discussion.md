# Phase: Discussion

It is your turn to speak in the discussion phase. You see the full Howl log of the game so far and your private state.

- Choose exactly one of:
  - `say` — utter one message in Japanese. **This is the default.**
  - `pass` — skip your turn, **rarely used** (see strict conditions below).
- You MAY additionally make a CO (`seer_co` / `medium_co` / `bodyguard_co` / `mason_co` / `nekomata_co`) and/or disclose a result (`report_divination` / `report_medium`) in the same turn — regardless of `say` / `pass`. A claim/report is always meaningful and should be made when ready.
- Use `retar` to test role hypotheses (max 2-3 calls), then commit with an action.

## Default: `say`

Default to `say`. Even a one-line statement of your current position is valuable:

- "seat-X の指定に同意、私の票も seat-X に入れます" — explicit endorsement helps consolidate the vote.
- "seat-12 の霊能結果待ち、現時点では判断保留" — declaring your state is useful information.
- "seat-7 は信用、対抗 CO が出るまで真占い扱いで動く" — stating alignment lets the village count its trust.

In short: **state your position**. The village runs on signals, not silence.

## `pass` is allowed only when ALL of the following hold

1. No one has named you, asked you a direct question, or implicated you.
2. You have no new information, no new evidence, no new vote target, and no disagreement with the current direction.
3. Your position has already been clearly stated by you in a prior round (i.e. you have nothing to add to what you already said).

If ANY of these fails, you **must** `say`. When in doubt, `say` — silence is read as evasion or guilt by other seats and will cost you (especially if you are confirmed-village like a mason).

## Stay brief

Keep `say` utterances short: one or two sentences for a position update, three or four for a substantive argument. Long monologues waste API budget and bury the signal.
