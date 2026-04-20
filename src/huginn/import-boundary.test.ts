/**
 * Independence guard: src/huginn/ must not import werewolf-domain modules.
 * Allowed: ../fenrir/src/ml/transformer, ../fenrir/src/ml/nn (汎用 NN 部品のみ)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HUGINN_DIR = dirname(fileURLToPath(import.meta.url))

const FORBIDDEN_PREFIXES = [
  '../skoll/',
  '../retar/',
  '../hati/',
  '../lupa/',
  '../types/',
  '../howl/',
  '../fenrir/src/agents/',
  '../fenrir/src/adapters/',
  '../fenrir/src/ext',
  '../fenrir/src/observation',
  '../fenrir/src/plan/',
  '../fenrir/src/handlers/',
  '../fenrir/src/ml/transformer-network',
]

describe('import boundary', () => {
  const files = readdirSync(HUGINN_DIR).filter(f => f.endsWith('.ts'))

  for (const file of files) {
    if (file === 'import-boundary.test.ts') continue
    it(`${file} does not import werewolf-domain modules`, () => {
      const content = readFileSync(join(HUGINN_DIR, file), 'utf-8')
      for (const forbidden of FORBIDDEN_PREFIXES) {
        const pattern = `from '${forbidden}`
        assert.ok(
          !content.includes(pattern),
          `${file}: forbidden import detected (${forbidden})`,
        )
      }
    })
  }
})
