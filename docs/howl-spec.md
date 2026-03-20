# Howl Notation Specification

Howl (Horkew OutLine Log) is a compact text notation for recording Werewolf/Mafia game logs. It is designed to be quick to type during live games, tolerant of Japanese IME input, and parseable into structured game event data.

## Document Structure

A `.howl` document consists of two optional sections:

```
---
YAML frontmatter
---
body (statements, one per line)
```

### Frontmatter

Optional YAML block delimited by `---`. Contains metadata such as game setup configuration.

```yaml
---
setup:
  villager: 4
  werewolf: 2
  seer: 1
  medium: 1
  bodyguard: 1
  possessed: 1
---
```

If no `setup` is provided, defaults are inferred from player count.

### Body

The body is processed line by line. Each line is parsed as a **statement**.

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

### 1. Join (`join`)

Registers players into the game.

**Syntax**: `+` followed by a delimiter-separated list of player names.

```
+Alice, Bob, Charlie, David
＋アリス、ボブ、チャーリー
```

**Hoisting**: Join statements are hoisted — they are always processed first regardless of their position in the document.

**Output**: `{ type: 'join', players: string[] }`

### 2. Vote (`vote`)

A single player votes for another.

**Syntax**: `voter → target`

```
Alice→Bob
アリス -> ボブ
```

**Output**: `{ type: 'vote', voter: string, target: string }`

### 3. Multi Vote (`multiVote`)

Multiple players vote for the same target, or declares that all remaining (unvoted) players vote for the target.

**Syntax**: `target ← voter1, voter2, ...` or `target ←` (empty voters)

```
Bob←Alice, Charlie, David
ボブ＜ーアリス、チャーリー
Bob←
```

When voters are **empty**, it means "all surviving players who have not yet voted this round vote for the target."

**Notation mixing**: Normal vote (`→`) and multi vote (`←`) notations cannot be mixed in the same round. When the notation style changes, it is treated as an implicit revote — the vote round is reset.

**Output**: `{ type: 'multiVote', voters: string[], target: string }`

An empty `voters` array indicates the "all remaining" semantic.

### 4. Attack (`attack`)

Night kill(s). Advances the day counter.

**Syntax**: `襲撃` or `噛み` followed by delimiter and target(s). For single-target actions, the delimiter may be omitted and the order may be transposed (e.g., `target噛`).

```
襲撃 Alice
噛み：アリス、ボブ
アリス噛
```

**Output**: `{ type: 'attack', target: string[] }`

### 5. Lynch (`lynch`)

Daytime execution of a player, or declaration that no execution occurred.

**Syntax**: `吊り` or `処刑` followed by delimiter and target, or followed by a "none" keyword.

```
吊り Alice
処刑：ボブ
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

### 6. Revote (`revote`)

Resets all vote state. Optionally lists candidates for a final vote.

**Syntax**: `再投票` optionally followed by candidate names, or `---`/`===` (dashes/equals, 2+).

```
再投票 Alice, Bob
再投票
---
===
```

When targets are empty, it is a simple revote reset with no candidate restriction.

**Output**: `{ type: 'revote', targets: string[] }`

### 7. Over (`over`)

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

### 8. Peace (`peace`)

No night kill occurred. Advances the day counter.

**Syntax**: `平和`

```
平和
```

**Output**: `{ type: 'peace' }`

### 9. Mason (`mason`)

Shorthand for declaring mason (共有) players. Parsed as an assert statement.

**Syntax**: `共有` (or variants) followed by delimiter and player names.

```
共有 Alice, Bob
共：アリス、ボブ
```

**Output**: `{ type: 'assert', actor: string, assertions: [{ player, roles: ['mason'] }, ...] }`

### 10. Assert (`assert`)

Role claims and divination/medium/guard action results.

**Syntax**: `actor: [roleCO] [history...]`

Where:
- **roleCO**: Role name + `CO` (coming out). `CO` is case-insensitive (`CO`, `co`, `Co`, `ＣＯ`).
- **history**: Sequence of `[day] [target] action` entries
  - **action**: `白`/`◯`/`○` (human), `黒`/`●` (wolf), or `護衛`/`ガード` (guard)
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

If the CO text does not match any known role, the claim is inferred as `nonVillage`.

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
```

**Roles recognized**: 占い/seer, 霊媒/medium, 護衛/bodyguard, 共有/mason, 猫又/nekomata. If no known role matches, `nonVillage` is inferred.

**Output**: `{ type: 'assert', actor: string, assertions: Assertion[] }`

Each assertion contains:
- `player`: The actor making the claim
- `roles?`: Role(s) claimed (on CO entries)
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

### 11. Reveal (`reveal`)

Reveals a player's actual role (post-game or GM disclosure).

**Syntax**: `player = role`

```
Alice=占い
ボブ＝人狼
```

**Output**: `{ type: 'reveal', player: string, role: string }`

### 12. Unknown (`unknown`)

Any line that does not match the above parsers.

**Output**: `{ type: 'unknown', text: string }`

## Parser Priority

Statements are tried in this order. The first match wins:

1. `join`
2. `vote`
3. `multiVote`
4. `attack`
5. `lynch`
6. `revote`
7. `over`
8. `peace`
9. `mason`
10. `assert`
11. `reveal`
12. `unknown` (fallback)

## Example Game Log

```howl
---
setup:
  villager: 3
  werewolf: 1
  seer: 1
  medium: 1
  bodyguard: 1
  possessed: 1
---
# Day 1
+アリス、ボブ、チャーリー、デイビッド、エマ、フランク、ジョージ、ハナ

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
