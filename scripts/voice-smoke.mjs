#!/usr/bin/env node
// the-pack — LIVE voice-den duplex smoke (bounded xAI spend ~$0.05–0.08).
// Real headless chromium with a fake mic joins the lobby voice den; asserts
// the full duplex path against SERVER-SIDE truth (the VoiceDen status record):
//   join → bridging → upBytes > 0 (mic frames reaching the DO)
//   → downBytes > 0 (xAI disclosure audio flowing back) → leave → closed.
// Playwright resolves from the beast-super-app install (fleet pattern:
// createRequire from a canonical dir).
import { createRequire } from "node:module";

const require = createRequire("/workspace/beast-super-app/package.json");
const { chromium } = require("@playwright/test");

const base = (process.argv[2] || "https://pack.thebeastagi.com").replace(/\/$/, "");
const HOLD_MS = Number(process.env.VOICE_SMOKE_HOLD_MS || 45_000); // ≈ $0.04
const run = `vs${Date.now().toString(36)}`;

// CF Access edge-pass for headless runs while the gate is up (svc token envs).
const edge =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? { "cf-access-client-id": process.env.CF_ACCESS_CLIENT_ID, "cf-access-client-secret": process.env.CF_ACCESS_CLIENT_SECRET }
    : {};

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  cond ? pass++ : fail++;
};

async function status() {
  const r = await fetch(`${base}/api/dens/lobby/voice/status`, { headers: edge });
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`the-pack voice-den LIVE smoke → ${base} (run ${run}, hold ${HOLD_MS / 1000}s ≈ $${((HOLD_MS / 60000) * 0.05 + 0.02).toFixed(2)})\n`);

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const page = await (await browser.newContext({ permissions: ["microphone"], extraHTTPHeaders: edge })).newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [browser console.error]", m.text().slice(0, 140));
});

// 1. claim a handle (cookie lands in the browser context)
await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
const claimed = await page.evaluate(async (h) => {
  const r = await fetch("/api/handles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: h, displayName: "Voice Smoke" }),
  });
  return r.status;
}, `vsmoke-${run}`.slice(0, 24));
ok("handle claim in browser", claimed === 201, `status=${claimed}`);

// 2. enter the lobby, join voice
await page.goto(`${base}/den/lobby`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#voice-btn", { timeout: 10000 });
await page.click("#voice-btn");

let live = false;
for (let i = 0; i < 60; i++) {
  const t = await page.locator("#vstatus").textContent();
  if (/live around the fire/.test(t || "")) { live = true; break; }
  if (/failed|cannot/.test(t || "")) break;
  await sleep(1000);
}
const vtext = await page.locator("#vstatus").textContent();
ok("browser reaches live voice state", live, (vtext || "").trim().slice(0, 80));

// 3. server-side truth: bridging + both directions flowing
let st = null;
for (let i = 0; i < 30; i++) {
  st = await status();
  if (st.state === "bridging" && st.counts.upBytes > 0) break;
  await sleep(1000);
}
ok("server: session bridging", st.state === "bridging", `state=${st.state} seats=${st.seats}`);
ok("server: UPLINK frames flowing (upBytes > 0)", st.counts.upBytes > 0, `upBytes=${st.counts.upBytes}`);

// 4. hold: disclosure + any replies flow DOWNLINK
const down0 = st.counts.downBytes;
await sleep(HOLD_MS);
st = await status();
ok("server: DOWNLINK audio flowing (disclosure+)", st.counts.downBytes > down0, `downBytes ${down0} → ${st.counts.downBytes}`);
ok("server: mixer running (mixTicks growing)", st.counts.mixTicks > 100, `mixTicks=${st.counts.mixTicks}`);
ok("server: cost metered, bounded", st.estCostUsd > 0 && st.estCostUsd < 0.5, `estCostUsd=$${st.estCostUsd}`);
ok("server: exactly ONE seat (cost per den, not per listener row)", st.seats === 1, `seats=${st.seats}`);

// 5. leave -> session closes (no orphaned spend)
await page.click("#voice-btn");
for (let i = 0; i < 20; i++) {
  st = await status();
  if (st.state === "closed" || st.state === "created") break;
  await sleep(1000);
}
ok("server: session closes after last seat leaves", ["closed", "created"].includes(st.state), `state=${st.state}`);

await browser.close();
console.log(`\nfinal: state=${st.state} elapsedS=${st.elapsedS} estCostUsd=$${st.estCostUsd} up=${st.counts.upBytes}B down=${st.counts.downBytes}B`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
