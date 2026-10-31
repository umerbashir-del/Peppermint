# BuildBridge

Shared foundation for the October 31, 2026 quoting prototype. Requires Node.js 22 or later; no dependency installation is needed.

Copy `.env.example` to `.env` and add your OpenAI key locally. `.env` is ignored by Git.

Feature branches based on main:

- `codex/research-agent`: public specification research with citations.
- `codex/supplier-quote-desk-agent`: supplier tools, sample quoting, and credit checks.
- `codex/buildbridge-integration`: both agents, command-line demo, documentation, and complete tests.

The supplier data is sample data. Quotes remain drafts and require human approval.

## Research feature

Run `npm test` for offline tests. Import `research` from `src/research-agent.js` and call it with one material specification question after loading your key into the process environment. The live agent uses paid OpenAI web search and returns citations for human review. It cannot authorize a substitution. API details: https://developers.openai.com/api/docs/guides/tools-web-search
