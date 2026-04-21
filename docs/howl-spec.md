# Howl Notation Specification

Howl (Horkew OutLine Log) is a compact text notation for recording Werewolf/Mafia game logs. It is designed to be quick to type during live games, tolerant of Japanese IME input, and parseable into structured game event data.

## Document Structure

A `.howl` document is processed line by line. Each line is parsed as a **statement**.

- **Blank lines** are ignored.
- **Comment lines** starting with `#` are ignored.
- **Spoiler split**: If a line contains `!`, it is split into two statements at that position. The part before `!` and the part starting with `!` are each treated as separate lines.

## Lexical Elements

Howl accepts both ASCII and Japanese full-width characters interchangeably to accommodate Japanese IME input.

### Whitespace

Spaces (U+0020), full-width spaces (U+3000), and tabs are treated as optional whitespace. Leading and trailing whitespace on each line and around operators is ignored.

### Delimiters

Any of: `,` `;` `:` `、` `，` `；` `：` and whitespace. Used to separate lists of player names.

### Arrows

| Direction | Accepted forms |
|-----------|---------------|
| Right arrow (→) | `→` `⇒` `⟶` `⟹` `➡️` `->` `=>` `ー＞` `＝＞` |
| Left arrow (←) | `←` `⇐` `⟵` `⟸` `⬅️` `<-` `<=` `＜ー` `＜＝` |

### Player Names

Any sequence of non-whitespace, non-delimiter characters. Player names can be abbreviated as long as they uniquely identify a player. Hiragana/katakana differences are ignored.

Resolution priority:
1. **Prefix match**: Unique match from the start of the name (e.g., `二郎` matches `二郎三郎` over `裕二郎`)
2. **Substring match**: Unique substring match anywhere in the name
3. **2-char omit match** (2-character input only): Match treating the input as the first and last characters with one character omitted in between

## Statement Types

Statements are parsed in priority order. The first matching parser wins.

### 1. Video Source (`videoSource`)

Marks a video URL for timestamp synchronization.

**Syntax**: `@` or `＠` followed by an HTTP/HTTPS URL.

```
@https://youtube.com/watch?v=XXXXX
＠https://example.com/video.mp4
```

**Output**: `{ type: 'videoSource', url: string }`

### 2. Timestamp (`timestamp`)

Marks a time position in the associated video. Can appear as a standalone line or inline at the end of any other statement.

**Syntax**: `@MM:SS` or `@H:MM:SS` (full-width `＠` also accepted).

```
@15:40
@1:05:30
```

**Inline**: Appended at the end of any statement line. The timestamp is stripped and stored as a `timestamp` field on the resulting statement.

```
チャーリー処刑 @15:40
襲撃 アリス @1:05:30
```

**Output** (standalone): `{ type: 'timestamp', seconds: number }`

**Output** (inline): The host statement gains `timestamp: number` (in seconds).

### 3. Setup (`setup`)

Declares the role composition of the game. If omitted, defaults are inferred from player count.

**Syntax**: `配役`, `レギュレーション`, `レギュ`, or `setup` followed by role-count pairs.

```
配役 村4 占1 霊1 狩1 共2 猫1 狼3 狂1 狐1 背1
レギュ 村6 占1 霊1 狩1 狼2 狂1
setup 村2 占1 狼1 狂1
```

Delimiters between pairs can be spaces, commas, etc. Full-width digits are accepted (e.g., `村４ 占１`).

**Role shorthands**: See [Role Names](#role-names-for-co) for the full list. Additionally, `村`/`村人` (villager) is used for the base villager count.

**Output**: `{ type: 'setup', setup: Record<string, number> }`

### 4a. Join Multi (`joinMulti`)

Registers multiple players into the game in a single line.

**Syntax**: `++` followed by a delimiter-separated list of player names (space, `,`, `、` etc.).

```
++Alice, Bob, Charlie, David
＋＋アリス、ボブ、チャーリー
++Alice Bob Charlie
```

Names containing spaces or delimiters can be quoted with `"`, `'`, or their full-width/smart variants. Any quote character from the same family (single or double) can open or close interchangeably.

```
++"Alice Smith", Bob, Charlie
++"藤澤 仁" "児玉　健" ボブ
```

**Hoisting**: Join statements are hoisted — they are always processed first regardless of their position in the document.

**Output**: `{ type: 'joinMulti', players: string[] }`

### 4b. Join (`join`)

Registers a single player per line, with optional short display name and search aliases.

**Syntax**: `+` followed by the player's name, optionally with a parenthesized short name and additional aliases.

```
+ Alice
+ Alice(Al)
+ Alice(Al), アリス, ally
＋ ボブ（ボ）、Bob
```

- First token: player name, optionally with `(shortName)` or `（shortName）` suffix
- Subsequent tokens: search aliases registered in the flexible dictionary

Quoted names are supported, same as `joinMulti`:

```
+ "Alice Smith"(Al) アリス
```

**Hoisting**: Same as `joinMulti`.

**Output**: `{ type: 'join', name: string, shortName?: string, aliases: string[] }`

### 5. Vote (`vote`)

A single player votes for another.

**Syntax**: `voter → target`

```
Alice→Bob
アリス -> ボブ
```

**Output**: `{ type: 'vote', voter: string, target: string }`

### 6. Multi Vote (`multiVote`)

Multiple players vote for the same target, or declares that all remaining (unvoted) players vote for the target.

**Syntax**: `target ← voter1, voter2, ...` or `target ←` (empty voters)

```
Bob←Alice, Charlie, David
ボブ＜ーアリス、チャーリー
Bob←
```

When voters are **empty**, it means "all surviving players who have not yet voted this round vote for the target."

**Output**: `{ type: 'multiVote', voters: string[], target: string }`

An empty `voters` array indicates the "all remaining" semantic.

### 7. Attack (`attack`)

Night kill(s). Advances the day counter.

**Syntax**: `襲撃`, `噛み`, `噛`, or `死亡` followed by delimiter and target(s). For single-target actions, the delimiter may be omitted and the order may be transposed (e.g., `target噛`).

```
襲撃 Alice
噛み：アリス、ボブ
アリス噛
```

**Output**: `{ type: 'attack', target: string[] }`

### 8. Lynch (`lynch`)

Daytime execution of a player, or declaration that no execution occurred. Supports transposition for single-target (e.g., `ボブ吊り`).

**Syntax**: `吊り` or `処刑` followed by delimiter and target, or followed by a "none" keyword.

```
吊り Alice
処刑：ボブ
ボブ吊り
```

To indicate no execution took place, append `なし`, `無し`, or `ナシ` (optionally preceded by `者`):

```
処刑者なし
処刑なし
吊りなし
吊無し
処刑ナシ
```

**Output**: `{ type: 'lynch', target: string | null }`

When `target` is `null`, no player is executed on that day.

### 9. Curse (`curse`)

Nekomata's death curse — a player is killed as a side effect of the nekomata dying. Supports transposition.

**Syntax**: `道連れ` or `猫又の呪い` followed by target.

```
道連れ ボブ
猫又の呪い アリス
```

**Output**: `{ type: 'curse', target: string }`

### 10. Follow (`follow`)

Immoralist's follow-death — the immoralist dies when their linked werehamster dies. Supports transposition.

**Syntax**: `後追い` followed by target.

```
後追い ボブ
```

**Output**: `{ type: 'follow', target: string }`

### 11. Revote (`revote`)

Resets all vote state. Optionally lists candidates for a final vote.

**Syntax**: `再投票` optionally followed by candidate names, or separator lines (`--`, `==`, `ーー`, `＝＝`, each 2+ characters).

```
再投票 Alice, Bob
再投票
---
===
ーーー
＝＝＝
```

When targets are empty, it is a simple revote reset with no candidate restriction.

**Output**: `{ type: 'revote', targets: string[] }`

### 12. Over (`over`)

Declares the game result.

**Syntax**: Alignment + win keyword, or win keyword + alignment, or draw keyword.

```
村勝ち
勝ち：村人陣営
人狼陣営勝利
引き分け
```

| Result | Keywords |
|--------|----------|
| Village win | `村` / `村人` / `市民` / `村人陣営` + `勝` variants |
| Wolf win | `人狼` / `狼` + `勝` variants |
| Hamster win | `妖狐` / `狐` + `勝` variants |
| Draw | `引き分け` variants |

**Output**: `{ type: 'over', result: 'villageWin' | 'wolfWin' | 'hamsterWin' | 'draw' }`

### 13. Peace (`peace`)

No night kill occurred. Advances the day counter.

**Syntax**: `平和`

```
平和
```

**Output**: `{ type: 'peace' }`

### 14. Mason (`mason`)

Shorthand for declaring mason (共有) players.

**Syntax**: `共有` (or variants) followed by delimiter and player names.

```
共有 Alice, Bob
共：アリス、ボブ
```

**Output**: `{ type: 'mason', players: string[] }`

### 15. Assert (`assert`)

Role claims and divination/medium/guard action results.

**Syntax**: `actor: [roleCO] [history...]`

Where:
- **roleCO**: Role name + `CO` (coming out). `CO` is case-insensitive (`CO`, `co`, `Co`, `ＣＯ`).
- **history**: Sequence of `[day] [target] action` entries
  - **action**: `白`/`◯`/`○`/`〇` (human), `黒`/`●` (wolf), or `護衛`/`護`/`ガード` (guard)
  - **day**: Optional, e.g. `3日`, `3日目`, `3d`, `3day`, `３ｄ`

#### Role Names for CO

Each role accepts multiple notations:

| Role | Accepted forms | Example CO |
|------|---------------|------------|
| Seer (占い師) | `占い師`, `占い`, `占`, `預言者`, `預言`, `予言者`, `予言` | `占いCO`, `占CO`, `預言者CO` |
| Medium (霊媒師) | `霊媒師`, `霊媒`, `霊能者`, `霊能`, `霊` | `霊媒CO`, `霊CO`, `霊能者CO` |
| Bodyguard (狩人) | `護衛`, `護`, `狩人`, `狩り`, `狩` | `狩人CO`, `護衛CO`, `狩CO` |
| Mason (共有者) | `共有者`, `共有`, `共` | `共有CO`, `共CO` |
| Nekomata (猫又) | `猫又`, `猫` | `猫又CO`, `猫CO` |
| Fanatic (狂信者) | `狂信者`, `狂信`, `信` | `狂信CO`, `信CO` |

Fanatic (狂信者) is a separate role from Possessed (狂人). The fanatic knows werewolf identities from the start but is otherwise similar to possessed.

If the CO text does not match any known role, the claim is inferred as `nonVillage`.

#### Negative CO and Multi-role CO (ギドラ)

A `非` prefix denotes a negative claim — the player asserts they are NOT the given role:

```
ボブ: 非占いCO    # "I am NOT a seer"
```

Multiple roles in a single CO denote a multi-role claim (ギドラ). The player claims to be one of the listed roles without specifying which:

```
アリス: 猫狩CO    # "I am either nekomata or bodyguard"
```

#### Plain Villager CO (素村CO / 村人CO)

`素村CO`, `素村人CO`, and `村人CO` all deny every village power role at once — equivalent to claiming "I am none of seer, medium, bodyguard, mason, or nekomata."

```
ボブ: 素村CO      # denies seer, medium, bodyguard, mason, nekomata
チャーリー: 村人CO  # same effect
```

#### Non-village CO (人外CO etc.)

`人外CO`, `人狼CO`, `狂人CO`, `妖狐CO`, `狂信者CO`, and `背徳者CO` all deny every village role at once (villager + 5 power roles) — equivalent to claiming "I am on the scum team." The specific scum role is not distinguished; all six notations produce the same denial constraint.

```
ボブ: 人外CO      # denies villager, seer, medium, bodyguard, mason, nekomata
チャーリー: 人狼CO  # same effect
```

#### Medium Target Auto-fill

When a medium claimant reports results without explicit target names, the targets are automatically filled from the execution history in chronological order:

```
ボブ: 霊媒CO 白 黒    # targets filled from 1st and 2nd lynch victims
```

#### Examples

```
# Seer CO with divination results
間宮: 占いCO 辺古山白 西園寺●
Alice: 占CO Bob○ Charlie黒
田中: 預言者CO 2日山田白 3日鈴木●

# Medium CO with results
ボブ: 霊媒CO アリス白 チャーリー●
鈴木: 霊CO 2日田中○ 3日山田●

# Bodyguard CO with guard history
ハナ: 護衛CO 2日アリス護衛 3日ボブガード
Mike: 狩人CO 2d Alice護衛

# Mason CO (no history needed)
太郎: 共有CO
Alice: 共CO

# Nekomata CO
花子: 猫又CO

# CO with day numbers
ボブ: 占CO 2日目アリス白 3dayチャーリー●

# CO only, no history yet
アリス: 占いCO

# Negative CO
ボブ: 非占いCO

# Multi-role CO (ギドラ)
アリス: 猫狩CO
```

**Roles recognized**: 占い/seer, 霊媒/medium, 護衛/bodyguard, 共有/mason, 猫又/nekomata. If no known role matches, `nonVillage` is inferred.

**Output**: `{ type: 'assert', actor: string, assertions: Assertion[] }`

Each assertion contains:
- `player`: The actor making the claim
- `roles?`: Role(s) claimed (on CO entries)
- `negative?`: `true` if this is a negative claim (`非CO`)
- `target?`: Target of the action
- `result?`: `'isHuman'` or `'isWolf'` (on divination/medium results)
- `action?`: `'guard'` (on bodyguard actions)

#### Right-alignment of Results

Results in a single statement are interpreted as **right-aligned** to the current day. The last result corresponds to the previous night's action, and earlier results count backwards from there.

```
# Day 3
ハイラム：占いCO マドック白 メイソン黒
# → Night 1: マドック○, Night 2: メイソン● (Night 0 is unknown)
```

This also handles **result slides** (結果スライド): when a player corrects a previously claimed result on the same day, the new result overwrites the old one for the same night.

```
# Day 1
百面ダイス: 占いCO グロ白    # → Night 0: グロ○
百面ダイス: スレッタ黒        # → Night 0: スレッタ● (overwrites グロ○)
```

### 16. Forecast (`forecast`)

A seer claimant announces who they will divine the following night (占い予告). The actor must have already made a seer CO.

**Syntax**: `actor 予告 target`

```
アリス 予告 ボブ
```

If the seer dies that night, the forecast target is treated as divined. If the forecast target died before or during that night, the forecast is automatically invalidated (the seer would have divined someone else).

**Output**: `{ type: 'forecast', actor: string, target: string }`

### 17. Grelan (`grelan`)

Marks the following execution as a grey random vote (グレラン), indicating the executed player had no opportunity to CO a role before being lynched.

**Syntax**: `グレラン` on its own line, placed before the `lynch` statement.

```
グレラン
ボブ処刑
```

Without this marker, Retar assumes that a non-claiming executed player voluntarily chose not to CO, and denies them village roles (seer, medium, bodyguard, mason, nekomata). With `グレラン`, the executed player remains a candidate for those roles.

**Output**: `{ type: 'grelan' }`

### 18. Reveal (`reveal`)

Reveals a player's actual role (post-game or GM disclosure).

**Syntax**: `player = role`

```
Alice=占い
ボブ＝人狼
```

**Output**: `{ type: 'reveal', player: string, role: string }`

### 19. Unknown (`unknown`)

Any line that does not match the above parsers.

**Output**: `{ type: 'unknown', text: string }`

## Parser Priority

Statements are tried in this order. The first match wins:

1. `videoSource`
2. `timestamp`
3. `setup`
4. `joinMulti`
5. `join`
6. `vote`
7. `multiVote`
8. `attack`
9. `grelan`
10. `lynch`
11. `curse`
12. `follow`
13. `revote`
14. `over`
15. `peace`
16. `mason`
17. `forecast`
18. `assert`
19. `reveal`
20. `unknown` (fallback)

**Note**: Inline timestamps (`@MM:SS` at the end of a line) are stripped before this parser loop runs, so any statement can carry a `timestamp` field.

## Post-Processing Pipeline

After parsing, statements go through three post-processing passes:

1. **Multi-vote voter filling**: Empty voter lists in `multiVote` statements are expanded to all surviving, non-voted players. In final vote rounds (after revote), candidates are excluded from voting unless `rules.vote.final` is set to `revote`.
2. **Medium target filling**: For medium claimants, result assertions without explicit targets are filled from the chronological execution history.
3. **Day assignment**: Each statement receives a `day` number. Attack and peace statements advance the day counter.

## Example Game Log

```howl
配役 村3 狼1 占1 霊1 狩1 狂1

# Day 1
++アリス、ボブ、チャーリー、デイビッド、エマ、フランク、ジョージ、ハナ

ボブ: 占いCO アリス白
チャーリー: 占いCO デイビッド●

エマ→チャーリー
フランク→デイビッド
デイビッド←アリス、ボブ、チャーリー、ジョージ、ハナ
吊り デイビッド

# Night 1
襲撃 エマ

# Day 2
ボブ: デイビッド白
チャーリー: エマ白

アリス→チャーリー
チャーリー←
吊り チャーリー

# Night 2
平和

# Day 3
ボブ: フランク白
ハナ→フランク
フランク←
吊り フランク

襲撃 ハナ
村勝ち
```
