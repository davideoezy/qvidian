#!/usr/bin/env node
// One-shot debug: ride along the SSO flow, capture cookies+headers, then make the API
// call directly from Node (no shim) AND also from inside the page via page.evaluate.
// Prints both responses so we can see which path works.
import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const profileDir = process.env.SSO_PROFILE_DIR || path.resolve(__dirname, "../.auth/puppeteer-profile");

const TENANT_PATH = "/qpa_20_1_0000_0039/WebServices/Common.asmx/SaveClientTimezoneInfo";
const TENANT_HOST = "qpa-p1.qvidian.com";
const TEST_PAYLOAD = { offset: -600, timezoneName: "Australian Eastern Standard Time", dstArray: [] };

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: profileDir,
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});

try {
  const [page] = await browser.pages();

  const captured = { headers: {}, ua: null };
  const requestUrls = new Map();
  const cdp = await page.target().createCDPSession();
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => {
    if (e.request?.method === "POST" && /\/qpa_/.test(e.request.url)) requestUrls.set(e.requestId, e.request.url);
  });
  cdp.on("Network.requestWillBeSentExtraInfo", (e) => {
    if (!requestUrls.has(e.requestId)) return;
    const h = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v]));
    for (const name of ["qvidianauthenticationshadow", "x-request-verification-token", "qpapageinstanceid", "user-agent"]) {
      if (h[name]) captured.headers[name] = h[name];
    }
    captured.ua = h["user-agent"] || captured.ua;
  });

  await page.goto("https://qpalogin.qvidian.com/", { waitUntil: "domcontentloaded" });

  // Wait for SSO to complete and page to be active
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (page.url().includes(TENANT_HOST) && captured.headers["qvidianauthenticationshadow"]) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log("\nCaptured headers:");
  for (const [k, v] of Object.entries(captured.headers)) console.log(`  ${k}: ${v.slice(0, 80)}...`);

  // Test 1: call from INSIDE the page (browser context)
  console.log("\n--- Test 1: call from inside page via fetch() ---");
  const inPageResult = await page.evaluate(async (path, payload) => {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(payload),
      credentials: "same-origin"
    });
    return { status: r.status, ok: r.ok, jsonerror: r.headers.get("jsonerror"), text: (await r.text()).slice(0, 300) };
  }, TENANT_PATH, TEST_PAYLOAD);
  console.log("In-page result:", inPageResult);

  // Test 2: call from Node directly with the captured cookies+headers
  console.log("\n--- Test 2: call from Node directly ---");
  const cookies = await page.cookies(`https://${TENANT_HOST}/`);
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  console.log(`  Sending ${cookies.length} cookies (${cookieStr.length} chars)`);
  const nodeHeaders = {
    "Content-Type": "application/json; charset=UTF-8",
    "Accept": "application/json, text/plain, */*",
    "Origin": `https://${TENANT_HOST}`,
    "Referer": `https://${TENANT_HOST}/qpa_20_1_0000_0039/`,
    "Cookie": cookieStr
  };
  if (captured.headers["qvidianauthenticationshadow"]) nodeHeaders["QvidianAuthenticationShadow"] = captured.headers["qvidianauthenticationshadow"];
  if (captured.headers["x-request-verification-token"]) nodeHeaders["x-request-verification-token"] = captured.headers["x-request-verification-token"];
  if (captured.headers["qpapageinstanceid"]) nodeHeaders["qpaPageInstanceID"] = captured.headers["qpapageinstanceid"];
  if (captured.ua) nodeHeaders["User-Agent"] = captured.ua;

  const nodeRes = await fetch(`https://${TENANT_HOST}${TENANT_PATH}`, {
    method: "POST",
    headers: nodeHeaders,
    body: JSON.stringify(TEST_PAYLOAD)
  });
  const nodeText = await nodeRes.text();
  console.log("Node result:", {
    status: nodeRes.status,
    ok: nodeRes.ok,
    jsonerror: nodeRes.headers.get("jsonerror"),
    text: nodeText.slice(0, 300)
  });
} finally {
  await browser.close();
}
