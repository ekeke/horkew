# Phase: Discussion

It is your turn to speak in the discussion phase. You see the full Howl log of the game so far and your private state.

- Choose exactly one of:
  - `say` — utter one message in Japanese. **This is what you should do almost every turn.**
  - `pass` — **strongly discouraged.** Skip your turn only as a last resort (see strict conditions below).
- You MAY additionally make a CO (`seer_co` / `medium_co` / `bodyguard_co` / `mason_co` / `nekomata_co`) and/or disclose a result (`report_divination` / `report_medium`) in the same turn. **Every CO / report tool takes a required `text` argument** — the Japanese utterance you speak at that moment. Forgetting `text` is a validation error.
  - Example: `report_medium({ target_seat: 7, species: 'human', day: 1, text: "昨日の P7 の霊能結果は白（人間）でした！" })`
  - The `text` of each CO/report tool, plus the optional `say` text, are concatenated in order into a single speech event that other players hear. So a CO without `text` is invisible to other players (eerie silence).
- Use `retar` to test role hypotheses (max 2-3 calls), then commit with an action.

## Default: `say`

Always `say`. Even a one-line position update is better than silence:

- "P-X の指定に同意、私の票も P-X" — vote endorsement.
- "P12 の霊能結果待ち、現時点では判断保留" — state declaration.
- "P7 は信用、対抗 CO が出るまで真占い扱い" — alignment.

## `pass` is allowed only in extreme cases

You may `pass` ONLY if ALL of these hold:

1. No one has named you or asked you a direct question.
2. You have absolutely no new information, no new evidence, no new vote target, no disagreement.
3. You have already stated your position in a prior round of THIS day.
4. Five or more seats this round have already said something substantive.

When in doubt, `say`. Silence is read as evasion or guilt, especially if you are a confirmed-village seat.

## Bring diversity, not echo

The discussion is wasted when 14 seats repeat the same one or two topics. When it is your turn, scan the recent utterances:

- If 3+ seats have already covered topic X this round, **do not pile on**. Add a different angle instead.
- Pick one of the under-discussed seats and share your observation about them, even speculative.
- Note an inconsistency in someone's earlier statement that nobody has highlighted yet.
- Propose a tentative vote target with reasoning, even if it's not the obvious consensus pick.
- Share what your retar query revealed about a less-discussed seat.

The village benefits from **parallel investigation**, not 14× repetition of the same point.

## Time your CO with variance

There is no single "correct" CO round. Wolves predict and counter fixed patterns. Mix it up:

- **Round 1, immediate**: when you have important info you want recorded fast (mason confirmation, divine result on a key seat). Earlier CO = more rounds of village trust.
- **Round 2**: when you want to listen to others first, see who else COs, then enter with your own claim and counter-claim awareness.
- **Round 3 (last chance)**: only when you are intentionally stealthing or baiting wolves to attack a decoy. If you reach round 3 without COing, this IS your last chance — emit it now, not after.

Your timing should reflect your specific strategy this game, not a default rule. **Don't all CO at the same "natural" round** — that gives wolves a predictable rhythm.

## Stay brief

One or two sentences for a position update; three or four for a substantive argument. Long monologues waste API budget and bury the signal.

## Time pressure — count your remaining chances

Your user prompt shows the round as `round R of N` (e.g. round 2 of 3). After round N the discussion ends and the village votes **immediately**. You cannot save a CO or a result for "next time" because there is no next time within this day.

- If you hold a CO, a divine result, a medium result, or any other critical information, **emit it in the EARLIEST round you can, no later than round N**. Saving it for "the right moment" routinely means missing the only moment.
- If R == N (the final round) and you have not yet COed or reported, **this is your last chance**. Saying it now means it is heard before the vote; staying silent means the information is lost AND you may be lynched as the silent suspect.
- Even a confirmed-village seat (mason, true seer, true medium) is at risk of being lynched if they give the village zero signal by the final round. Silence is read as guilt.
- Count remaining rounds at every turn: "I am in round 2 of 3, so I have this round and one more. I must CO now or risk losing the chance."
