# BuildBridge

Shared foundation for the October 31, 2026 quoting prototype. Requires Node.js 22 or later; no dependency installation is needed.

Copy `.env.example` to `.env` and add your OpenAI key locally. `.env` is ignored by Git.

Feature branches based on main:

- `codex/research-agent`: public specification research with citations.
- `codex/supplier-quote-desk-agent`: supplier tools, sample quoting, and credit checks.
- `codex/buildbridge-integration`: both agents, command-line demo, documentation, and complete tests.

The supplier data is sample data. Quotes remain drafts and require human approval.

## Supplier feature

Run `npm test` to validate the supplier workflow. Import `quote` from `src/supplier-agent.js` and `loadSupplier` from `src/supplier-tools.js`; pass one of the example JSON requests to `quote(request, await loadSupplier())`. Pass `{ live: true }` as the third argument to enable AI tool calls after loading your key into the process environment. Quotes use sample data; calculations are independently validated and results remain drafts.
