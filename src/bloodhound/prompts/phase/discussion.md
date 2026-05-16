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

## Time pressure — count your remaining chances

Your user prompt shows the round as `round R of N` (e.g. round 2 of 3). After round N the discussion ends and the village votes **immediately**. You cannot save a CO or a result for "next time" because there is no next time within this day.

- If you hold a CO, a divine result, a medium result, or any other critical information, **emit it in the EARLIEST round you can, no later than round N**. Saving it for "the right moment" routinely means missing the only moment.
- If R == N (the final round) and you have not yet COed or reported, **this is your last chance**. Saying it now means it is heard before the vote; staying silent means the information is lost AND you may be lynched as the silent suspect.
- Even a confirmed-village seat (mason, true seer, true medium) is at risk of being lynched if they give the village zero signal by the final round. Silence is read as guilt.
- Count remaining rounds at every turn: "I am in round 2 of 3, so I have this round and one more. I must CO now or risk losing the chance."
