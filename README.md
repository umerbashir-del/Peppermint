# BuildBridge

Orchestrator connection: use `runResearchTask` in `src/research-interface.js`. Read [the shared contract guide](docs/orchestrator-integration.md), inspect `examples/research-task.json` and `examples/research-response.json`, and run `npm run example:research`. This example uses explicitly mocked evidence; add `-- --live` to use paid live research. Existing direct-call functions remain supported.

Shared foundation for the October 31, 2026 quoting prototype. Requires Node.js 22 or later; no dependency installation is needed.

Copy `.env.example` to `.env` and add your OpenAI key locally. `.env` is ignored by Git.

Feature branches based on main:

- `codex/research-agent`: public specification research with citations.
- `codex/supplier-quote-desk-agent`: supplier tools, sample quoting, and credit checks.
- `codex/buildbridge-integration`: both agents, command-line demo, documentation, and complete tests.

The supplier data is sample data. Quotes remain drafts and require human approval.

## Research feature

Run `npm test` for offline tests. Copy `.env.example` to `.env` only if `.env` does not already exist, then add your OpenAI API key locally. No packages need installing.

```powershell
node --env-file=.env --input-type=module -e "import { research } from './src/research-agent.js'; console.log(JSON.stringify(await research('Which specifications should be checked before substituting joist lumber?'), null, 2));"
```

The Research Agent now has the two separate tools specified in the PRD:

| Tool | Behavior |
| --- | --- |
| `web_search(query)` | Uses OpenAI hosted search to find public specification sources. Returns source titles and URLs plus a search summary. Unknown publication dates remain null. |
| `read_source(url)` | Opens a URL returned by search in the current run, extracts a sentence or short excerpt answering the original question, and returns `quoted_text`, `url`, `page_date`, and `date_fetched`. |

The agent chooses tools in a bounded loop. At most four searches or two source-read attempts are allowed, whichever limit is reached first. Failed attempts count toward the limits. A final answer-only step is allowed after the limit; no additional searches or pages are opened. Search and extraction use paid OpenAI API calls, and there is also a twelve-round cap.

`read_source` fetches the page directly, then uses a tool-free extraction request to choose an excerpt of at most 25 words. The application checks that the quote occurs in the fetched, normalized text; fabricated quotes are rejected. A search citation alone is not accepted as verified evidence. Results include verified source metadata, a conservative confidence level, usage counts, and human-review status. Missing publication dates remain null rather than being inferred from the fetch date. Research cannot authorize a substitution.

The reader accepts public HTTPS HTML and plain-text pages only. It rejects non-public network addresses, pins DNS for the connection, does not follow redirects, limits downloads to 1 MB, and examines at most 40,000 normalized text characters. It does not execute JavaScript or parse PDF data sheets. Unsupported, blocked, unreadable, or failed sources result in review flags; a PDF-only source needs a human or a future PDF reader. HTML extraction is intentionally basic and publication-date extraction recognizes explicit `article:published_time`, `datePublished`, or `dc.date` metadata.

The 16 offline tests cover the two-tool workflow, limits, evidence validation, source allowlisting, unavailable sources, and HTTP/network restrictions. Provider and HTTP responses are mocked; these tests do not establish live API access or search quality. Your `.env` remains ignored by Git.

Official API references: [function calling](https://developers.openai.com/api/docs/guides/function-calling) and [web search](https://developers.openai.com/api/docs/guides/tools-web-search).
