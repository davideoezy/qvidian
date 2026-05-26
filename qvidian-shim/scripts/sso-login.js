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

  console.log(`[sso-login] Opening ${startUrl}`);
  console.log(`[sso-login] Profile dir: ${profileDir}`);
  console.log(`[sso-login] If this is your first run (or cookies expired), complete the Microsoft sign-in in the browser window.`);

  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  const tenantHost = await waitForTenantLanding(page, timeoutMs);
  console.log(`[sso-login] Landed on tenant: ${tenantHost}`);

  // Give the page a moment to finalize any in-flight cookie writes.
  await new Promise((r) => setTimeout(r, 1500));

  const cookies = await page.cookies(`https://${tenantHost}/`);
  const tenantCookies = cookies.filter((c) => c.domain.endsWith("qvidian.com"));
  if (tenantCookies.length === 0) {
    throw new Error(`No Qvidian cookies found for ${tenantHost}`);
  }
  console.log(`[sso-login] Captured ${tenantCookies.length} cookie(s) for *.qvidian.com`);

  const tenantBaseUrl = baseUrlOverride || (await derivedBaseUrl(page, tenantHost));
  console.log(`[sso-login] Using baseUrl: ${tenantBaseUrl}`);

  console.log(`[sso-login] Posting cookies to ${shimUrl}/session/import`);
  const response = await fetch(`${shimUrl}/session/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl: tenantBaseUrl,
      cookies: tenantCookies.map((c) => ({ name: c.name, value: c.value }))
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
