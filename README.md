# Qvidian

This repository contains a Qvidian integration proof-of-concept:

- `qvidian-shim/` — a REST shim that manages Qvidian browser-style login/session cookies and proxies JSON WebServices calls.
- `qvidian-mcp/` — a Model Context Protocol bridge that exposes Qvidian session auth and invoke tools.

## Contents

- `qvidian-shim/src/index.js` — REST API for session login, credential-based SSO login, session invocation, and session validation.
- `qvidian-mcp/src/server.js` — MCP server registering Qvidian tools and proxying requests to the shim.
- `docker-compose.yml` — optional orchestration for both services.

## Setup

1. Install dependencies in each service folder:

```bash
cd qvidian-shim && npm install
cd ../qvidian-mcp && npm install
```

2. Configure environment variables.

For `qvidian-shim`:

```env
QVIDIAN_BASE_URL=https://<tenant>.qvidian.com
QVIDIAN_API_KEY=<your_api_key>
PORT=3010
```

3. Start the services:

```bash
cd qvidian-shim && npm start
cd ../qvidian-mcp && npm start
```

## Usage

- `qvidian-shim` exposes REST endpoints such as `/session/login`, `/session/credentials`, and `/session/call`.
- `qvidian-mcp` exposes MCP tools like `qvidian.session.login`, `qvidian.session.login.credentials`, and `qvidian.session.invoke`.

## SSO login helper (Puppeteer)

For SSO-only Qvidian tenants where the API key path is unavailable, `qvidian-shim/scripts/sso-login.js` drives a real browser locally to capture the `QvidianAuthenticationToken` and posts it to the shim's `/session/login` endpoint. The shim itself stays Chromium-free (Puppeteer is a `devDependency`).

Setup on your laptop (one-time):

```bash
cd qvidian-shim
npm install   # pulls puppeteer + Chromium (~300MB, dev-only)
```

Run (with the SSH tunnel to the remote shim already open on `localhost:3010`):

```bash
npm run sso:login
```

On first run a visible Chromium window opens — sign in via Microsoft / MFA. Auth cookies are saved under `qvidian-shim/.auth/puppeteer-profile/` (gitignored). Subsequent runs reuse the saved profile and complete silently.

The script waits for the SSO flow to land you on your tenant host, then captures the `qvidian.com` cookies from Puppeteer's browser context and POSTs them to the shim's `/session/import` endpoint. (The shim then uses those cookies for `/session/call`, etc.)

Flags / env overrides:

- `--shim http://localhost:3010` (or `SHIM_URL`) — where to post the captured token
- `--url https://qpalogin.qvidian.com/` (or `QVIDIAN_ENTRY_URL`) — SSO entry point
- `--baseUrl https://qpa-p1.qvidian.com/qpa_20_1_0000_0039` (or `QVIDIAN_BASE_URL`) — tenant URL the shim should bind the session to
- `--headless true` — force headless (only works once cookies are warm)
- `--profile /path/to/profile` (or `SSO_PROFILE_DIR`) — override profile location

The script prints the `sessionId`; use it against `/session/call`, etc.

## Notes

- `.env` files are ignored by Git.
- The project is designed to support Qvidian SSO / browser auth flows by capturing session cookies and forwarding JSON WebServices requests.
- Remove or replace any sensitive credentials from your local environment before sharing.
