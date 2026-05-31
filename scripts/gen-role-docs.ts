// 役職一覧を 1 ページ HTML に書き出すスクリプト。
//
// 2 系統のソースから情報を集約:
//   - 役職メタ情報 / 各役職が持つ trait リスト: `systemRoles` を実 import
//   - trait sub 値の説明文: ts-morph で `src/types/index.ts` の `XxxTrait`
//     type alias の TSDoc コメントを抽出
//
// 使い方:
//   node --experimental-strip-types scripts/gen-role-docs.ts [出力パス]
// 出力パス省略時のデフォルト: tmp/roles.html

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Project, Node, SyntaxKind, type TypeLiteralNode } from 'ts-morph'
import { systemRoles } from '../src/types/index.ts'

const TYPES_PATH = 'src/types/index.ts'
const outPath = resolve(process.argv[2] ?? 'tmp/roles.html')

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// `src/types/index.ts` の `XxxTrait` type alias を走査し、
// `{ kind: 'X', sub: 'Y' }` 構造から (kind, sub) を取り出し、
// TSDoc の description 部分を当てる。
function extractTraitDescriptions(): Map<string, string> {
  const project = new Project({ skipAddingFilesFromTsConfig: true })
  const sf = project.addSourceFileAtPath(TYPES_PATH)

  function getLiteralProp(typeLit: TypeLiteralNode, propName: string): string | null {
    const member = typeLit.getMembers().find(
      m => Node.isPropertySignature(m) && m.getName() === propName,
    )
    if (!member || !Node.isPropertySignature(member)) return null
    const tn = member.getTypeNode()
    if (!tn || !Node.isLiteralTypeNode(tn)) return null
    const lit = tn.getLiteral()
    if (!Node.isStringLiteral(lit)) return null
    return lit.getLiteralText()
  }

  const map = new Map<string, string>()
  for (const alias of sf.getTypeAliases()) {
    const name = alias.getName()
    if (name === 'RoleTrait') continue
    if (!name.endsWith('Trait')) continue

    const typeLit = alias.getTypeNode()?.asKind(SyntaxKind.TypeLiteral)
    if (!typeLit) continue

    const kind = getLiteralProp(typeLit, 'kind')
    const sub = getLiteralProp(typeLit, 'sub')
    if (!kind || !sub) continue

    const desc = alias.getJsDocs()[0]?.getDescription().trim() ?? ''
    map.set(`${kind}:${sub}`, desc)
  }
  return map
}

const traitDescriptions = extractTraitDescriptions()

function renderRole(role: ReturnType<typeof systemRoles.get> & {}): string {
  const traits = role.traits.length === 0
    ? '<li><em>(なし)</em></li>'
    : role.traits.map(t => {
        const key = `${t.kind}:${t.sub}`
        const desc = traitDescriptions.get(key) ?? ''
        const descHtml = desc ? ` <span class="trait-desc">— ${escapeHtml(desc)}</span>` : ''
        return `<li><code>${escapeHtml(key)}</code>${descHtml}</li>`
      }).join('')
  return `
  <section class="role">
    <h2>${escapeHtml(role.name)} <span class="short">(${escapeHtml(role.shortName)})</span></h2>
    <dl class="meta">
      <dt>systemName</dt><dd><code>${escapeHtml(role.systemName)}</code></dd>
      <dt>faction</dt><dd>${escapeHtml(role.faction)}</dd>
      <dt>alignment</dt><dd>${escapeHtml(role.alignment)}</dd>
      <dt>category</dt><dd>${escapeHtml(role.category)}</dd>
      <dt>seerResult</dt><dd>${escapeHtml(String(role.seerResult))}</dd>
      <dt>mediumResult</dt><dd>${escapeHtml(String(role.mediumResult))}</dd>
      <dt>humanCount / wolfCount</dt><dd>${role.humanCount} / ${role.wolfCount}</dd>
    </dl>
    <p class="desc">${escapeHtml(role.description).replace(/\n/g, '<br>')}</p>
    <h3>Traits</h3>
    <ul class="traits">${traits}</ul>
  </section>`
}

const sections = Array.from(systemRoles.values()).map(renderRole).join('\n')

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Horkew 役職一覧</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif; max-width: 820px; margin: 2em auto; padding: 0 1em; color: #222; line-height: 1.6; }
  h1 { border-bottom: 2px solid #333; padding-bottom: 0.3em; }
  h2 { margin-top: 2em; border-bottom: 1px solid #ccc; padding-bottom: 0.2em; }
  h3 { margin-top: 1em; font-size: 1em; color: #555; }
  .short { color: #888; font-weight: normal; font-size: 0.8em; }
  .meta { display: grid; grid-template-columns: 12em 1fr; gap: 0.2em 1em; margin: 0.5em 0; font-size: 0.9em; }
  .meta dt { color: #666; }
  .meta dd { margin: 0; }
  .desc { background: #f6f6f6; padding: 0.6em 1em; border-left: 3px solid #aaa; }
  .traits { padding-left: 1.4em; }
  .traits code { background: #f0f0f0; padding: 0.1em 0.4em; border-radius: 3px; }
  .trait-desc { color: #555; }
  code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.92em; }
</style>
</head>
<body>
<h1>Horkew 役職一覧 <span class="short">(generated from <code>src/types/index.ts</code>)</span></h1>
${sections}
</body>
</html>
`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, html, 'utf8')
process.stderr.write(`wrote ${outPath} (${systemRoles.size} roles, ${traitDescriptions.size} trait descriptions)\n`)
