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

## Notes

- `.env` files are ignored by Git.
- The project is designed to support Qvidian SSO / browser auth flows by capturing session cookies and forwarding JSON WebServices requests.
- Remove or replace any sensitive credentials from your local environment before sharing.
