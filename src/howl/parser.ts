import { preprocess, type Line } from './preprocess.ts'
import { parseStatement, type Statement } from './statement.ts'

export function parse(text: string): { meta: any, statements: Statement[] } {
  const { meta, lines }: { meta: any; lines: Line[] } = preprocess(text)
  const statements: Statement[] = []

  for (const line of lines) {
    const { number, content } = line
    try {
      const statement = parseStatement( content, number )
      statements.push(statement)
    } catch (error) {
      console.error(`Error parsing line ${number}: ${content}`, error)
    }
  }

  return { meta, statements }
}
