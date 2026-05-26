#!/usr/bin/env node
import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROFILE_DIR = path.resolve(__dirname, "../.auth/puppeteer-profile");

const args = parseArgs(process.argv.slice(2));
const shimUrl = args.shim || process.env.SHIM_URL || "http://localhost:3010";
const startUrl = args.url || process.env.QVIDIAN_ENTRY_URL || "https://qpalogin.qvidian.com/";
const profileDir = args.profile || process.env.SSO_PROFILE_DIR || DEFAULT_PROFILE_DIR;
const headless = args.headless ?? false;
const timeoutMs = Number(args.timeout || 180_000);
const baseUrlOverride = args.baseUrl || process.env.QVIDIAN_BASE_URL;

mkdirSync(profileDir, { recursive: true });

const browser = await puppeteer.launch({
  headless,
  userDataDir: profileDir,
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});

try {
  const [page] = await browser.pages();
  page.setDefaultNavigationTimeout(timeoutMs);

  const CAPTURED_HEADER_NAMES = [
    "qvidianauthenticationshadow",
    "x-request-verification-token",
    "qpapageinstanceid"
  ];
  const CANONICAL = {
    "qvidianauthenticationshadow": "QvidianAuthenticationShadow",
    "x-request-verification-token": "x-request-verification-token",
    "qpapageinstanceid": "qpaPageInstanceID"
  };

  const capturedHeaders = {};
  let capturedUserAgent = null;
  const isApiRequest = (url) => /\/WebServices\/.+\.asmx\//i.test(url) || /\/(Home|MyWork|Library|Common)\//i.test(url);

  // Track request URLs by ID via the standard event, then read the FINAL (post-network-service) headers
  // from Network.requestWillBeSentExtraInfo via CDP — Chromium adds some headers after Puppeteer's
  // 'request' event fires, so request.headers() alone misses them.
  const requestUrls = new Map();
  const cdp = await page.target().createCDPSession();
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => {
    if (e.request?.method === "POST" && isApiRequest(e.request.url)) {
      requestUrls.set(e.requestId, e.request.url);
    }
  });
  // Track API responses so we can confirm the browser's calls are actually authenticated.
  cdp.on("Network.responseReceived", (e) => {
    const url = requestUrls.get(e.requestId);
    if (!url) return;
    const status = e.response?.status;
    const jsonerror = e.response?.headers?.jsonerror || e.response?.headers?.JsonError;
    if (status && (jsonerror || status >= 400)) {
      console.log(`[sso-login][debug] Browser API call FAILED: ${status} jsonerror=${jsonerror} ${new URL(url).pathname}`);
    } else if (status) {
      console.log(`[sso-login][debug] Browser API call OK: ${status} ${new URL(url).pathname}`);
    }
  });

  let dumpedOnce = false;
  cdp.on("Network.requestWillBeSentExtraInfo", (e) => {
    const url = requestUrls.get(e.requestId);
    if (!url) return;
    const h = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (!dumpedOnce) {
      dumpedOnce = true;
      console.log(`[sso-login][debug] First API request headers (${url}):`);
      for (const [k, v] of Object.entries(h).sort()) {
        const display = k === "cookie" ? `(${v.length} chars: ${v.slice(0, 80)}...)` : v.slice(0, 120);
        console.log(`  ${k}: ${display}`);
      }
    }
    for (const k of CAPTURED_HEADER_NAMES) {
      if (h[k] && !capturedHeaders[CANONICAL[k]]) {
        capturedHeaders[CANONICAL[k]] = h[k];
        console.log(`[sso-login] Captured ${CANONICAL[k]} from ${new URL(url).pathname.split("/").slice(-3).join("/")}`);
      }
    }
    if (h["user-agent"] && !capturedUserAgent) capturedUserAgent = h["user-agent"];
  });

  console.log(`[sso-login] Opening ${startUrl}`);
  console.log(`[sso-login] Profile dir: ${profileDir}`);
  console.log(`[sso-login] If this is your first run (or cookies expired), complete the Microsoft sign-in in the browser window.`);

  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  const tenantHost = await waitForTenantLanding(page, timeoutMs);
  console.log(`[sso-login] Landed on tenant: ${tenantHost}`);

  // Wait until we've captured all three headers or hit the deadline.
  const headerDeadline = Date.now() + 20000;
  while (Date.now() < headerDeadline) {
    if (CAPTURED_HEADER_NAMES.every((k) => capturedHeaders[CANONICAL[k]])) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const missing = CAPTURED_HEADER_NAMES.filter((k) => !capturedHeaders[CANONICAL[k]]);
  if (missing.length) {
    console.warn(`[sso-login] Missing headers after 20s: ${missing.map((k) => CANONICAL[k]).join(", ")}`);
  } else {
    console.log(`[sso-login] All 3 auth headers captured`);
  }

  const cookies = await page.cookies(`https://${tenantHost}/`);
  const tenantCookies = cookies.filter((c) => c.domain.endsWith("qvidian.com"));
  if (tenantCookies.length === 0) {
    throw new Error(`No Qvidian cookies found for ${tenantHost}`);
  }
  console.log(`[sso-login] Captured ${tenantCookies.length} cookie(s) for *.qvidian.com`);

  const tenantBaseUrl = baseUrlOverride || (await derivedBaseUrl(page, tenantHost));
  console.log(`[sso-login] Using baseUrl: ${tenantBaseUrl}`);

  console.log(`[sso-login] Posting cookies + headers to ${shimUrl}/session/import`);
  const response = await fetch(`${shimUrl}/session/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl: tenantBaseUrl,
      cookies: tenantCookies.map((c) => ({ name: c.name, value: c.value })),
      headers: capturedHeaders || {},
      userAgent: capturedUserAgent
    })
  });
  const result = await response.json();
  if (!response.ok || !result.sessionId) {
    console.error(`[sso-login] Shim returned ${response.status}:`, result);
    process.exit(1);
  }

  console.log(`[sso-login] Session established: ${result.sessionId}`);
  console.log(`[sso-login] Validation: status=${result.validation?.status} ok=${result.validation?.ok}`);
  console.log(JSON.stringify({ sessionId: result.sessionId }, null, 2));
} finally {
  await browser.close();
}

async function waitForTenantLanding(page, totalTimeout) {
  const deadline = Date.now() + totalTimeout;
  while (Date.now() < deadline) {
    const url = page.url();
    const host = safeHostname(url);
    if (host && host !== "qpalogin.qvidian.com" && host.endsWith(".qvidian.com")) {
      return host;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for navigation to land on a tenant *.qvidian.com host");
}

async function derivedBaseUrl(page, host) {
  const url = page.url();
  try {
    const u = new URL(url);
    const firstSegment = u.pathname.split("/").filter(Boolean)[0];
    if (firstSegment && /^qpa_/i.test(firstSegment)) {
      return `https://${host}/${firstSegment}`;
    }
  } catch {}
  return `https://${host}`;
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}
