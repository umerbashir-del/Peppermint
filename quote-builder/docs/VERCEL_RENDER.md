# Vercel frontend and Render backend

This deploys the Python quote-builder website and its Node supplier/research agents. The root `Dockerfile` belongs to the separate Node pilot; use **Dockerfile.website** for this website. No cloud resources are created by the files in this repository.

## 1. Create the backend on Render

Create a Blueprint from this repository and the branch containing these changes. Render reads root `render.yaml`. It defines one paid web service, the Python 3.11/Node 24 image, a 1 GB disk at `/var/data`, `/ready` health checks, and one instance. Review the selected `1c-2g` compute plan and disk charges in Render before creation. Automatic deployments wait for CI checks. Keep one instance and one API worker while the website uses SQLite.

Provide these settings when prompted:

| Setting | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | Your private server API key |
| `ANTHROPIC_MODEL` | The exact enabled model ID you use locally |
| `QBC_CORS_ORIGINS` | The exact frontend origin, for example `https://your-project.vercel.app` |

The Blueprint generates `QBC_SECRET_KEY` and `QBC_BOOTSTRAP_SECRET`. Keep them private and stable across deployments. The database is `/var/data/quote_builder.db`. Startup migrations run after the disk is mounted; the API then runs as an unprivileged user. Existing databases must be writable by UID/GID 10001. The image contains neither `.env` nor local databases or generated demo credentials.

You can create the Vercel project first to obtain its stable frontend address, then create Render, then finish the Vercel build after obtaining the backend address. For a custom domain, add that exact origin in Render as well. Multiple explicit origins are comma-separated; do not use `*` or a wildcard for all Vercel previews. Give previews a separate test backend/account configuration.

## 2. Configure supplier access

The hosted production backend deliberately refuses the local sample supplier fallback. Upload a private Render Secret File named `supplier-bindings.json`; it is mounted at `/etc/secrets/supplier-bindings.json`, matching `QBC_SUPPLIER_BINDINGS_FILE` in the Blueprint. Each workspace needs its own authorized binding:

```json
{
  "your-workspace-id": {
    "supplier_id": "your-supplier-id",
    "account_id": "authorized-account-id",
    "branch": "authorized-branch",
    "source_file": "/var/data/supplier-current.json"
  }
}
```

The supplier feed must write that private source file and keep it current using atomic replacement. Follow the existing supplier dataset schema and access checks; a sample fixture is not an authorized commercial feed. Non-sample data is rejected once older than `SUPPLIER_MAX_AGE_SECONDS` (default 300 seconds). Stock, prices, credit, commercial-use permissions and validity are checked again at approval. If supplier access is not configured, the materials workflow refuses to quote; `/ready` confirms database availability, not live supplier or Anthropic connectivity.

For a hosted demonstration using the bundled synthetic catalog, set `QBC_DEMO_SUPPLIER_TENANTS=buildbridge-demo` on the demo Render service, leaving `QBC_SUPPLIER_BINDINGS_FILE` unset. This is an exact workspace allowlist: only named tenants use the bundled `normal` sample account and `sample-main` branch. A configured real binding file takes precedence and never falls back to demo data after an error. The API, form, quote warning, and PDF identify sample data. Keep `NODE_ENV=production`; this setting does not enable sample access for other tenants or the separate Node pilot. Remove the allowlist and configure authorized, current supplier feeds before commercial use. This optional demo variable is managed directly on the demo service; the production Blueprint does not enable it.

## 3. Create the frontend on Vercel

Import the same GitHub repository with these project settings:

| Setting | Value |
| --- | --- |
| Root Directory | `quote-builder/web` |
| Framework | Other |
| Build Command | `node build.mjs` (provided by `vercel.json`) |
| Output Directory | `dist` |
| Install Command | Empty; the build uses Node's built-in modules |
| `QBC_PUBLIC_API_BASE_URL` | Your Render HTTPS origin, e.g. `https://your-api.onrender.com` |

Set Node 24 for the build. The backend URL must be an origin only, without `/api`, credentials, a query, or a fragment. Only this public URL is written into `static/config.js`; the build never reads `.env` or copies arbitrary source files. Never add `ANTHROPIC_API_KEY` or `QBC_SECRET_KEY` to the Vercel project. A changed URL requires rebuilding/redeploying the frontend.

The build publishes `index.html` and `/static/` assets and gives the page a content policy allowing API connections only to itself and the configured backend. Login, normal API requests, CSV upload, logout and PDF download all contact Render directly. The backend already supports exact-origin CORS with authorization and idempotency headers. No Vercel API proxy is used: its 120-second external-origin timeout is shorter than the worker's 200-second limit. Local Python hosting still uses the checked-in same-origin `config.js` unchanged.

## 4. Provision accounts and verify

1. Confirm the Render `/ready` address returns HTTP 200.
2. Create the first owner with the existing `POST /auth/bootstrap` endpoint, using `X-Bootstrap-Secret` and a JSON body containing `tenant_id`, `email`, and a strong `password`. Use a private API client; do not put secrets in a URL or Git. This creates a new cloud workspace; local demo accounts are not uploaded.
3. Remove `QBC_BOOTSTRAP_SECRET` from the Render service after provisioning and remove its generator from your deployed Blueprint when syncing it again. Leave multi-tenant bootstrap disabled. The owner creates the separate reviewer through the existing users API.
4. Sign in through Vercel. Confirm profiles, jobs and quotes load. Upload a labelled test price list for the crew workflow, or configure a real authorized supplier test account for the supplier workflow.
5. Test a normal draft, an ambiguous request, research handoff, blocked creator approval, separate reviewer approval, and approved PDF download. Confirm errors are readable in the browser rather than hidden by CORS.
6. Restart/redeploy Render. Confirm accounts, jobs and quotes remain and `/audit/verify` succeeds. Rotate through a deployment with a real test workspace before any customer launch.

## Backups and operating limits

Use SQLite's online backup API/CLI to create a consistent snapshot; do not copy a live database file directly. Schedule encrypted backups to storage outside this service and complete a restore drill using [RUNBOOK.md](RUNBOOK.md). A persistent disk is not a tested off-service backup. Disk-backed Render services have deployment downtime and cannot scale to multiple instances.

Agents currently run within an HTTP request, with bounded time and concurrency. Direct browser-to-Render traffic avoids Vercel's proxy limit, but interrupted work and server restarts still require recovery/retry. Before a larger production rollout, move jobs into a durable queue, poll for results, and migrate this Python website's SQLite queries to managed PostgreSQL. The separate Node pilot's PostgreSQL support does not automatically migrate the Python website.

## Validation

`npm test` covers public frontend builds and split-host browser request destinations. Python deployment tests cover CORS preflights, authorized/unauthorized responses, and startup configuration. GitHub CI also builds the actual website image and checks the non-root API, Node parser, cross-origin sign-in, database persistence through container restart, and audit verification with isolated dummy credentials. These checks do not replace testing the actual Vercel/Render deployment, real supplier access, or backup restore.

Provider references: [Vercel configuration](https://vercel.com/docs/project-configuration), [Vercel proxy limits](https://vercel.com/docs/limits#proxied-request-timeout), [Render Blueprints](https://render.com/docs/blueprint-spec), [Render Docker](https://render.com/docs/docker), [Render persistent disks](https://render.com/docs/disks).
