import express from "express";
import morgan from "morgan";
import cors from "cors";
import NodeCache from "node-cache";
import dotenv from "dotenv";
import soap from "soap";
import path from "path";
import readline from "readline";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

const cache = new NodeCache({ stdTTL: 50 * 60, checkperiod: 120 });

async function callSoapMethod(wsdlUrl, methodName, args) {
  const client = await soap.createClientAsync(wsdlUrl);
  const [result] = await client[`${methodName}Async`](args);
  return result;
}

async function connectByApiKey(baseUrl, apiKey) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const authWsdl = `${normalizedBaseUrl}/webservices/Authentication.asmx?WSDL`;
  const result = await callSoapMethod(authWsdl, "ConnectByAPIKey", { apiKey });
  const r = result?.ConnectByAPIKeyResult || result;
  if (!r?.AuthToken) throw new Error("Authentication failed");
  return { authToken: r.AuthToken, connectionBinding: r, baseUrl: normalizedBaseUrl };
}

function getCtx() {
  const ctx = cache.get("qvidianAuth");
  if (!ctx) throw new Error("Not authenticated");
  return ctx;
}

function getCommonWsdl(ctx) {
  if (ctx.connectionBinding?.CommonURL) {
    return ctx.connectionBinding.CommonURL.includes("?WSDL")
      ? ctx.connectionBinding.CommonURL
      : `${ctx.connectionBinding.CommonURL}?WSDL`;
  }
  return `${ctx.baseUrl}/webservices/Common.asmx?WSDL`;
}

async function callCommonMethod(methodName, request) {
  const ctx = getCtx();
  const commonWsdl = getCommonWsdl(ctx);
  const r = await callSoapMethod(commonWsdl, methodName, { request });
  return r?.[`${methodName}Result`] || r;
}

const sessionStore = new Map();

function normalizeBaseUrl(url) {
  return url.replace(/\/$/, '');
}

function mergeCookieStrings(existing = '', setCookieHeader = '') {
  const cookies = new Map();
  if (existing) {
    for (const part of existing.split(/;\s*/)) {
      const [key, ...rest] = part.split('=');
      if (key && rest.length > 0) cookies.set(key.trim(), rest.join('='));
    }
  }
  if (setCookieHeader) {
    const parts = setCookieHeader.split(/, (?=[^=]+=)/);
    for (const cookie of parts) {
      const [key, ...rest] = cookie.split('=');
      if (key && rest.length > 0) {
        const value = rest.join('=');
        cookies.set(key.trim(), value.split(';')[0]);
      }
    }
  }
  return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'");
}

function encodeHtmlEntities(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/>/g, '&gt;')
    .replace(/</g, '&lt;');
}

function parseHtmlInputs(html) {
  const inputs = {};
  for (const match of html.matchAll(/<input\b([^>]+)>/gi)) {
    const attrs = match[1];
    const nameMatch = attrs.match(/name=["']?([^"'\s>]+)["']?/i);
    if (!nameMatch) continue;
    const valueMatch = attrs.match(/value=["']?([^"']*)["']?/i);
    inputs[nameMatch[1]] = decodeHtmlEntities(valueMatch ? valueMatch[1] : '');
  }
  return inputs;
}

function extractFormAction(html, baseUrl) {
  const match = html.match(/<form\b[^>]*action=["']?([^"'\s>]+)["']?[^>]*>/i);
  if (!match) return baseUrl;
  try {
    return new URL(match[1], baseUrl).toString();
  } catch (err) {
    return baseUrl;
  }
}

function normalizeAuthToken(token) {
  if (!token) return token;
  let current = token;
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

function extractAuthTokenFromHtml(html) {
  const formMatch = html.match(/name=["']?QvidianAuthenticationToken["']?[^>]*value=["']?([^"'>\s]+)["']?/i);
  if (formMatch) return normalizeAuthToken(formMatch[1]);
  const bodyMatch = html.match(/QvidianAuthenticationToken=([^&"'\s]+)/i);
  if (bodyMatch) return normalizeAuthToken(bodyMatch[1]);
  return null;
}

async function createSessionFromAuthToken(baseUrl, authToken, origin, referer, existingCookie = '') {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const payload = new URLSearchParams();
  payload.append('QvidianAuthenticationToken', authToken);
  payload.append('QvidianAuthenticationTokenActive', '');

  const { response, cookieHeader } = await followRedirectsAndCollectCookies(`${normalizedBaseUrl}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(origin ? { Origin: origin } : {}),
      ...(referer ? { Referer: referer } : {}),
      ...(existingCookie ? { Cookie: existingCookie } : {})
    },
    body: payload.toString()
  });

  return { response, cookieHeader };
}

async function createCredentialsSession(baseUrl, username, password, loginBaseUrl) {
  const normalizedLoginBase = loginBaseUrl.replace(/\/$/, '');
  const loginOrigin = new URL(normalizedLoginBase).origin;

  const { response: loginPageResponse, cookieHeader: initialCookies } = await followRedirectsAndCollectCookies(normalizedLoginBase, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  const loginPageHtml = await loginPageResponse.text();
  const formFields = parseHtmlInputs(loginPageHtml);
  formFields['loginInformation$UserName'] = username;
  formFields['loginInformation$Password'] = encodeHtmlEntities(password);
  if (!('loginInformation$Login' in formFields)) {
    formFields['loginInformation$Login'] = 'Log In';
  }
  const formAction = extractFormAction(loginPageHtml, normalizedLoginBase);

  const { response: postLoginResponse, cookieHeader: postLoginCookies } = await followRedirectsAndCollectCookies(formAction, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: normalizedLoginBase,
      Origin: loginOrigin,
      ...(initialCookies ? { Cookie: initialCookies } : {})
    },
    body: new URLSearchParams(formFields).toString()
  });

  let responseHtml = await postLoginResponse.text();
  let authToken = extractAuthTokenFromHtml(responseHtml);
  let cookieHeader = mergeCookieStrings(initialCookies, postLoginCookies);
  let finishResponse = postLoginResponse;

  if (!authToken) {
    const autoFormFields = parseHtmlInputs(responseHtml);
    if (autoFormFields.QvidianAuthenticationToken) {
      authToken = normalizeAuthToken(autoFormFields.QvidianAuthenticationToken);
      const autoFormAction = extractFormAction(responseHtml, formAction);
      const { response: tokenPostResponse, cookieHeader: tokenPostCookies } = await followRedirectsAndCollectCookies(autoFormAction, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: formAction,
          Origin: loginOrigin,
          ...(cookieHeader ? { Cookie: cookieHeader } : {})
        },
        body: new URLSearchParams(autoFormFields).toString()
      });
      cookieHeader = mergeCookieStrings(cookieHeader, tokenPostCookies);
      responseHtml = await tokenPostResponse.text();
      authToken = extractAuthTokenFromHtml(responseHtml) || authToken;
      finishResponse = tokenPostResponse;
    }
  }

  if (!authToken && postLoginResponse.status >= 300 && postLoginResponse.headers.get('location')) {
    const location = new URL(postLoginResponse.headers.get('location'), formAction).toString();
    const { response: redirectedResponse, cookieHeader: redirectCookies } = await followRedirectsAndCollectCookies(location, {
      method: 'GET',
      headers: {
        Referer: formAction,
        Origin: loginOrigin,
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      }
    });
    cookieHeader = mergeCookieStrings(cookieHeader, redirectCookies);
    responseHtml = await redirectedResponse.text();
    authToken = extractAuthTokenFromHtml(responseHtml) || authToken;
    finishResponse = redirectedResponse;
  }

  return { authToken, cookieHeader, responseHtml, status: finishResponse.status };
}

async function followRedirectsAndCollectCookies(url, options) {
  let currentUrl = url;
  let cookieHeader = options.headers?.Cookie || '';
  let lastResponse = null;
  for (let i = 0; i < 10; i += 1) {
    const response = await fetch(currentUrl, { ...options, redirect: 'manual' });
    lastResponse = response;
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      cookieHeader = mergeCookieStrings(cookieHeader, setCookie);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      options = { ...options, body: undefined, method: 'GET' };
      continue;
    }
    break;
  }
  return { response: lastResponse, cookieHeader };
}

function createSessionId() {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let defaultSsoEmail = process.env.QVIDIAN_SSO_EMAIL || null;

function getSession(sessionId) {
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error('Session not found');
  return session;
}

async function callJsonWebMethodWithSession(sessionId, serviceName, methodName, payload) {
  const session = getSession(sessionId);
  const url = buildWebServicesUrl(session.baseUrl, serviceName, methodName);
  const headers = { 'Content-Type': 'application/json; charset=UTF-8' };
  if (session.cookie) headers.Cookie = session.cookie;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload || {}), redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    session.cookie = mergeCookieStrings(session.cookie, setCookie);
  }
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // keep raw text when JSON parse fails
  }
  return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), data };
}

async function validateSession(sessionId) {
  const payload = {
    offset: -600,
    timezoneName: "Australian Eastern Standard Time",
    dstArray: []
  };
  const result = await callJsonWebMethodWithSession(sessionId, 'Common', 'SaveClientTimezoneInfo', payload);
  if (!result.ok) {
    throw new Error(`Session validation failed: ${result.status}`);
  }
  return result;
}

function buildWebServicesUrl(baseUrl, serviceName, methodName) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  return `${normalizedBaseUrl}/WebServices/${serviceName}.asmx/${methodName}`;
}

async function callJsonWebMethod(baseUrl, serviceName, methodName, payload) {
  const url = buildWebServicesUrl(baseUrl, serviceName, methodName);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(payload || {})
  });

  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // keep raw text when JSON parse fails
  }

  return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), data };
}

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/test/webservices/:service/:method", async (req, res) => {
  try {
    const baseUrl = req.body.baseUrl || process.env.QVIDIAN_BASE_URL;
    if (!baseUrl) return res.status(400).json({ error: "Missing baseUrl" });

    const result = await callJsonWebMethod(baseUrl, req.params.service, req.params.method, req.body.payload || {});
    res.status(result.status).json({ ok: result.ok, headers: result.headers, data: result.data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/test/common-timezone", async (req, res) => {
  try {
    const baseUrl = req.body.baseUrl || process.env.QVIDIAN_BASE_URL;
    if (!baseUrl) return res.status(400).json({ error: "Missing baseUrl" });

    const payload = {
      offset: req.body.offset ?? -600,
      timezoneName: req.body.timezoneName || "Australian Eastern Standard Time",
      dstArray: req.body.dstArray || []
    };

    const result = await callJsonWebMethod(baseUrl, "Common", "SaveClientTimezoneInfo", payload);
    res.status(result.status).json({ ok: result.ok, headers: result.headers, data: result.data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/session/login", async (req, res) => {
  try {
    const baseUrl = req.body.baseUrl || process.env.QVIDIAN_BASE_URL;
    const authToken = req.body.authToken || req.body.QvidianAuthenticationToken;
    const loginOrigin = req.body.origin || "https://qpalogin.qvidian.com";
    const loginReferer = req.body.referer || "https://qpalogin.qvidian.com/";
    const userAgent = req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    if (!baseUrl || !authToken) return res.status(400).json({ error: "Missing baseUrl or authToken" });

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const payload = new URLSearchParams();
    payload.append("QvidianAuthenticationToken", authToken);
    payload.append("QvidianAuthenticationTokenActive", "");

    const { response, cookieHeader } = await followRedirectsAndCollectCookies(`${normalizedBaseUrl}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": loginOrigin,
        "Referer": loginReferer,
        "User-Agent": userAgent
      },
      body: payload.toString()
    });

    if (!response) throw new Error("Failed to establish session");

    const sessionId = createSessionId();
    sessionStore.set(sessionId, { baseUrl: normalizedBaseUrl, cookie: cookieHeader || '' });

    const validation = await validateSession(sessionId);

    res.json({
      sessionId,
      status: response.status,
      cookie: cookieHeader || '',
      validation: { status: validation.status, ok: validation.ok, data: validation.data }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/session/credentials", async (req, res) => {
  try {
    const baseUrl = req.body.baseUrl || process.env.QVIDIAN_BASE_URL;
    const username = req.body.username || defaultSsoEmail;
    const password = req.body.password || "";
    const loginUrl = req.body.loginUrl || process.env.QVIDIAN_LOGIN_URL || "https://qpalogin.qvidian.com";
    if (!baseUrl || !username) {
      return res.status(400).json({ error: "Missing baseUrl or username. Set QVIDIAN_SSO_EMAIL or provide username in request." });
    }

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const loginResult = await createCredentialsSession(normalizedBaseUrl, username, password, loginUrl);
    if (!loginResult.authToken && !loginResult.cookieHeader) {
      throw new Error("Login failed: no auth token and no cookies were captured");
    }

    let sessionId;
    let sessionCookie;
    if (loginResult.authToken) {
      const { response, cookieHeader: tokenCookieHeader } = await createSessionFromAuthToken(
        normalizedBaseUrl,
        loginResult.authToken,
        loginUrl,
        loginUrl + "/",
        loginResult.cookieHeader
      );
      sessionCookie = mergeCookieStrings(loginResult.cookieHeader, tokenCookieHeader);
      sessionId = createSessionId();
      sessionStore.set(sessionId, { baseUrl: normalizedBaseUrl, cookie: sessionCookie });
    } else {
      sessionCookie = loginResult.cookieHeader;
      sessionId = createSessionId();
      sessionStore.set(sessionId, { baseUrl: normalizedBaseUrl, cookie: sessionCookie });
    }

    const validation = await validateSession(sessionId);
    res.json({
      sessionId,
      authToken: loginResult.authToken,
      status: loginResult.status,
      cookie: sessionCookie || '',
      validation: { status: validation.status, ok: validation.ok, data: validation.data }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/session/call", async (req, res) => {
  try {
    const sessionId = req.body.sessionId;
    const service = req.body.service;
    const method = req.body.method;
    if (!sessionId || !service || !method) {
      return res.status(400).json({ error: "Missing sessionId, service, or method" });
    }
    const result = await callJsonWebMethodWithSession(sessionId, service, method, req.body.payload || {});
    res.status(result.status).json({ ok: result.ok, headers: result.headers, data: result.data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/auth", async (req, res) => {
  try {
    const baseUrl = req.body.baseUrl || process.env.QVIDIAN_BASE_URL;
    const apiKey = req.body.apiKey || process.env.QVIDIAN_API_KEY;
    if (!baseUrl || !apiKey) return res.status(400).json({ error: "Missing baseUrl/apiKey" });
    const { authToken, connectionBinding, baseUrl: normalizedBaseUrl } = await connectByApiKey(baseUrl, apiKey);
    cache.set("qvidianAuth", { authToken, connectionBinding, baseUrl: normalizedBaseUrl });
    res.json({ authToken, urls: connectionBinding });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/search", async (req, res) => {
  try {
    const ctx = getCtx();
    const { authToken, connectionBinding } = ctx;
    const q = req.body.query;
    if (!q) return res.status(400).json({ error: "query is required" });
    const libraryWsdl = connectionBinding.LibraryURL.includes("?WSDL") ? connectionBinding.LibraryURL : `${connectionBinding.LibraryURL}?WSDL`;
    const request = { AuthToken: authToken, SearchText: q, ...(req.body.extra || {}) };
    if (req.body.docType !== undefined) {
      if (typeof req.body.docType === "number" || /^[0-9]+$/.test(String(req.body.docType))) {
        request.DocTypeID = Number(req.body.docType);
      } else {
        request.DocTypeName = String(req.body.docType);
      }
    }
    if (req.body.savedSearchId !== undefined) {
      request.SearchID = Number(req.body.savedSearchId);
    }
    const r = await callSoapMethod(libraryWsdl, "librarySearch", { request });
    res.json(r?.librarySearchResult || r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/content/:id", async (req, res) => {
  try {
    const ctx = getCtx();
    const { authToken, connectionBinding } = ctx;
    const libraryWsdl = connectionBinding.LibraryURL.includes("?WSDL") ? connectionBinding.LibraryURL : `${connectionBinding.LibraryURL}?WSDL`;
    const request = { AuthToken: authToken, ContentID: Number(req.params.id) };
    const r = await callSoapMethod(libraryWsdl, "libraryContentDetailsGet", { request });
    res.json(r?.libraryContentDetailsGetResult || r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/saved-searches", async (req, res) => {
  try {
    const ctx = getCtx();
    const { authToken, connectionBinding } = ctx;
    const libraryWsdl = connectionBinding.LibraryURL.includes("?WSDL") ? connectionBinding.LibraryURL : `${connectionBinding.LibraryURL}?WSDL`;
    const request = { AuthToken: authToken };
    const r = await callSoapMethod(libraryWsdl, "librarySavedSearchGetList", { request });
    res.json(r?.librarySavedSearchGetListResult || r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/common/doctype-list", async (req, res) => {
  try {
    const ctx = getCtx();
    const { authToken } = ctx;
    const request = { AuthToken: authToken };
    const r = await callCommonMethod("docTypeList", request);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/common/template-list", async (req, res) => {
  try {
    const ctx = getCtx();
    const { authToken } = ctx;
    const request = { AuthToken: authToken };
    if (req.query.docTypeId) request.DocTypeID = Number(req.query.docTypeId);
    if (req.query.docTypeName) request.DocTypeName = String(req.query.docTypeName);
    const r = await callCommonMethod("templateList", request);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/common/dropdown-items", async (req, res) => {
  try {
    const ctx = getCtx();
    const { authToken } = ctx;
    const request = { AuthToken: authToken, ...(req.body || {}) };
    const r = await callCommonMethod("dropDownItemsGetList", request);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/common/has-permissions", async (req, res) => {
  try {
    const ctx = getCtx();
    const { authToken } = ctx;
    const request = { AuthToken: authToken };
    if (req.query.userId) request.UserID = Number(req.query.userId);
    if (req.query.permissionName) request.PermissionName = String(req.query.permissionName);
    const r = await callCommonMethod("HasPermissions", request);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/mcp.json", (req, res) => {
  res.sendFile(path.resolve("/app/mcp.json"), (err) => {
    if (err) res.status(404).json({ error: "mcp.json not found" });
  });
});

const port = Number(process.env.PORT || 3010);
async function promptForSsoEmail() {
  if (defaultSsoEmail) {
    console.log(`Using configured SSO email: ${defaultSsoEmail}`);
    return;
  }
  if (!process.stdin.isTTY) {
    console.warn("No QVIDIAN_SSO_EMAIL configured and standard input is not a TTY. Provide email via QVIDIAN_SSO_EMAIL or set username in /session/credentials.");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  defaultSsoEmail = await new Promise((resolve) => {
    rl.question("Enter Qvidian SSO email address to use by default: ", (answer) => {
      rl.close();
      resolve(answer.trim() || null);
    });
  });

  if (defaultSsoEmail) {
    process.env.QVIDIAN_SSO_EMAIL = defaultSsoEmail;
    console.log(`Default SSO email set to: ${defaultSsoEmail}`);
  } else {
    console.warn("No default SSO email provided. /session/credentials requests will require username in the body.");
  }
}

async function startServer() {
  await promptForSsoEmail();
  app.listen(port, () => console.log(`Qvidian REST shim listening on :${port}`));
}

startServer().catch((err) => {
  console.error("Failed to start Qvidian REST shim:", err);
  process.exit(1);
});
