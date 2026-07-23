#!/usr/bin/env node
// the-pack — LIVE multi-AI voice den E2E (voice-den branch, fireside-voices).
// ONE fake-media chromium human joins the fireside as a (mostly) silent
// listener: proves Ash+Birch converse in real audio on the den-voice track,
// transcripts carry character names, the human-interruption gate fires when
// the mic goes hot, and teardown records leg-seconds. Bounded spend:
// 2 legs × ~2.5min ≈ $0.25 upper bound.
//
// Usage: node scripts/voice-den-e2e.mjs [base-url]
// Env: VD_SESSION_TOKEN (pack_session), CF_ID/CF_SECRET (Access svc token)
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";

const require = createRequire("/workspace/beast-super-app/package.json");
const { chromium } = require("@playwright/test");

const base = (process.argv[2] || "https://pack-preview.thebeastagi.com").replace(/\/$/, "");
const host = new URL(base).hostname;
const SLUG = "fireside-voices";
const OUT = "/tmp/vd-e2e";
mkdirSync(OUT, { recursive: true });

const TOKEN = process.env.VD_SESSION_TOKEN;
const CF_ID = process.env.CF_ID, CF_SECRET = process.env.CF_SECRET;
if (!TOKEN || !CF_ID || !CF_SECRET) { console.error("need VD_SESSION_TOKEN, CF_ID, CF_SECRET"); process.exit(1); }

const cfHeaders = { "CF-Access-Client-Id": CF_ID, "CF-Access-Client-Secret": CF_SECRET };
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async () => (await fetch(`${base}/api/dens/${SLUG}/voice/status`, { headers: cfHeaders })).json();

console.log(`multi-AI voice den E2E → ${base}/den/${SLUG}\n`);

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ permissions: ["microphone"], extraHTTPHeaders: cfHeaders });
await ctx.addCookies([{ name: "pack_session", value: TOKEN, domain: host, path: "/", secure: true, httpOnly: false }]);
// Silent-listener mic: fake device audio is a LOUD tone — start with the
// track disabled (sends silence) so the listen-in phase doesn't trip the
// human floor gate; the interruption phase re-enables it on purpose.
await ctx.addInitScript(() => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await real(c);
    for (const t of s.getAudioTracks()) t.enabled = false;
    window.__e2eStream = s;
    return s;
  };
});
const page = await ctx.newPage();
page.on("console", (m) => { if (/error/i.test(m.type())) console.log("  [console.error]", m.text().slice(0, 160)); });

await page.goto(`${base}/den/${SLUG}`, { waitUntil: "domcontentloaded" });
ok("den page loads (authed via seeded session behind Access svc token)", (await page.title()).length > 0, await page.title());
await page.waitForSelector("#voice-btn", { timeout: 15000 });

// ── join as listener ────────────────────────────────────────────────────────
const t0 = Date.now();
await page.click("#voice-btn");
let live = false, vtext = "";
for (let i = 0; i < 45; i++) {
  vtext = (await page.locator("#vstatus").textContent()) || "";
  if (/live around the fire|AI voices at this fire/.test(vtext)) { live = true; break; }
  if (/failed|cannot|full|closed/.test(vtext)) break;
  await sleep(1000);
}
ok("human joined voice (listener)", live, vtext.slice(0, 90));
if (!live) { console.log("join failed — aborting E2E"); await browser.close(); process.exit(1); }

let st = await status();
for (let i = 0; i < 20 && !(st.state === "bridging" && st.cast); i++) { await sleep(1000); st = await status(); }
ok("server: bridging with a 2-character cast", st.state === "bridging" && st.cast?.length === 2, JSON.stringify(st.cast?.map((c) => c.name)));
ok("server: cast is Ash + Birch", st.cast?.map((c) => c.name).join(",") === "Ash,Birch");

// ── record den-voice + measure levels while the wolves talk ────────────────
await page.evaluate(() => {
  const pc = window.__packVoice.pcListen;
  const tracks = pc.getReceivers().map((r) => r.track).filter((t) => t && t.kind === "audio");
  const stream = new MediaStream([tracks[0]]); // first pulled track = den-voice (AI mix)
  const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32000 });
  window.__recChunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) window.__recChunks.push(e.data); };
  rec.start(1000);
  window.__rec = rec;
  // RMS sampling of the AI mix (proof audio is actually flowing to the human ear)
  const ac = new AudioContext({ sampleRate: 48000 });
  const an = ac.createAnalyser();
  an.fftSize = 2048;
  ac.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  window.__levels = [];
  window.__lvlTimer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    window.__levels.push(Math.sqrt(s / buf.length));
  }, 250);
});

console.log("\n… listen-in phase: 75s of Ash+Birch by the fire …\n");
await sleep(75_000);

st = await status();
const down1 = st.counts.downBytes;
ok("server: AI audio flowing to the den (downBytes)", down1 > 500_000, `downBytes=${down1}`);
ok("server: humans NOT flagged talking during listen-in", st.humanTalking === false, `bargeIns=${st.counts.humanBargeIns}`);
const levels = await page.evaluate(() => window.__levels);
const hot = levels.filter((l) => l > 0.01).length;
ok("browser: den-voice track audibly carries speech (RMS)", hot > 40, `${hot}/${levels.length} samples hot, peak=${Math.max(...levels).toFixed(3)}`);

// transcripts: both characters spoke, by name, into the chat log
const msgs = await page.evaluate(() =>
  [...document.querySelectorAll("#messages .msg, .messages .msg, [class*=msg]")].map((m) => m.textContent).join("\n"),
);
const sawAsh = /Ash/.test(msgs), sawBirch = /Birch/.test(msgs);
ok("transcripts: Ash spoke (named line in chat)", sawAsh);
ok("transcripts: Birch spoke (named line in chat)", sawBirch);
writeFileSync(`${OUT}/transcript-dom.txt`, msgs);

// ── interruption: human mic goes hot (fake-device tone) — AIs must yield ───
console.log("\n… interruption phase: mic hot for 8s …\n");
await page.evaluate(() => { for (const t of window.__e2eStream.getAudioTracks()) t.enabled = true; });
let sawHumanTalking = false;
for (let i = 0; i < 8; i++) { await sleep(1000); st = await status(); if (st.humanTalking) sawHumanTalking = true; }
await page.evaluate(() => { for (const t of window.__e2eStream.getAudioTracks()) t.enabled = false; });
st = await status();
ok("gate: human floor detected (humanTalking observed)", sawHumanTalking);
ok("gate: barge-in counted", st.counts.humanBargeIns >= 1, `humanBargeIns=${st.counts.humanBargeIns}`);
ok("gate: AI frames dropped while human held the floor", st.counts.aiFramesDropped > 0, `aiFramesDropped=${st.counts.aiFramesDropped}`);

// ── resume: the wolves should keep talking (to each other / to the noise) ──
console.log("\n… resume phase: 35s …\n");
await sleep(35_000);
st = await status();
ok("server: AI audio resumed after interruption", st.counts.downBytes > down1 + 100_000, `downBytes ${down1} → ${st.counts.downBytes}`);
ok("server: cost tracked at 2-leg pricing", st.estCostUsd > 0.15 && st.estCostUsd < 1.0, `$${st.estCostUsd} at ${st.elapsedS}s (≈$0.10/min)`);

// ── save the recording, leave, verify teardown ─────────────────────────────
const b64 = await page.evaluate(async () => {
  window.__rec.stop();
  clearInterval(window.__lvlTimer);
  await new Promise((r) => setTimeout(r, 800));
  const blob = new Blob(window.__recChunks, { type: "audio/webm" });
  const buf = await blob.arrayBuffer();
  let s = "";
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
});
writeFileSync(`${OUT}/den-voice.webm`, Buffer.from(b64, "base64"));
console.log(`recording saved: ${OUT}/den-voice.webm (${Math.round(b64.length * 0.75 / 1024)}KB)`);

await page.click("#voice-btn"); // Leave voice
await sleep(4000);
st = await status();
ok("teardown: session closed after last human left (no empty-room burn)", ["closed", "failed"].includes(st.state) && st.seats === 0, `state=${st.state}`);
const elapsed = Math.round((Date.now() - t0) / 1000);
console.log(`\nwall-clock session ≈${elapsed}s → ≤$${((elapsed / 60) * 0.10).toFixed(2)} at 2-leg pricing`);

await browser.close();
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
