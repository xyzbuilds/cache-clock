import { expect, mock, test } from 'claude-code/testing'

import { PRICING_PAGE } from './fixtures'

const HOUR = 3_600_000
const USAGE = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 2000 }
const HINT = { plugin: 'cache-clock', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } }

test('a line under the prompt counts the cache down, turns cold, and says what the next message costs', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const logs: string[] = []
  let usage = USAGE
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }] } }) as never)
  on('command.register', ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.log', ($, e) => {
    logs.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return e.component === 'PromptHint' ? <Text>? for shortcuts</Text> : <Box />
  })

  const turn = async (id: string) => {
    await $.turn.start({ text: 'go', turnId: id } as never)
    const step = $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 3 } as never)
    for await (const chunk of step) void chunk
    await step.result
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' } as never)
    await clock.advance(1)
  }

  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true } as never)
  let line = await $.ui.mount(HINT as never)
  expect(await line.find({ type: 'Text', text: /cache/ })).toBeUndefined()
  await line.unmount()

  await turn('t1')
  await clock.advance(60_000)
  line = await $.ui.mount(HINT as never)
  expect(await line.find({ type: 'Text', text: 'cache ● 1h ' })).toBeDefined()
  expect(await line.find({ type: 'Text', text: ' 59m left' })).toBeDefined()
  expect(await line.find({ type: 'Text', text: /hit \d+% · misses 0 · next ≈ \$0\.05/ })).toBeDefined()
  expect(await line.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  await line.unmount()

  await clock.advance(HOUR)
  line = await $.ui.mount(HINT as never)
  expect(await line.find({ type: 'Text', text: 'cache ○ cold' })).toBeDefined()
  expect(await line.find({ type: 'Text', text: / · next message re-caches 183k tokens ≈ \$1\.47/ })).toBeDefined()
  await line.unmount()
  expect(logs.filter(l => l.startsWith('Prompt cache expired')).length).toBe(1)

  usage = { ...USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 183_000 }
  await turn('t2')
  line = await $.ui.mount(HINT as never)
  expect(await line.find({ type: 'Text', text: /misses 1/ })).toBeDefined()
  await line.unmount()
  expect(logs.some(l => l.startsWith('Cache rebuilt'))).toBe(false)

  const pane = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'Pane', requestId: 'cache-clock', props: { title: 'Prompt cache', isFocused: false, bodyColumns: 60, placement: 'dock' } } as never)
  expect(await pane.find({ type: 'Text', text: 'NEXT MESSAGE' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /of the 1M window/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /expired after 1h 1m idle/ })).toBeDefined()
  await pane.unmount()
})

test('headless runs draw nothing', async ($, on) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>? for shortcuts</Text>
  })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: false } as never)
  const line = await $.ui.mount(HINT as never)
  expect(await line.find({ type: 'Text', text: /cache/ })).toBeUndefined()
  await line.unmount()
})

test('a conversation resumed after three hours opens cold and suggests starting fresh', async ($, on) => {
  const clock = mock.clock(on, { now: 50_000_000 })
  const logs: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, breakdown: { categories: [{ name: 'System prompt', tokens: 10_000 }, { name: 'Memory files', tokens: 12_000 }, { name: 'Messages', tokens: 160_000 }] } }, rateLimits: [] } }) as never)
  on('command.register', ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.log', ($, e) => {
    logs.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('classic.SessionStart', () => ({}) as never)
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return e.component === 'PromptHint' ? <Text>? for shortcuts</Text> : <Box />
  })

  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true } as never)
  await $.classic.SessionStart({ source: 'resume', model: 'claude-opus-5-5', seconds_since_last_response: 3 * 3600, context_tokens: 182_000, prompt_cache_likely_expired: true } as never)
  await clock.advance(1)

  const line = await $.ui.mount(HINT as never)
  expect(await line.find({ type: 'Text', text: 'cache ○ cold' })).toBeDefined()
  expect(await line.find({ type: 'Text', text: / · next message re-caches 182k tokens ≈ \$0\.91/ })).toBeDefined()
  expect(await line.find({ type: 'Text', text: / · start fresh ≈ \$0\.11 \(\/clear\)/ })).toBeDefined()
  await line.unmount()
  expect(logs.filter(l => l.startsWith('Prompt cache expired') && l.includes('Starting fresh with /clear')).length).toBe(1)

  const pane = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'Pane', requestId: 'cache-clock', props: { title: 'Prompt cache', isFocused: false, bodyColumns: 70, placement: 'dock' } } as never)
  expect(await pane.find({ type: 'Text', text: 'WHAT TO DO' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Start fresh with \/clear/ })).toBeDefined()
  await pane.unmount()
})

test("prices follow Anthropic's pricing page, read once a day", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fetched: string[] = []
  const stored: unknown[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }] } }) as never)
  on('command.register', ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', ($, e) => {
    stored.push(e)
    return { value: undefined } as never
  })
  on('http.fetch', ($, e) => {
    fetched.push((e as { url: string }).url)
    const page = PRICING_PAGE.replace('| $0.20 / MTok<sup>2</sup> |', '| $0.40 / MTok<sup>2</sup> |').replace('| $8 / MTok       |', '| $16 / MTok      |')
    return { value: { status: 200, ok: true, headers: {}, text: page } } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE } as never
  })
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return e.component === 'PromptHint' ? <Text>? for shortcuts</Text> : <Box />
  })

  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(2_001)
  expect(fetched).toEqual(['https://platform.claude.com/docs/en/about-claude/pricing.md'])
  expect(stored.length).toBe(1)

  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as never)
  for await (const chunk of step) void chunk
  await step.result
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.advance(60_000)

  const line = await $.ui.mount(HINT as never)
  expect(await line.find({ type: 'Text', text: /next ≈ \$0\.09/ })).toBeDefined()
  await line.unmount()
})

