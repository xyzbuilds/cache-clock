import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Clock, Req, Ttl } from '../types'
import { adviceOf, bar, baseOf, BIG_REBUILD, classify, compactCost, contextOf, costOf, durationText, FIVE_MIN, freshCost, HOUR, moneyText, nextCost, phaseOf, shortModel, tokensText, ttlOf } from './cache'
import { BUILT_IN, BUILT_IN_DATE, parsePricing, priceOf, type PriceTable, writePrice } from './prices'

const EMPTY: Clock = {
  last: null,
  history: [],
  misses: [],
  totals: { requests: 0, input: 0, output: 0, read: 0, write: 0, usd: 0 },
  ttl: { ms: FIVE_MIN, label: '5-minute cache', why: 'not known yet' },
  window: 0,
  base: 0,
  isWorking: false,
}
const clockAtom = atom({ plugin: 'cache-clock', key: 'clock' } as const, EMPTY)
const nowAtom = atom({ plugin: 'cache-clock', key: 'now' } as const, 0)

const PANE = 'cache-clock'
const TICK_MS = 5_000
const SLOW_TICK_MS = 30_000

let isActive = false
let showLine = true
let notices = true
let env: Record<string, string | undefined> = {}
let setting: unknown
let ticker: { cancel: () => void } | undefined
let drawnAt = 0
let prices: PriceTable = BUILT_IN
let pricedAt = 0
const PRICES_MS = 24 * 3_600_000

const priceFor = (model: string) => priceOf(model, prices)
let noticedExpiry = 0

// ---- prices ------------------------------------------------------------

// Anthropic's pricing page, read at most once a day and kept across sessions. When it can't
// be read or no longer looks like a price table, the last good copy or the built-in one stays.
async function loadPrices($: EngineInterface): Promise<void> {
  const held = (await $.store.get('prices')) as { table: PriceTable; at: number } | undefined
  if (held?.table) {
    prices = held.table
    pricedAt = held.at
  }
  const now = await $.clock.now()
  if (held && now - held.at < PRICES_MS) return
  const page = await $.http.fetch('https://platform.claude.com/docs/en/about-claude/pricing.md', { headers: { accept: 'text/markdown' } })
  const table = page.ok ? parsePricing(page.text) : undefined
  if (!table) return
  prices = table
  pricedAt = now
  await $.store.set('prices', { table, at: now })
}

// ---- state -------------------------------------------------------------

async function getClock($: EngineInterface): Promise<Clock> {
  return (await $.state.get({ plugin: 'cache-clock', key: 'clock' })).value ?? EMPTY
}

async function setClock($: EngineInterface, clock: Clock): Promise<void> {
  await $.state.set({ plugin: 'cache-clock', key: 'clock' }, clock)
}

async function currentTtl($: EngineInterface): Promise<{ ttl: Ttl; window: number }> {
  const usage = await $.session.usage().catch(() => undefined)
  const limits = usage?.rateLimits ?? []
  const ttl = ttlOf({
    env,
    setting,
    isSubscription: limits.some(l => l.kind === 'five_hour' || l.kind === 'seven_day'),
    isOverLimit: limits.some(l => l.percentUsed >= 100),
  })
  return { ttl, window: usage?.context.window ?? 0 }
}

async function recordStep($: EngineInterface, at: number, usage: { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): Promise<void> {
  const clock = await getClock($)
  const { ttl, window } = await currentTtl($)
  const price = priceFor(usage.model)
  const tokens = { input: usage.input_tokens, output: usage.output_tokens, read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens }
  const found = classify(clock.last, { ...tokens, at, model: usage.model }, ttl.ms)
  const req: Req = { at, model: usage.model, ...tokens, ...found, usd: costOf(tokens, price, ttl.ms) }
  const t = clock.totals
  await setClock($, {
    ...clock,
    ttl,
    window,
    last: req,
    history: [...clock.history, req].slice(-40),
    misses: req.isMiss ? [...clock.misses, req].slice(-10) : clock.misses,
    totals: { requests: t.requests + 1, input: t.input + req.input, output: t.output + req.output, read: t.read + req.read, write: t.write + req.write, usd: t.usd + req.usd },
  })
  if (clock.base === 0 || t.requests % 20 === 0) await refreshBase($)
  const wasNoticed = req.cause?.startsWith('expired') && noticedExpiry === clock.last?.at
  if (notices && req.isMiss && req.write >= BIG_REBUILD && !wasNoticed) {
    $.ui.log(`Cache rebuilt: ${tokensText(req.write)} tokens written (${req.cause}) · ≈ ${moneyText((req.write * writePrice(price, ttl.ms)) / 1e6)} at API prices`)
  }
}

async function refreshBase($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
  const categories = usage?.context.breakdown?.categories
  if (!categories) return
  const clock = await getClock($)
  await setClock($, { ...clock, base: baseOf(categories) })
}

// Claude Code says at start how long ago a resumed conversation last got a reply and
// whether its cache has likely expired; /clear starts a new conversation, /compact a
// shorter one.
async function startedFrom($: EngineInterface, e: { source: string; seconds_since_last_response?: number; context_tokens?: number; prompt_cache_likely_expired?: boolean; model?: string }): Promise<void> {
  const clock = await getClock($)
  if (e.source === 'clear') return setClock($, { ...EMPTY, ttl: clock.ttl, window: clock.window })
  if (e.source === 'compact') return setClock($, { ...clock, last: null })
  if ((e.source !== 'resume' && e.source !== 'fork') || !e.context_tokens || e.seconds_since_last_response === undefined) return
  const now = await $.clock.now()
  let { ttl } = await currentTtl($)
  let at = now - e.seconds_since_last_response * 1000
  const looksExpired = now - at >= ttl.ms
  if (e.prompt_cache_likely_expired === false && looksExpired) ttl = { ms: HOUR, label: '1-hour cache', why: 'Claude subscription' }
  if (e.prompt_cache_likely_expired === true && !looksExpired) at = now - ttl.ms - 1000
  const seed: Req = { at, model: e.model ?? '', input: 0, output: 0, read: e.context_tokens, write: 0, isMiss: false, usd: 0, isSeed: true }
  await setClock($, { ...EMPTY, ttl, window: clock.window, last: seed })
  await refreshBase($)
  await tick($, true)
}

async function setWorking($: EngineInterface, isWorking: boolean): Promise<void> {
  const clock = await getClock($)
  if (clock.isWorking !== isWorking) await setClock($, { ...clock, isWorking })
  await tick($, true)
}

// The line redraws every 30 s, every 5 s in its last two minutes. The expiry notice
// goes out once per expiry, for a context big enough to matter.
async function tick($: EngineInterface, force = false): Promise<void> {
  const now = await $.clock.now()
  const clock = await getClock($)
  const left = clock.last ? clock.last.at + clock.ttl.ms - now : Infinity
  if (force || now - drawnAt >= SLOW_TICK_MS || (left > -TICK_MS && left < 120_000)) {
    drawnAt = now
    await $.state.set({ plugin: 'cache-clock', key: 'now' }, now)
  }
  const last = clock.last
  if (!last || clock.isWorking || clock.ttl.isOff || left > 0 || noticedExpiry === last.at) return
  noticedExpiry = last.at
  const next = nextCost(last, priceFor(last.model), clock.ttl.ms)
  if (notices && next.tokens >= BIG_REBUILD) {
    const advice = adviceOf(last, 'expired', priceFor(last.model), clock.ttl.ms, clock.base)
    const fresh = advice ? ` Starting fresh with /clear: ≈ ${moneyText(advice.usd)}; save anything you need from this conversation first.` : ''
    $.ui.log(`Prompt cache expired (${clock.ttl.label}). The next message re-caches ${tokensText(next.tokens)} tokens: ≈ ${moneyText(next.cold)} at API prices, against ${moneyText(next.warm)} while it was warm.${fresh}`)
  }
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Prompt cache' })
}

// ---- drawing -----------------------------------------------------------

type View = Parameters<EngineInterface['ui']['resolve']>[0]

const COLOR = { warm: 'green', low: 'yellow', working: 'green', expired: 'red', off: 'gray', none: 'gray' } as const

function lineView($: EngineInterface, e: View, clock: Clock, now: number) {
  const { Text } = $.ui.resolve(e)
  const last = clock.last!
  const phase = phaseOf(last, clock.ttl, clock.isWorking, now)
  const color = COLOR[phase]
  const next = nextCost(last, priceFor(last.model), clock.ttl.ms)
  const t = clock.totals
  const hit = t.requests ? `${Math.round((100 * t.read) / Math.max(1, t.read + t.write + t.input))}%` : '—'
  const ttlShort = clock.ttl.ms >= 3_600_000 ? '1h' : '5m'
  const advice = adviceOf(last, phase, priceFor(last.model), clock.ttl.ms, clock.base)
  if (phase === 'off') {
    return (
      <Text wrap="truncate-end">
        <Text color="gray">cache off</Text>
        <Text>{` · each message re-sends ${tokensText(next.tokens)} tokens ≈ ${moneyText(next.cold)}`}</Text>
      </Text>
    )
  }
  if (phase === 'expired') {
    return (
      <Text wrap="truncate-end">
        <Text color="red">cache ○ cold</Text>
        <Text>{` · next message re-caches ${tokensText(next.tokens)} tokens ≈ ${moneyText(next.cold)}`}</Text>
        {advice ? <Text color="cyan">{` · ${advice.text}`}</Text> : <Text dimColor>{` (warm: ${moneyText(next.warm)})`}</Text>}
      </Text>
    )
  }
  const left = Math.max(0, last.at + clock.ttl.ms - now)
  const fraction = phase === 'working' ? 1 : left / clock.ttl.ms
  const cells = bar(fraction, 12)
  const filled = cells.replace(/░/g, '')
  return (
    <Text wrap="truncate-end">
      <Text color={color}>{`cache ● ${ttlShort} `}</Text>
      <Text color={color}>{filled}</Text>
      <Text dimColor>{cells.slice(filled.length)}</Text>
      <Text color={color}>{phase === 'working' ? ' in use' : ` ${durationText(left)} left`}</Text>
      <Text>{` · hit ${hit} · misses ${clock.misses.length} · next ≈ ${moneyText(next.warm)}`}</Text>
      {advice && <Text color="cyan">{` · ${advice.text}`}</Text>}
    </Text>
  )
}

function paneView($: EngineInterface, e: View, clock: Clock, now: number, width: number) {
  const { Box, Text } = $.ui.resolve(e)
  const rule = '─'.repeat(width)
  const last = clock.last
  const header = (
    <Box flexDirection="row" justifyContent="space-between">
      <Text bold>⏱ Prompt cache</Text>
      <Text dimColor>{`${clock.ttl.label} · ${clock.ttl.why}`}</Text>
    </Box>
  )
  if (!last) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Text dimColor>{rule}</Text>
        <Text dimColor>Nothing cached yet: the first reply starts the clock.</Text>
      </Box>
    )
  }
  const price = priceFor(last.model)
  const next = nextCost(last, price, clock.ttl.ms)
  const phase = phaseOf(last, clock.ttl, clock.isWorking, now)
  const left = Math.max(0, last.at + clock.ttl.ms - now)
  const barWidth = Math.max(10, width - 22)
  const costWidth = Math.max(10, width - 26)
  const t = clock.totals
  const hit = Math.round((100 * t.read) / Math.max(1, t.read + t.write + t.input))
  const fresh = clock.base > 0 ? freshCost(clock.base, price, clock.ttl.ms) : undefined
  const compact = compactCost(last, price)
  const options: string[] =
    phase === 'expired'
      ? [
          `Continue: ≈ ${moneyText(next.cold)} for the next message, then ≈ ${moneyText(next.warm)} a message while warm.`,
          ...(fresh !== undefined ? [`Start fresh with /clear: ≈ ${moneyText(fresh)}. Claude forgets this conversation; save what you need to a file first.`] : []),
          `/compact first: re-reads all ${tokensText(next.tokens)} tokens without the cache to summarize them, then each message is small.`,
        ]
      : [
          `Keep going: ≈ ${moneyText(next.warm)} a short message while warm.`,
          `Stepping away for longer than ${phase === 'working' ? (clock.ttl.ms >= HOUR ? 'an hour' : '5 minutes') : durationText(left)}? /compact now ≈ ${moneyText(compact)}; once cold, the next message is ≈ ${moneyText(next.cold)}.`,
        ]
  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      <Text dimColor>{rule}</Text>
      <Text color={COLOR[phase]}>
        {phase === 'expired' ? `${bar(0, barWidth)} expired` : `${bar(phase === 'working' ? 1 : left / clock.ttl.ms, barWidth)} ${phase === 'working' ? 'in use' : `${durationText(left)} left`}`}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="blue">NEXT MESSAGE</Text>
        <Text wrap="wrap">{`Re-sends ${tokensText(next.tokens)} tokens${clock.window ? ` of the ${tokensText(clock.window)} window` : ''}.`}</Text>
        <Text>
          <Text color="green">{`cache warm    ${bar(next.warm / Math.max(next.cold, 1e-9), costWidth)} `}</Text>
          <Text>{moneyText(next.warm)}</Text>
        </Text>
        <Text>
          <Text color="red">{`cache expired ${bar(1, costWidth)} `}</Text>
          <Text>{moneyText(next.cold)}</Text>
        </Text>
        <Text dimColor wrap="wrap">{`${price.name}${price.isGuess ? ' (price unknown, Opus 5.5 assumed)' : ''} at API prices, before Claude's reply. Prices: ${pricedAt ? `Anthropic's pricing page, read ${durationText(now - pricedAt)} ago` : `built-in list of ${BUILT_IN_DATE}`}.`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">WHAT TO DO</Text>
        {options.map((o, i) => (
          <Text key={`o-${i}`} wrap="wrap">{`• ${o}`}</Text>
        ))}
      </Box>
      <Text dimColor>{rule}</Text>
      <Box flexDirection="column">
        <Text bold color="magenta">THIS SESSION</Text>
        <Text>
          {clock.history.map((r, i) => (
            <Text key={`h-${i}`} color={r.isMiss ? 'red' : 'green'}>
              {r.isMiss ? '○' : '●'}
            </Text>
          ))}
        </Text>
        <Text wrap="wrap">{`hit ${hit}% · ${t.requests} requests · ${tokensText(t.read)} read from cache · ${tokensText(t.write)} written · ≈ ${moneyText(t.usd)} at API prices`}</Text>
        {clock.misses.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Rebuilt:</Text>
            {clock.misses.map((m, i) => (
              <Text key={`m-${i}`} wrap="wrap">{`${durationText(now - m.at)} ago · ${tokensText(m.write)} tokens · ${m.cause ?? 'unknown'} · ${moneyText(m.usd)}`}</Text>
            ))}
          </Box>
        )}
      </Box>
      <Text dimColor>{rule}</Text>
      <Text wrap="wrap">
        <Text bold>Resets the cache: </Text>
        <Text>/model, fast mode on, adding an MCP server, /compact, a long pause.</Text>
      </Text>
      <Text wrap="wrap">
        <Text bold>Keeps it: </Text>
        <Text>editing files, skills, /rewind, subagents, permission modes.</Text>
      </Text>
      <Text dimColor wrap="wrap">{`Last request on ${shortModel(last.model)} · context ${tokensText(contextOf(last))} tokens.`}</Text>
    </Box>
  )
}

// ---- the mod -----------------------------------------------------------

export const register: Register = (on, options) => {
  showLine = options.showLine !== false
  notices = options.notices !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isActive = e.isInteractive
    if (!isActive) return started
    env = {
      DISABLE_PROMPT_CACHING: await $.env.get('DISABLE_PROMPT_CACHING'),
      FORCE_PROMPT_CACHING_5M: await $.env.get('FORCE_PROMPT_CACHING_5M'),
      CLAUDE_CODE_PROMPT_CACHE_TTL: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      ENABLE_PROMPT_CACHING_1H: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
    }
    setting = ((await $.settings.read().catch(() => undefined)) as Record<string, unknown> | undefined)?.promptCacheTtl
    await $.command.register({ name: 'cache', description: 'Prompt cache: time left, next message size and cost, hits and misses', immediate: true })
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    $.clock.after(2_000, () => void loadPrices($).catch(() => undefined))
    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (!isActive || e.agentId !== undefined) return yield* next(e)
    const at = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (usage) $.clock.after(0, () => void recordStep($, at, usage).catch(() => undefined))
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    $.clock.after(0, () => void startedFrom($, e).catch(() => undefined))
    return done
  })

  on('turn.start', async ($, e, next) => {
    if (isActive) await setWorking($, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (isActive && e.agentId === undefined) $.clock.after(0, () => void setWorking($, false).catch(() => undefined))
    return done
  })

  on('command.run', { command: 'cache' }, async $ => {
    await openPane($)
    return { text: 'Prompt cache opened in the side panel.' }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engine = await next(e)
    if (!isActive || !showLine) return engine
    const clock = await read($, clockAtom)
    const now = (await read($, nowAtom)) || (await $.clock.now())
    if (!clock.last) return engine
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {lineView($, e, clock, now)}
        {engine}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const clock = await read($, clockAtom)
    const now = (await read($, nowAtom)) || (await $.clock.now())
    return paneView($, e, clock, now, Math.max(20, e.props.bodyColumns - 2))
  })
}
