# Cache clock

A Claude Code mod that makes the prompt cache visible. One line under the prompt:

```
cache ● 1h ████████████ 59m left · hit 96% · misses 0 · next ≈ $0.05
cache ● 5m ██░░░░░░░░░░ 53s left · hit 36% · misses 1 · next ≈ $0.02
cache ○ cold · next message re-caches 182k tokens ≈ $1.46 · start fresh ≈ $0.18 (/clear)
```

- **Time left** before the cache expires: one hour on a Claude subscription, five minutes on an API key, a cloud provider or usage credits, or what `promptCacheTtl`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H` or `FORCE_PROMPT_CACHING_5M` set. Green, amber in the last quarter, red once expired.
- **Hit rate:** the share of input tokens this session read from the cache.
- **Misses:** requests that had to rebuild the cache, each with its likely cause: expired after a pause, a model switch, a compaction, or a change at the start of the request (tools, MCP servers, effort, a plugin).
- **Next:** what a short next message costs, at API list prices and before Claude's reply. Once the cache is cold, every token of the conversation is written to the cache again.
- **What to do:** once the cache is cold and continuing costs at least three times a fresh start, the line suggests `/clear` with its cost (system prompt, tools and memory only). In the cache's last quarter, with a big conversation, it suggests `/compact` before stepping away.
- **Resumed conversations** open on the cold line when their cache has expired, before the first message is sent.

`/cache` opens the details in the side panel: the countdown, warm and cold cost side by side, what each option costs (keep going, start fresh, compact), every request as ● (read from cache) or ○ (rebuilt), and each miss with its cost. A dim line in the conversation marks the moment the cache expires and each rebuild over 20k tokens.

Prices are Claude API list prices per model, read from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) at most once a day and kept across sessions. When the page can't be read or its table changes shape, the last good copy is used, else the built-in list (2026-10-06); `/cache` shows which. On a subscription the prices show what the same tokens would cost on the API, not a charge.

## Install

Needs a Claude Code build with mods. Any terminal.

```bash
git clone https://github.com/xyzbuilds/cache-clock.git
claude --plugin-dir ./cache-clock
```

To load it in every session, add the folder's full path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (folders separated by `:`).

## Settings

In `/config`: the line under the prompt (on), notices in the conversation (on).

## Tests

```bash
claude plugin validate .
claude plugin test .
```

MIT License · © 2026 XYZ Makes LLC
