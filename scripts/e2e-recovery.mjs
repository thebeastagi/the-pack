// E2E: REAL email-OTP loop on pack-preview — claim → binding → silent resume.
// mail.tm disposable mailbox + playwright chromium. Text output only.
import { chromium } from "playwright";

const BASE = "https://pack-preview.thebeastagi.com";
const MT = "https://api.mail.tm";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function mt(path, opts = {}, jwt = null) {
  const res = await fetch(`${MT}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(opts.headers || {}) },
  });
  if (!res.ok && res.status !== 201) throw new Error(`mail.tm ${path} ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json();
}

async function newMailbox() {
  const domains = await mt("/domains");
  const domain = domains["hydra:member"][0].domain;
  const address = `pack-e2e-${Math.random().toString(36).slice(2, 8)}@${domain}`;
  const password = Math.random().toString(36).slice(2) + "A1!";
  await mt("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
  const { token } = await mt("/token", { method: "POST", body: JSON.stringify({ address, password }) });
  return { address, token };
}

async function waitForCode(jwt, sinceMs, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const msgs = await mt("/messages", {}, jwt);
    for (const m of msgs["hydra:member"] || []) {
      if (new Date(m.createdAt).getTime() < sinceMs - 2000) continue;
      const full = await mt(`/messages/${m.id}`, {}, jwt);
      const text = `${full.subject} ${full.text || ""} ${(full.html || []).join(" ")}`;
      const code = text.match(/\b(\d{6})\b/);
      if (code) return code[1];
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error("OTP email never arrived");
}

async function passAccessGate(page, mailbox) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("cloudflareaccess.com")) { log("no Access redirect — already authed?"); return; }
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  await emailInput.waitFor({ timeout: 20000 });
  const sent = Date.now();
  await emailInput.fill(mailbox.address);
  await page.locator('button[type="submit"], button:has-text("Send")').first().click();
  log("OTP requested for", mailbox.address);
  const code = await waitForCode(mailbox.token, sent);
  log("OTP received:", code.replace(/\d/g, "•"), "(6 digits)");
  const codeInput = page.locator('input[name="code"], input[autocomplete="one-time-code"], input[type="text"]').first();
  await codeInput.waitFor({ timeout: 20000 });
  await codeInput.fill(code);
  const submit = page.locator('button[type="submit"]').first();
  if (await submit.isVisible().catch(() => false)) await submit.click();
  await page.waitForURL((u) => u.href.startsWith(BASE), { timeout: 30000 });
  log("Access gate passed →", page.url());
}

const mailbox = await newMailbox();
log("mailbox:", mailbox.address);
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
try {
  // 1. real OTP through the gate
  await passAccessGate(page, mailbox);
  await page.waitForSelector("text=Join the pack", { timeout: 15000 });
  log("PASS 1: fresh visitor sees claim form (no auto-account)");

  // 2. claim a username
  const handle = `e2e-wolf-${Math.random().toString(36).slice(2, 6)}`;
  await page.fill("#h", handle);
  await page.click("#claim button[type=submit]");
  await page.waitForSelector(`text=Welcome, @${handle}`, { timeout: 15000 });
  const bound = await page.locator("text=bound to your email").count();
  log(`PASS 2: claimed @${handle}; binding hint visible: ${bound > 0}`);

  // 3. kill ONLY the pack session cookie (device-lost simulation; Access session stays)
  const cookies = await ctx.cookies(BASE);
  await ctx.clearCookies();
  for (const c of cookies) if (c.name !== "pack_session") await ctx.addCookies([c]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(`text=Welcome, @${handle}`, { timeout: 15000 });
  const claimFormGone = (await page.locator("#claim").count()) === 0;
  log(`PASS 3: SILENT RESUME — no pack_session, real Access email → signed back in as @${handle}; claim form gone: ${claimFormGone}`);

  // 4. brand-new browser context (ALL cookies gone) → fresh OTP, same email → resume
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await passAccessGate(page2, mailbox);
  await page2.waitForSelector(`text=@${handle}`, { timeout: 15000 });
  const claimFormGone2 = (await page2.locator("#claim").count()) === 0;
  const backGreeting = await page2.locator(`text=Welcome`).first().textContent();
  log(`PASS 4: NEW DEVICE — fresh OTP with same email → landed as @${handle}; claim form gone: ${claimFormGone2}; greeting: "${backGreeting?.trim()}"`);
  await ctx2.close();
  console.log(`\nE2E RESULT: ALL PASS — handle ${handle}, email ${mailbox.address}`);
} catch (err) {
  console.error("E2E FAIL:", err.message);
  console.error("url:", page.url());
  await page.screenshot({ path: "/tmp/e2e-fail.png" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
