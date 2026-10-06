// Claude API list prices in US dollars per million tokens. The mod reads Anthropic's pricing
// page (platform.claude.com/docs/en/about-claude/pricing.md) once a day; this built-in copy of
// it (2026-10-06) is the fallback.
export type Price = { name: string; input: number; write5m: number; write1h: number; read: number; output: number; isGuess?: boolean }
export type PriceTable = Record<string, Price>

export const BUILT_IN_DATE = '2026-10-06'

const row = (name: string, input: number, write5m: number, write1h: number, read: number, output: number): Price => ({ name, input, write5m, write1h, read, output })

export const BUILT_IN: PriceTable = {
  'fable-5-1': row('Fable 5.1', 10, 12.5, 20, 0.25, 50),
  'mythos-5-1': row('Mythos 5.1', 10, 12.5, 20, 0.25, 50),
  'fable-5': row('Fable 5', 10, 12.5, 20, 1, 50),
  'mythos-5': row('Mythos 5', 10, 12.5, 20, 1, 50),
  'opus-5-5': row('Opus 5.5', 4, 5, 8, 0.2, 20),
  'opus-5': row('Opus 5', 5, 6.25, 10, 0.5, 25),
  'opus-4-8': row('Opus 4.8', 5, 6.25, 10, 0.5, 25),
  'opus-4-7': row('Opus 4.7', 5, 6.25, 10, 0.5, 25),
  'opus-4-6': row('Opus 4.6', 5, 6.25, 10, 0.5, 25),
  'opus-4-5': row('Opus 4.5', 5, 6.25, 10, 0.5, 25),
  'opus-4-1': row('Opus 4.1', 15, 18.75, 30, 1.5, 75),
  'opus-4': row('Opus 4', 15, 18.75, 30, 1.5, 75),
  'sonnet-5-5': row('Sonnet 5.5', 2, 2.5, 4, 0.2, 10),
  'sonnet-5': row('Sonnet 5', 2, 2.5, 4, 0.2, 10),
  'sonnet-4-6': row('Sonnet 4.6', 3, 3.75, 6, 0.3, 15),
  'sonnet-4-5': row('Sonnet 4.5', 3, 3.75, 6, 0.3, 15),
  'sonnet-4': row('Sonnet 4', 3, 3.75, 6, 0.3, 15),
  'haiku-4-5': row('Haiku 4.5', 1, 1.25, 2, 0.1, 5),
  'haiku-3-5': row('Haiku 3.5', 0.8, 1, 1.6, 0.08, 4),
}

// The longest key a model id contains wins, so claude-opus-5-5 is Opus 5.5, not Opus 5.
export function priceOf(model: string, table: PriceTable = BUILT_IN): Price {
  const id = model.toLowerCase()
  const key = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find(k => id.includes(k))
  const opus = table['opus-5-5'] ?? BUILT_IN['opus-5-5']!
  return key ? table[key]! : { ...opus, name: model || 'this model', isGuess: true }
}

export const writePrice = (price: Price, ttlMs: number) => (ttlMs >= 3_600_000 ? price.write1h : price.write5m)

const dollars = (cell: string) => {
  const match = /\$([\d.]+)\s*\/\s*MTok/.exec(cell)
  return match ? Number(match[1]) : NaN
}

// Reads the model table of Anthropic's pricing page: Model | Base input | 5m cache writes |
// 1h cache writes | Cache hits | Output. Anything that does not look like it is refused.
export function parsePricing(markdown: string): PriceTable | undefined {
  const lines = markdown.split('\n')
  const header = lines.findIndex(l => /^\|\s*Model\s*\|/.test(l) && l.includes('5m cache writes') && l.includes('1h cache writes'))
  if (header < 0) return undefined
  const table: PriceTable = {}
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (cells.length < 6) continue
    const name = cells[0]!.replace(/\(.*\)/, '').replace(/<[^>]+>/g, '').trim()
    const values = cells.slice(1, 6).map(dollars)
    if (!/^Claude /.test(name) || values.some(v => !(v > 0))) continue
    const short = name.replace(/^Claude /, '')
    const [input, write5m, write1h, read, output] = values as [number, number, number, number, number]
    table[short.toLowerCase().replace(/[ .]+/g, '-')] = row(short, input, write5m, write1h, read, output)
  }
  const looksRight = Object.keys(table).length >= 5 && ['opus', 'sonnet', 'haiku'].every(f => Object.keys(table).some(k => k.startsWith(f)))
  return looksRight ? table : undefined
}
