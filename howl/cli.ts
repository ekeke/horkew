import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from './src/parser.ts'

const inputPath = process.argv[2]
if (!inputPath) {
  console.error('Usage: node --experimental-strip-types cli.ts <input.howl> [output.json]')
  process.exit(1)
}

const outputPath = process.argv[3] ?? inputPath.replace(/\.howl$/, '.json')

const text = readFileSync(inputPath, 'utf-8').replace(/\r\n/g, '\n')
const result = parse(text)

writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8')
console.log(`Wrote ${outputPath}`)
