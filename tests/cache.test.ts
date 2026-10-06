import { describe, expect, test } from 'claude-code/testing'

import type { Req } from '../types'
import { adviceOf, bar, baseOf, classify, durationText, freshCost, HOUR, moneyText, nextCost, phaseOf, shortModel, tokensText, ttlOf } from '../hooks/cache'
import { priceOf } from '../hooks/prices'

const req = (over: Partial<Req> = {}): Req => ({ at: 0, model: 'claude-opus-5-5', input: 10, output: 1000, read: 180_000, write: 2000, isMiss: false, usd: 0, ...over })

describe('how long the cache lives', () => {
  test('a subscription gets an hour, API keys and usage credits five minutes, settings and env win', () => {
    expect(ttlOf({ env: {}, isSubscription: true, isOverLimit: false }).ms).toBe(HOUR)
    expect(ttlOf({ env: {}, isSubscription: true, isOverLimit: true }).why).toBe('subscription on usage credits')
    expect(ttlOf({ env: {}, isSubscription: false, isOverLimit: false }).label).toBe('5-minute cache')
    expect(ttlOf({ env: { FORCE_PROMPT_CACHING_5M: '1' }, setting: '1h', isSubscription: true, isOverLimit: false }).label).toBe('5-minute cache')
    expect(ttlOf({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, isSubscription: false, isOverLimit: false }).ms).toBe(HOUR)
    expect(ttlOf({ env: {}, setting: '1h', isSubscription: false, isOverLimit: false }).why).toBe('promptCacheTtl setting')
    expect(ttlOf({ env: { DISABLE_PROMPT_CACHING: '1' }, isSubscription: true, isOverLimit: false }).isOff).toBe(true)
  })
})

describe('prices', () => {
  test('models map to their list prices; an unknown one is flagged', () => {
    expect(priceOf('claude-opus-5-5')).toEqual({ name: 'Opus 5.5', input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 })
    expect(priceOf('claude-opus-5').input).toBe(5)
    expect(priceOf('claude-fable-5-1').read).toBe(0.25)
    expect(priceOf('us.anthropic.claude-sonnet-4-6').input).toBe(3)
    expect(priceOf('claude-opus-4-1-20250805').input).toBe(15)
    expect(priceOf('some-new-model').isGuess).toBe(true)
  })

  test('the next message: cached part at the read price while warm, all of it at the write price once cold', () => {
    const next = nextCost(req(), priceOf('claude-opus-5-5'), HOUR)
    expect(next.tokens).toBe(183_210)
    expect(next.warm.toFixed(4)).toBe('0.0460')
    expect(next.cold.toFixed(4)).toBe('1.4657')
  })
})

describe('hits and misses', () => {
  test('a normal turn reads what the last one cached', () => {
    expect(classify(req(), { ...req({ at: 60_000, read: 182_000, write: 3000 }) }, HOUR)).toEqual({ isMiss: false })
  })
  test('each miss names its likely cause', () => {
    const rebuild = { input: 10, output: 500, read: 0, write: 183_000 }
    expect(classify(req(), { ...rebuild, at: 2 * HOUR, model: 'claude-opus-5-5' }, HOUR).cause).toBe('expired after 2h idle')
    expect(classify(req(), { ...rebuild, at: 60_000, model: 'claude-sonnet-5-5' }, HOUR).cause).toBe('switched model (Opus 5.5 → Sonnet 5.5)')
    expect(classify(req(), { ...rebuild, write: 20_000, at: 60_000, model: 'claude-opus-5-5' }, HOUR).cause).toBe('conversation compacted or cleared')
    expect(classify(req(), { ...rebuild, at: 60_000, model: 'claude-opus-5-5' }, HOUR).cause).toContain('tools, MCP servers')
    expect(classify(null, { ...rebuild, at: 0, model: 'claude-opus-5-5' }, HOUR).cause).toBe('first message of the session')
  })
  test('phases: warm, low in the last quarter, expired, working', () => {
    const ttl = { ms: HOUR, label: '1-hour cache', why: 'x' }
    expect(phaseOf(req(), ttl, false, 10 * 60_000)).toBe('warm')
    expect(phaseOf(req(), ttl, false, 50 * 60_000)).toBe('low')
    expect(phaseOf(req(), ttl, false, HOUR + 1)).toBe('expired')
    expect(phaseOf(req(), ttl, true, HOUR + 1)).toBe('working')
    expect(phaseOf(null, ttl, false, 0)).toBe('none')
  })
})

test('words and numbers', () => {
  expect(tokensText(182_400)).toBe('182k')
  expect(tokensText(1_200_000)).toBe('1.2M')
  expect(moneyText(0.046)).toBe('$0.05')
  expect(moneyText(0.004)).toBe('<$0.01')
  expect(moneyText(14.6)).toBe('$15')
  expect(durationText(53_000)).toBe('53s')
  expect(durationText(59 * 60_000)).toBe('59m')
  expect(durationText(72 * 60_000)).toBe('1h 12m')
  expect(shortModel('claude-sonnet-4-6-20250929')).toBe('Sonnet 4.6')
  expect(bar(0.5, 4)).toBe('██░░')
})

describe('what to do', () => {
  const opus = priceOf('claude-opus-5-5')
  test('a fresh start counts only what every conversation begins with', () => {
    expect(baseOf([
      { name: 'System prompt', tokens: 4000 },
      { name: 'System tools', tokens: 12_000 },
      { name: 'MCP tools', tokens: 9000, isDeferred: true },
      { name: 'Memory files', tokens: 6000 },
      { name: 'Messages', tokens: 160_000 },
      { name: 'Free space', tokens: 800_000 },
      { name: 'Autocompact buffer', tokens: 30_000 },
    ])).toBe(22_000)
    expect(freshCost(22_000, opus, HOUR).toFixed(3)).toBe('0.178')
  })
  test('cold with a big conversation: start fresh; last quarter: compact before stepping away; small or warm: nothing', () => {
    expect(adviceOf(req(), 'expired', opus, HOUR, 22_000)?.text).toBe('start fresh ≈ $0.18 (/clear)')
    expect(adviceOf(req(), 'low', opus, HOUR, 22_000)?.kind).toBe('compact')
    expect(adviceOf(req(), 'warm', opus, HOUR, 22_000)).toBeUndefined()
    expect(adviceOf(req({ read: 20_000 }), 'expired', opus, HOUR, 22_000)).toBeUndefined()
  })
  test('the reply that resumes a conversation is judged on time, not on the model name it was resumed with', () => {
    const seed = req({ model: 'opus', isSeed: true, at: 0 })
    expect(classify(seed, { input: 10, output: 500, read: 0, write: 183_000, at: 3 * HOUR, model: 'claude-opus-5-5' }, HOUR).cause).toBe('expired after 3h idle')
  })
})

