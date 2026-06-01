// CLI entry for spec-annotate. Library 関数は spec-annotate.ts に分離。
import { runCli } from './spec-annotate.ts'

await runCli(process.argv.slice(2))
