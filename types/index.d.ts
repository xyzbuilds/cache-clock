export type Ttl = { ms: number; label: string; why: string; isOff?: boolean }
export type Req = { at: number; model: string; input: number; output: number; read: number; write: number; isMiss: boolean; cause?: string; usd: number; isSeed?: boolean }
export type Totals = { requests: number; input: number; output: number; read: number; write: number; usd: number }
export type Clock = { last: Req | null; history: Req[]; misses: Req[]; totals: Totals; ttl: Ttl; window: number; base: number; isWorking: boolean }

declare module 'claude-code' {
  interface PluginState {
    'cache-clock': { clock: Clock; now: number }
  }
}
