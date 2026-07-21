#!/usr/bin/env node
// the-pack — LIVE human↔human voice smoke (P2.5). TWO fake-mic chromium
// clients join the lobby voice den; proves both hear the FLOOR (each other)
// plus den-voice (the AI), against server-side truth + browser RTP stats.
// Bounded xAI spend (~$0.05–0.08) — one session, two seats.
import { createRequire } from "node:module";

const require = createRequire("/workspace/beast-super-app/package.json");
const { chromium } = require("@playwright/test");

const base = (process.argv[2] || "https://pack.thebeastagi.com").replace(/\/$/, "");
const HOLD_MS = Number(process.env.VOICE_SMOKE_HOLD_MS || 40_000);
const run = `h2h${Date.now().toString(36)}`;
const ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"];

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function status() {
  return (await fetch(`${base}/api/dens/lobby/voice/status`)).json();
}

console.log(`the-pack HUMAN↔HUMAN voice smoke → ${base} (run ${run})\n`);

const browser = await chromium.launch({ args: ARGS });

async function makeClient(tag) {
  const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async (h) => {
    await fetch("/api/handles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: h, displayName: h }),
    });
  }, `${tag}-${run}`.slice(0, 24));
  await page.goto(`${base}/den/lobby`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#voice-btn", { timeout: 10000 });
  return page;
}

const pageA = await makeClient("wolf-a");
const pageB = await makeClient("wolf-b");
ok("two clients claimed handles + entered lobby", true);

await pageA.click("#voice-btn");
await sleep(2000);
await pageB.click("#voice-btn");

async function waitLive(page, tag) {
  for (let i = 0; i < 60; i++) {
    const t = await page.locator("#vstatus").textContent();
    if (/live around the fire/.test(t || "")) return true;
    if (/failed|cannot|full/.test(t || "")) return false;
    await sleep(1000);
  }
  return false;
}
const [liveA, liveB] = [await waitLive(pageA, "A"), await waitLive(pageB, "B")];
ok("client A live in voice", liveA);
ok("client B live in voice", liveB);

let st = null;
for (let i = 0; i < 30; i++) {
  st = await status();
  if (st.state === "bridging" && st.seats === 2 && st.counts.upBytes > 0) break;
  await sleep(1000);
}
ok("server: bridging with TWO seats", st.state === "bridging" && st.seats === 2, `state=${st.state} seats=${st.seats}`);

// hold: both fake mics stream; floors should carry each other's audio
const floor0 = st.counts.floorBytes;
await sleep(HOLD_MS);
st = await status();
ok("server: FLOOR bytes flowing (humans hear each other)", st.counts.floorBytes > floor0 && st.counts.floorBytes > 100000, `floorBytes ${floor0} → ${st.counts.floorBytes}`);
ok("server: den-voice downlink flowing (AI present)", st.counts.downBytes > 0, `downBytes=${st.counts.downBytes}`);
ok("server: cost bounded (one session, two seats)", st.estCostUsd > 0 && st.estCostUsd < 0.5, `$${st.estCostUsd}`);

// browser-side truth: each pcListen carries 2 inbound audio tracks with bytes
async function inboundTracks(page, tag) {
  return page.evaluate(async () => {
    const pc = window.__packVoice?.pcListen;
    if (!pc) return { tracks: 0, bytes: 0 };
    let tracks = 0, bytes = 0;
    (await pc.getStats()).forEach((r) => {
      if (r.type === "inbound-rtp" && r.kind === "audio") { tracks++; bytes += r.bytesReceived || 0; }
    });
    return { tracks, bytes };
  });
}
const inA = await inboundTracks(pageA, "A");
const inB = await inboundTracks(pageB, "B");
ok("browser A: 2 inbound audio tracks (den-voice + floor)", inA.tracks >= 2, `tracks=${inA.tracks} bytes=${inA.bytes}`);
ok("browser B: 2 inbound audio tracks (den-voice + floor)", inB.tracks >= 2, `tracks=${inB.tracks} bytes=${inB.bytes}`);
ok("browser A+B: floor RTP bytes received", inA.bytes > 50000 && inB.bytes > 50000, `A=${inA.bytes} B=${inB.bytes}`);

// A leaves: session survives for B (seat-scoped teardown), then B leaves: closes
await pageA.click("#voice-btn");
await sleep(3000);
st = await status();
ok("server: session survives A leaving (seat-scoped)", st.state === "bridging" && st.seats === 1, `state=${st.state} seats=${st.seats}`);
await pageB.click("#voice-btn");
for (let i = 0; i < 20; i++) {
  st = await status();
  if (st.state === "closed" || st.state === "created") break;
  await sleep(1000);
}
ok("server: closes after last seat leaves", ["closed", "created"].includes(st.state), `state=${st.state}`);

await browser.close();
console.log(`\nfinal: state=${st.state} elapsedS=${st.elapsedS} estCostUsd=$${st.estCostUsd} up=${st.counts.upBytes}B down=${st.counts.downBytes}B floor=${st.counts.floorBytes}B`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
