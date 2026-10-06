import { expect, test } from 'claude-code/testing'

import { BUILT_IN, parsePricing, priceOf } from '../hooks/prices'
import { PRICING_PAGE } from './fixtures'

test("reads the model table from Anthropic's pricing page", () => {
  const table = parsePricing(PRICING_PAGE)!
  expect(Object.keys(table)).toEqual(['fable-5-1', 'mythos-5-1', 'opus-5-5', 'opus-5', 'sonnet-5-5', 'sonnet-5', 'haiku-4-5'])
  expect(table['opus-5-5']).toEqual({ name: 'Opus 5.5', input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 })
  expect(table['sonnet-5']!.input).toBe(2)
  expect(priceOf('claude-opus-5-5', table).name).toBe('Opus 5.5')
  expect(priceOf('claude-haiku-4-5-20251001', table).name).toBe('Haiku 4.5')
})

test('a page that no longer looks like a price table is refused', () => {
  expect(parsePricing('# Pricing\n\nSee claude.com/pricing.')).toBeUndefined()
  expect(parsePricing(PRICING_PAGE.replace(/\| Claude (Opus|Sonnet|Haiku)[^\n]*\n/g, ''))).toBeUndefined()
})

test('the built-in table agrees with the page it was copied from', () => {
  const table = parsePricing(PRICING_PAGE)!
  for (const [key, price] of Object.entries(table)) expect(BUILT_IN[key]).toEqual(price)
})
