// The model table as Anthropic's pricing page printed it on 2026-10-06, trimmed.
export const PRICING_PAGE = `# Pricing

## Model pricing

| Model                                                                                  | Base input tokens     | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens          |
| -------------------------------------------------------------------------------------- | --------------------- | --------------- | --------------- | ------------------------ | ---------------------- |
| Claude Fable 5.1                                                                       | $10 / MTok            | $12.50 / MTok   | $20 / MTok      | $0.25 / MTok<sup>1</sup> | $50 / MTok             |
| Claude Mythos 5.1 ([limited availability](https://anthropic.com/glasswing))            | $10 / MTok            | $12.50 / MTok   | $20 / MTok      | $0.25 / MTok<sup>1</sup> | $50 / MTok             |
| Claude Opus 5.5                                                                        | $4 / MTok             | $5 / MTok       | $8 / MTok       | $0.20 / MTok<sup>2</sup> | $20 / MTok             |
| Claude Opus 5                                                                          | $5 / MTok             | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok             | $25 / MTok             |
| Claude Sonnet 5.5                                                                      | $2 / MTok             | $2.50 / MTok    | $4 / MTok       | $0.20 / MTok             | $10 / MTok             |
| Claude Sonnet 5                                                                        | $2 / MTok<sup>3</sup> | $2.50 / MTok    | $4 / MTok       | $0.20 / MTok             | $10 / MTok<sup>3</sup> |
| Claude Haiku 4.5                                                                       | $1 / MTok             | $1.25 / MTok    | $2 / MTok       | $0.10 / MTok             | $5 / MTok              |

*<sup>1 Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced at 0.025x the base input price.</sup>*
`
