# Qvidian

A Qvidian integration that lets an LLM (or any HTTP client) search the Qvidian content library, read documents, and synthesize answers — built around a REST shim and an MCP bridge, with Puppeteer-driven SSO login.

- `qvidian-shim/` — REST API in front of Qvidian. Holds the authenticated session and turns Qvidian's stateful, browser-coupled endpoints into clean JSON.
- `qvidian-mcp/` — Model Context Protocol bridge that exposes the shim's capabilities as MCP tools.

## How auth works

This Qvidian tenant is SSO-only (Azure AD) and the legacy SOAP API-key path is locked down. So the project authenticates by **driving a real headless browser**:

1. `qvidian-shim/scripts/sso-login.js` launches Puppeteer with a persistent profile and navigates to `qpalogin.qvidian.com`.
2. First run: visible browser, you complete Microsoft sign-in + MFA. Cookies are saved to `qvidian-shim/.auth/puppeteer-profile/` (gitignored).
3. Subsequent runs: silent. Puppeteer reuses the saved cookies; the SSO redirects fire automatically.
4. The script captures the tenant `*.qvidian.com` cookies plus three required custom headers (`QvidianAuthenticationShadow`, `x-request-verification-token`, `qpaPageInstanceID`) and POSTs them to the shim's `/session/import`.
5. The shim stores them and attaches them to every outgoing API call — Qvidian's API can't tell the difference between the shim and a real browser.
6. The script then writes the `sessionId` to `qvidian-shim/.auth/session-id` and recreates the `qvidian-mcp` container with `QVIDIAN_SESSION_ID` set, so MCP tools work without per-call session arguments.

The Docker image itself stays slim — `puppeteer` is a `devDependency`, never installed inside the container.

## Quick start

Prereqs: Docker Desktop, Node 20+.

```bash
# 1. Configure the tenant URL and ports
cp .env.example .env
# Edit .env — set QVIDIAN_BASE_URL=https://<tenant>.qvidian.com/<version_path>

# Same for the shim's own env (used by the container)
cp qvidian-shim/.env.example qvidian-shim/.env
# Edit qvidian-shim/.env to match

# 2. Bring up shim + MCP
docker compose up -d --build

# 3. Install the SSO helper deps on the host (pulls Chromium ~300MB, dev-only)
cd qvidian-shim && npm install

# 4. Log in once. This opens a browser for first-time SSO/MFA, then auto-refreshes
#    the MCP container with your new sessionId.
npm run sso:login
```

After step 4 you have:
- Shim REST API on `http://localhost:3010`
- MCP bridge on `http://localhost:3020/mcp`

To refresh an expired session, just run `npm run sso:login` again — cookies are warm, so it usually completes silently in a few seconds.

## Library API (the main use case)

The end-to-end "search topic → read doc → synthesize" workflow uses three shim endpoints. They're also surfaced as MCP tools (see below).

```bash
# Search
curl -X POST http://localhost:3010/library/search \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<id>","query":"data quality","pageSize":5}'
# → { totalCount, pageIndex, pageSize, results: [{contentID, revision, title,
#     folderPath, snippet, ext, rank}, ...] }

# Read a document as clean plain text (default) or raw HTML
curl -X POST http://localhost:3010/library/content/2341 \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<id>","revision":1,"format":"text"}'
# → { contentID, revision, fileName, fileExt, format, body }

# Download the underlying .docx/.pdf binary (response is the raw bytes)
curl -X POST http://localhost:3010/library/download/2341 \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<id>","revision":-1}' \
  -o doc.docx
```

If you need to call something the shim doesn't wrap, use the generic escape hatch:

```bash
curl -X POST http://localhost:3010/session/raw \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<id>","path":"/MyWork/GetDocumentsProjectsSearch","body":{...}}'
```

## MCP tools

The MCP bridge speaks Streamable HTTP at `http://localhost:3020/mcp`. The library-oriented tools:

- `qvidian_library_search` — `{query, pageSize?, pageIndex?, sessionId?}`
- `qvidian_library_read` — `{contentID, revision?, format?, sessionId?}` (text by default — ready for an LLM to ingest)
- `qvidian_library_download` — `{contentID, revision?, sessionId?}` → metadata only (binaries can't be returned over MCP; the response includes the shim URL to fetch directly)

`sessionId` is optional on all of them — when `QVIDIAN_SESSION_ID` is in the MCP container's env (set automatically by `sso-login`), the tools use that as the default.

There are also legacy tools (`qvidian_authenticate`, `qvidian_search`, `qvidian_getContent`, etc.) that go through the SOAP path. They don't work on this tenant — keep using the `library_*` tools. Tool names use underscores (not periods) because Claude Desktop's frontend validator rejects dots.

To connect Claude Desktop (or any MCP client), point it at `http://localhost:3020/mcp` as a remote MCP server.

## Configuration reference

Root `.env` (used by `docker-compose.yml`):

```
QVIDIAN_BASE_URL=https://<tenant>.qvidian.com/<version_path>
QVIDIAN_API_KEY=<unused on SSO tenants — leave any placeholder>
SHIM_PORT=3010
MCP_PORT=3020
# QVIDIAN_SESSION_ID is injected by sso-login; you don't set this by hand
```

`qvidian-shim/.env` (loaded inside the shim container):

```
QVIDIAN_BASE_URL=https://<tenant>.qvidian.com/<version_path>
QVIDIAN_API_KEY=<placeholder>
QVIDIAN_LOGIN_URL=https://qpalogin.qvidian.com
QVIDIAN_SSO_EMAIL=<your.email@company.com>
PORT=3010
```

The tenant path segment (e.g. `qpa_20_1_0000_0039`) is the deployment version. If Qvidian upgrades and you start seeing redirects to `/qpa_XX_X_X_X/Error`, update `QVIDIAN_BASE_URL` to the new version path.

## `sso-login` flags

| Flag | Env | Default | Notes |
|------|-----|---------|-------|
| `--shim <url>` | `SHIM_URL` | `http://localhost:3010` | Where to POST the captured cookies/headers |
| `--url <url>` | `QVIDIAN_ENTRY_URL` | `https://qpalogin.qvidian.com/` | SSO entry point |
| `--baseUrl <url>` | `QVIDIAN_BASE_URL` | (derived from landing page) | Tenant URL the shim binds the session to |
| `--profile <dir>` | `SSO_PROFILE_DIR` | `qvidian-shim/.auth/puppeteer-profile` | Persistent browser profile |
| `--headless` | — | `false` | Force headless (only works after first-run cookies are warm) |
| `--no-restart` | `SSO_SKIP_MCP_RESTART` | (run by default) | Skip auto-restart of the MCP container |
| `--timeout <ms>` | — | `180000` | Per-step timeout |

## Troubleshooting

- **`docker-compose` complains about `${SHIM_PORT:-3010}` interpolation:** you have an old Compose v1 binary in your PATH. Use `docker compose` (space, not hyphen), or `brew uninstall docker-compose` to drop the v1 shim.
- **All API calls return 401 "Authentication failed":** the session has expired or never authenticated correctly. Run `npm run sso:login` to refresh.
- **`/library/content` returns escaped HTML (`<...`) instead of clean text:** out-of-date shim image. Rebuild: `docker compose up -d --build qvidian-shim`. The fix is to JSON-parse Qvidian's double-encoded `FileString`.
- **MCP tools return "Session not found":** the shim's in-memory session store was wiped (typically by `docker compose up --build qvidian-shim` or `--force-recreate qvidian-shim`). Run `npm run sso:login` again. The `--no-deps` flag in the script's auto-restart command prevents this on MCP-only rebuilds.
- **The auto-restart of MCP after `sso-login` fails because Docker isn't available:** use `--no-restart` and run the shim/MCP however you want (`npm start` in each), then `export QVIDIAN_SESSION_ID=...` in the MCP's environment.

## Layout

```
qvidian/
├── docker-compose.yml          # shim + mcp, local-only deployment
├── .env                        # tenant URL, ports (gitignored)
├── qvidian-shim/
│   ├── src/index.js            # REST API: /session/import, /library/*, /session/raw, ...
│   ├── scripts/sso-login.js    # Puppeteer driver, runs on host
│   ├── scripts/test-direct.js  # Debug helper: compare in-page vs Node fetch
│   ├── .env                    # tenant URL, SSO email (gitignored)
│   ├── .auth/                  # Puppeteer profile + cached session id (gitignored)
│   └── Dockerfile              # node:20-alpine, --omit=dev (no Puppeteer inside)
└── qvidian-mcp/
    ├── src/server.js           # MCP tools, including qvidian.library.*
    └── Dockerfile
```

## Notes

- All `.env` files and `.auth/` are gitignored. Don't commit cookies, API keys, or session tokens.
- Sessions are held in-memory in the shim. Any restart of the shim container invalidates them; re-run `npm run sso:login`.
- For a deeper trace of the SSO flow / auth-header capture, see commit `a52e703`.
