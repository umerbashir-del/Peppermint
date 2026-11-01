# Anthropic setup

Live supplier matching, research planning, hosted search, and source extraction use Anthropic's Messages API at `https://api.anthropic.com/v1/messages`. The parser, deterministic supplier quoting, offline examples, and draft storage still work without API calls.

Create a local `.env` using `.env.example` only if it does not already exist:

```dotenv
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-5-5
ANTHROPIC_EFFORT=low
```

Add the credential only in `.env`, never in `.env.example`, source files, task payloads, or saved quotes. Git ignores `.env`. Model and effort can be changed locally; the selected model must support tools, structured JSON output, and hosted web search. The client uses the `x-api-key` header and API version `2026-10-21`. No OpenAI API key or additional web-search key is used.

```powershell
npm test
npm run demo
npm run quote -- examples/normal.json --live
npm run example:research -- --live
```

The `quote`, `research`, and live example scripts load `.env` automatically. A partner embedding the workers directly should load environment variables server-side, such as with `node --env-file=.env your-orchestrator.js`. All public worker task/result envelopes remain v1.0 and unchanged.

## Transport and tools

`src/model-client.js` selects `src/anthropic.js`. The transport translates the workers' existing internal response records into native Anthropic `messages`, `tool_use`, `tool_result`, tool `input_schema`, and structured `output_config.format`. It preserves entire native assistant content blocks, including opaque signatures, when continuing a tool conversation; it exposes only text/tool outputs to worker logic. It groups multiple tool results into the immediately following user message. Reasoning content is not included in worker results, logs, or saved drafts.

Claude's `web_search_20250305` server tool runs the search with `max_uses: 1`. The worker's separate `read_source` function opens approved results and validates a short quoted excerpt. Search-result URLs and citations come from the provider's source blocks, not URLs invented in response prose. Provider search errors, paused/incomplete turns, and refusals cannot be treated as successful evidence. An answer without actual sources remains unverified. Adaptive-thinking compatibility uses automatic tool selection, with source/quote checks enforcing the outcome in code.

The default effort is low to keep the demo small. Requests allow at least 2,048 output tokens so adaptive thinking has room; this is a cap, not an amount automatically consumed. Existing iteration/search/read limits and 90-second HTTP request timeouts still apply. Live tokens and hosted searches are paid usage. Unsupported numeric/length constraints are described in native strict schemas while authoritative quantity, specification, and quote checks remain enforced locally.

Provider error bodies are not printed. Authentication failures are reported using the HTTP status and a safe explanation; no credentials are echoed. Only transient transport errors already recognized by the worker contract receive its retryable flag. Do not automatically repeat whole quote workflows without your orchestrator's retry limits and draft save IDs.

Official references: [Messages API](https://platform.claude.com/docs/en/api/messages), [tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), [hosted web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), and [model IDs](https://platform.claude.com/docs/en/models/overview).
