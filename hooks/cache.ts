import type { Req, Ttl } from '../types'
import { type Price, writePrice } from './prices'

export const HOUR = 3_600_000
export const FIVE_MIN = 300_000
export const SHORT_PROMPT = 200
export const BIG_REBUILD = 20_000
export const BIG_CONTEXT = 50_000
export const SUMMARY_TOKENS = 6_000

const on = (value: string | undefined) => value === '1' || value?.toLowerCase() === 'true'
const ttl = (ms: number, why: string): Ttl => ({ ms, label: ms === HOUR ? '1-hour cache' : '5-minute cache', why })

// Claude Code's own order: FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, the
// promptCacheTtl setting, ENABLE_PROMPT_CACHING_1H, then the default for the account.
export function ttlOf(o: { env: Record<string, string | undefined>; setting?: unknown; isSubscription: boolean; isOverLimit: boolean }): Ttl {
  if (on(o.env.DISABLE_PROMPT_CACHING)) return { ms: 0, label: 'caching off', why: 'DISABLE_PROMPT_CACHING', isOff: true }
  if (on(o.env.FORCE_PROMPT_CACHING_5M)) return ttl(FIVE_MIN, 'FORCE_PROMPT_CACHING_5M')
  const chosen = o.env.CLAUDE_CODE_PROMPT_CACHE_TTL
  if (chosen === '5m' || chosen === '1h') return ttl(chosen === '1h' ? HOUR : FIVE_MIN, 'CLAUDE_CODE_PROMPT_CACHE_TTL')
  if (o.setting === '5m' || o.setting === '1h') return ttl(o.setting === '1h' ? HOUR : FIVE_MIN, 'promptCacheTtl setting')
  if (on(o.env.ENABLE_PROMPT_CACHING_1H)) return ttl(HOUR, 'ENABLE_PROMPT_CACHING_1H')
  if (o.isSubscription && !o.isOverLimit) return ttl(HOUR, 'Claude subscription')
  return ttl(FIVE_MIN, o.isSubscription ? 'subscription on usage credits' : 'API key or cloud provider')
}

type Usage = { input: number; output: number; read: number; write: number }

export const contextOf = (r: Usage) => r.input + r.read + r.write + r.output
const prefixOf = (r: Usage) => r.input + r.read + r.write

export function costOf(u: Usage, price: Price, ttlMs: number): number {
  return (u.input * price.input + u.read * price.read + u.write * writePrice(price, ttlMs) + u.output * price.output) / 1e6
}

// A request that had to write most of what the one before it had cached rebuilt the cache.
export function classify(prev: Req | null, cur: Usage & { at: number; model: string }, ttlMs: number): { isMiss: boolean; cause?: string } {
  const prefix = prefixOf(cur)
  if (cur.write < 2000) return { isMiss: false }
  if (!prev) return cur.read >= prefix / 2 ? { isMiss: false } : { isMiss: true, cause: 'first message of the session' }
  if (cur.read >= 0.8 * prefixOf(prev)) return { isMiss: false }
  if (!prev.isSeed && prev.model && cur.model && prev.model !== cur.model) return { isMiss: true, cause: `switched model (${shortModel(prev.model)} → ${shortModel(cur.model)})` }
  if (ttlMs > 0 && cur.at - prev.at > ttlMs) return { isMiss: true, cause: `expired after ${durationText(cur.at - prev.at)} idle` }
  if (prefix < 0.6 * prefixOf(prev)) return { isMiss: true, cause: 'conversation compacted or cleared' }
  return { isMiss: true, cause: 'the start of the request changed (tools, MCP servers, effort or a plugin)' }
}

export function nextCost(last: Req, price: Price, ttlMs: number): { tokens: number; warm: number; cold: number } {
  const cached = prefixOf(last)
  const fresh = last.output + SHORT_PROMPT
  const write = writePrice(price, ttlMs)
  return { tokens: cached + fresh, warm: (cached * price.read + fresh * write) / 1e6, cold: ((cached + fresh) * write) / 1e6 }
}

export function shortModel(model: string): string {
  const name = model.replace(/^.*claude-/, '').replace(/-\d{8}$/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function tokensText(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function moneyText(usd: number): string {
  if (usd < 0.01) return '<$0.01'
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}

export function durationText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

export const bar = (fraction: number, width: number) => {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export type Phase = 'none' | 'working' | 'warm' | 'low' | 'expired' | 'off'

export function phaseOf(last: Req | null, ttl: Ttl, isWorking: boolean, now: number): Phase {
  if (ttl.isOff) return 'off'
  if (!last) return 'none'
  if (isWorking) return 'working'
  const left = last.at + ttl.ms - now
  if (left <= 0) return 'expired'
  return left < ttl.ms / 4 ? 'low' : 'warm'
}

// A new conversation (/clear) writes only what every conversation starts with: system
// prompt, tools, CLAUDE.md and memory.
export function freshCost(base: number, price: Price, ttlMs: number): number {
  return ((base + SHORT_PROMPT) * writePrice(price, ttlMs)) / 1e6
}

// /compact while the cache is warm reads the conversation from the cache and writes a summary.
export function compactCost(last: Req, price: Price): number {
  return (prefixOf(last) * price.read + SUMMARY_TOKENS * price.output) / 1e6
}

export type Advice = { kind: 'fresh' | 'compact'; usd: number; text: string }

// Starting fresh is suggested once the cache is cold and continuing costs at least three
// times as much; compacting, in the cache's last quarter with a big conversation.
export function adviceOf(last: Req, phase: Phase, price: Price, ttlMs: number, base: number): Advice | undefined {
  const next = nextCost(last, price, ttlMs)
  if (next.tokens < BIG_CONTEXT || base <= 0) return undefined
  if (phase === 'expired') {
    const usd = freshCost(base, price, ttlMs)
    return next.cold >= 3 * usd ? { kind: 'fresh', usd, text: `start fresh ≈ ${moneyText(usd)} (/clear)` } : undefined
  }
  if (phase === 'low') {
    const usd = compactCost(last, price)
    return next.cold >= 3 * usd ? { kind: 'compact', usd, text: `stepping away? /compact ≈ ${moneyText(usd)}` } : undefined
  }
  return undefined
}

const BASE_SKIP = new Set(['Messages', 'Free space', 'Autocompact buffer', 'Compact buffer'])

export function baseOf(categories: readonly { name: string; tokens: number; isDeferred?: boolean }[]): number {
  return categories.filter(c => !BASE_SKIP.has(c.name) && !c.isDeferred).reduce((n, c) => n + c.tokens, 0)
}

