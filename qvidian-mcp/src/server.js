import express from "express";
import fetch from "node-fetch";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SHIM_BASE = process.env.QVIDIAN_SHIM_BASE || "http://qvidian-shim:3010";
const DEFAULT_BASE_URL = process.env.QVIDIAN_BASE_URL;
const DEFAULT_API_KEY  = process.env.QVIDIAN_API_KEY;
const DEFAULT_SESSION_ID = process.env.QVIDIAN_SESSION_ID;
const PORT = Number(process.env.PORT || 3020);

function resolveSessionId(passed) {
  const sid = passed || DEFAULT_SESSION_ID;
  if (!sid) throw new Error("No sessionId provided and QVIDIAN_SESSION_ID env var not set. Run `npm run sso:login` from qvidian-shim/ to get one.");
  return sid;
}

const server = new McpServer({
  name: "qvidian-bridge",
  version: "0.2.1",
  description: "MCP Streamable HTTP bridge that proxies to the Qvidian REST shim"
});

// qvidian.authenticate — inputs OPTIONAL now
server.registerTool(
  "qvidian.authenticate",
  {
    title: "Qvidian Authenticate",
    description: "Authenticate and discover service URLs",
    inputSchema: {
      baseUrl: z.string().url().optional(),
      apiKey: z.string().min(1).optional()
    }
  },
  async ({ baseUrl, apiKey }) => {
    const finalBaseUrl = baseUrl ?? DEFAULT_BASE_URL;
    const finalApiKey  = apiKey  ?? DEFAULT_API_KEY;
    if (!finalBaseUrl || !finalApiKey) {
      throw new Error(
        "Missing credentials. Provide { baseUrl, apiKey } or set QVIDIAN_BASE_URL and QVIDIAN_API_KEY in the environment."
      );
    }
    const r = await fetch(`${SHIM_BASE}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: finalBaseUrl, apiKey: finalApiKey })
    });
    if (!r.ok) throw new Error(`auth failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return { content: [{ type: "json", data }], structuredContent: data };
  }
);

// (optional) a zero-input variant that ALWAYS uses env
server.registerTool(
  "qvidian.authenticate.env",
  {
    title: "Qvidian Authenticate (env)",
    description: "Authenticate using QVIDIAN_BASE_URL and QVIDIAN_API_KEY from environment",
    inputSchema: {}
  },
  async () => {
    if (!DEFAULT_BASE_URL || !DEFAULT_API_KEY) {
      throw new Error("Set QVIDIAN_BASE_URL and QVIDIAN_API_KEY in the environment.");
    }
    const r = await fetch(`${SHIM_BASE}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: DEFAULT_BASE_URL, apiKey: DEFAULT_API_KEY })
    });
    if (!r.ok) throw new Error(`auth failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return { content: [{ type: "json", data }], structuredContent: data };
  }
);

server.registerTool(
  "qvidian.session.login",
  {
    title: "Qvidian Session Login",
    description: "Create a Qvidian session by exchanging a browser login token for a session cookie",
    inputSchema: {
      baseUrl: z.string().url(),
      authToken: z.string().min(1)
    }
  },
  async ({ baseUrl, authToken }) => {
    const r = await fetch(`${SHIM_BASE}/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, authToken })
    });
    if (!r.ok) throw new Error(`session login failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return { content: [{ type: "json", data }], structuredContent: data };
  }
);

server.registerTool(
  "qvidian.session.login.credentials",
  {
    title: "Qvidian Credentials Session Login",
    description: "Log in with Qvidian credentials and automatically capture the browser auth token",
    inputSchema: {
      baseUrl: z.string().url(),
      username: z.string().min(1),
      password: z.string().optional(),
      loginUrl: z.string().url().optional()
    }
  },
  async ({ baseUrl, username, password, loginUrl }) => {
    const r = await fetch(`${SHIM_BASE}/session/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, username, password, loginUrl })
    });
    if (!r.ok) throw new Error(`credentials session login failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return { content: [{ type: "json", data }], structuredContent: data };
  }
);

server.registerTool(
  "qvidian.session.invoke",
  {
    title: "Qvidian Session Invoke",
    description: "Invoke a Qvidian WebServices JSON method using an authenticated session",
    inputSchema: {
      sessionId: z.string().min(1),
      service: z.string().min(1),
      method: z.string().min(1),
      payload: z.record(z.any()).optional()
    }
  },
  async ({ sessionId, service, method, payload }) => {
    const r = await fetch(`${SHIM_BASE}/session/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, service, method, payload })
    });
    if (!r.ok) throw new Error(`session invoke failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return { content: [{ type: "json", data }], structuredContent: data };
  }
);

// qvidian.search
server.registerTool(
  "qvidian.search",
  {
    title: "Qvidian Search",
    description: "Search the Qvidian Library by keyword and optional filters",
    inputSchema: {
      query: z.string().min(1),
      docType: z.union([z.string(), z.number()]).optional(),
      savedSearchId: z.number().optional(),
      extra: z.record(z.any()).optional()
    }
  },
  async ({ query, docType, savedSearchId, extra }) => {
    const payload = { query, extra };
    if (docType !== undefined) payload.docType = docType;
    if (savedSearchId !== undefined) payload.savedSearchId = savedSearchId;

    const r = await fetch(`${SHIM_BASE}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`search failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return {
      content: [{ type: "json", data }],
      structuredContent: data
    };
  }
);

// qvidian.getContent
server.registerTool(
  "qvidian.getContent",
  {
    title: "Qvidian Get Content",
    description: "Get details for a content item by ID",
    inputSchema: { contentId: z.union([z.string(), z.number()]) }
  },
  async ({ contentId }) => {
    const id = typeof contentId === "string" ? contentId : String(contentId);
    const r = await fetch(`${SHIM_BASE}/content/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`getContent failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return {
      content: [{ type: "json", data }],
      structuredContent: data
    };
  }
);

// qvidian.savedSearch.list
server.registerTool(
  "qvidian.savedSearch.list",
  {
    title: "Qvidian Saved Searches",
    description: "List saved searches",
    inputSchema: {}
  },
  async () => {
    const r = await fetch(`${SHIM_BASE}/saved-searches`);
    if (!r.ok) throw new Error(`savedSearch.list failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return {
      content: [{ type: "json", data }],
      structuredContent: data
    };
  }
);

server.registerTool(
  "qvidian.hasPermissions",
  {
    title: "Qvidian Has Permissions",
    description: "Check whether the current authenticated token has a permission or user-level access",
    inputSchema: {
      userId: z.number().optional(),
      permissionName: z.string().optional()
    }
  },
  async ({ userId, permissionName }) => {
    const url = new URL(`${SHIM_BASE}/common/has-permissions`);
    if (userId !== undefined) url.searchParams.append("userId", String(userId));
    if (permissionName !== undefined) url.searchParams.append("permissionName", permissionName);
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`hasPermissions failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return { content: [{ type: "json", data }], structuredContent: data };
  }
);

server.registerTool(
  "qvidian.docTypeList",
  {
    title: "Qvidian Document Type List",
    description: "List available Qvidian document types",
    inputSchema: {}
  },
  async () => {
    const r = await fetch(`${SHIM_BASE}/common/doctype-list`);
    if (!r.ok) throw new Error(`docTypeList failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return { content: [{ type: "json", data }], structuredContent: data };
  }
);

server.registerTool(
  "qvidian.templateList",
  {
    title: "Qvidian Template List",
    description: "List templates for a Qvidian document type",
    inputSchema: {
      docTypeId: z.number().optional(),
      docTypeName: z.string().optional()
    }
  },
  async ({ docTypeId, docTypeName }) => {
    const url = new URL(`${SHIM_BASE}/common/template-list`);
    if (docTypeId !== undefined) url.searchParams.append("docTypeId", String(docTypeId));
    if (docTypeName !== undefined) url.searchParams.append("docTypeName", docTypeName);
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`templateList failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return { content: [{ type: "json", data }], structuredContent: data };
  }
);

server.registerTool(
  "qvidian.dropDownItemsGetList",
  {
    title: "Qvidian Dropdown Items",
    description: "Retrieve dropdown/merge code values from Qvidian",
    inputSchema: {
      listName: z.string().optional(),
      extra: z.record(z.any()).optional()
    }
  },
  async ({ listName, extra }) => {
    const body = { ...(extra || {}) };
    if (listName) body.listName = listName;
    const r = await fetch(`${SHIM_BASE}/common/dropdown-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`dropDownItemsGetList failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return { content: [{ type: "json", data }], structuredContent: data };
  }
);

// --- SSO-session library tools (search / read / download) ---

server.registerTool(
  "qvidian.library.search",
  {
    title: "Qvidian Library Search",
    description: "Search the Qvidian content library by keyword. Returns a list of matching documents with contentID, title, folder path, and a short snippet.",
    inputSchema: {
      query: z.string().min(1).describe("Search terms"),
      pageSize: z.number().int().min(1).max(50).optional().describe("Results per page (default 10)"),
      pageIndex: z.number().int().min(0).optional().describe("Zero-based page index (default 0)"),
      sessionId: z.string().optional().describe("Qvidian sessionId from sso-login (optional if QVIDIAN_SESSION_ID env is set)")
    }
  },
  async ({ query, pageSize, pageIndex, sessionId }) => {
    const r = await fetch(`${SHIM_BASE}/library/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: resolveSessionId(sessionId), query, pageSize, pageIndex })
    });
    if (!r.ok) throw new Error(`library search failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  }
);

server.registerTool(
  "qvidian.library.read",
  {
    title: "Qvidian Library Read Document",
    description: "Fetch the body of a Qvidian library document by contentID. Returns clean plain text by default (suitable for synthesis) or raw HTML.",
    inputSchema: {
      contentID: z.number().int().positive().describe("Content ID from a search result"),
      revision: z.number().int().optional().describe("Revision number (default 1; use -1 for latest)"),
      format: z.enum(["text", "html"]).optional().describe("'text' (default) strips HTML; 'html' returns raw rendering"),
      sessionId: z.string().optional()
    }
  },
  async ({ contentID, revision, format, sessionId }) => {
    const r = await fetch(`${SHIM_BASE}/library/content/${contentID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: resolveSessionId(sessionId), revision: revision ?? 1, format: format ?? "text" })
    });
    if (!r.ok) throw new Error(`library read failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    // For read, also include the prose as a plain text content block for easier LLM consumption.
    const text = data?.body && data.format === "text" ? data.body : JSON.stringify(data);
    return { content: [{ type: "text", text }], structuredContent: data };
  }
);

server.registerTool(
  "qvidian.library.download",
  {
    title: "Qvidian Library Download (metadata only)",
    description: "Returns metadata about a Qvidian document binary download (filename, ext, size). Use qvidian.library.read for the text content to synthesize. Direct binary download is exposed at the shim's POST /library/download/:id endpoint.",
    inputSchema: {
      contentID: z.number().int().positive(),
      revision: z.number().int().optional(),
      sessionId: z.string().optional()
    }
  },
  async ({ contentID, revision, sessionId }) => {
    // HEAD-like: do the POST, but only return metadata (size, filename, content-type).
    const r = await fetch(`${SHIM_BASE}/library/download/${contentID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: resolveSessionId(sessionId), revision: revision ?? -1 })
    });
    if (!r.ok) throw new Error(`library download failed: ${r.status} ${await r.text()}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const dispo = r.headers.get("content-disposition") || "";
    const fnMatch = dispo.match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)/i);
    const fileName = fnMatch ? decodeURIComponent(fnMatch[1]) : null;
    const data = {
      contentID,
      revision: revision ?? -1,
      fileName,
      contentType: r.headers.get("content-type"),
      byteLength: buf.length,
      note: "Binary not returned via MCP. Fetch directly: POST " + SHIM_BASE + "/library/download/" + contentID
    };
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  }
);

// --- HTTP Streamable transport endpoint (/mcp) ---

const app = express();
app.use(express.json());

// One endpoint that supports Streamable HTTP (POST) and SSE (GET) via the SDK transport
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    // Optional: send JSON when not streaming
    enableJsonResponse: true
  });

  res.on("close", () => transport.close());

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Qvidian MCP bridge (Streamable HTTP) on :${PORT} -> ${SHIM_BASE}`);
});
