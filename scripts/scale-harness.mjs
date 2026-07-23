#!/usr/bin/env node
// the-pack — P1/P2 scale + real-time harness (plan §D, 2026-07-23).
// Zero deps (node >= 22, global WebSocket with undici `headers` option).
//
// Subcommands (state in STATE_FILE, metrics JSONL in METRICS_FILE — /tmp only):
//   seed       --tag t                       mint stub wolves, create 2 dens, connect 1 hosted citizen per den
//   drive      --den a|b --turns N           marquee agent<->agent chain: WS stub wolf <-> hosted Grok citizen
//   humans     --den a|b --k 3               simulated human WS joiners: RTT/roundtrip/cross/presence/stub-reply/churn
//   captest    --den a|b --max 34            fire generate:true until 429 "brain is resting" (politeness cap = PASS)
//   hibernate  --den a|b                     idle-den DO wake: fresh WS + chat roundtrip
//   verify     --den a|b                     memory attach + ES256 provenance verification vs /api/aevs/pubkey
//   liveness                                 Agentverse hosted-agent loop liveness (/logs/latest age)
//   summarize                                metrics JSONL -> §C2 table (markdown to stdout + SUMMARY_FILE)
//
// Env: PACK_ADMIN_TOKEN, CF_ACCESS_CLIENT_ID/SECRET (Access svc token),
//      AGENTVERSE_API_KEY (only used by `seed` + `liveness`).
// $-safety: only `drive` (N Grok turns) and `captest` spend; everything else is $0.
// Hard budget: MAX_GROK_CALLS across the whole state file; harness refuses beyond it.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { webcrypto } from "node:crypto";

const args = process.argv.slice(2);
const cmd = args[0] || "help";
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const base = (process.env.PACK_BASE || "https://pack.thebeastagi.com").replace(/\/$/, "");
const admin = process.env.PACK_ADMIN_TOKEN || "";
const svcId = process.env.CF_ACCESS_CLIENT_ID || "";
const svcSecret = process.env.CF_ACCESS_CLIENT_SECRET || "";
const edge = svcId && svcSecret ? { "cf-access-client-id": svcId, "cf-access-client-secret": svcSecret } : {};
const STATE_FILE = process.env.STATE_FILE || "/tmp/p1/state.json";
const METRICS_FILE = process.env.METRICS_FILE || "/tmp/p1/metrics.jsonl";
const SUMMARY_FILE = process.env.SUMMARY_FILE || "/tmp/p1/summary.md";
const MAX_GROK_CALLS = Number(process.env.MAX_GROK_CALLS || 45); // whole-pilot budget guard

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (...a) => console.log(`[${now()}]`, ...a);

function loadState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { grokCalls: 0, http: { ok: 0, err: 0, deliberate429: 0 } };
}
function saveState(s) {
  mkdirSync("/tmp/p1", { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function metric(name, den, ms, extra = {}) {
  appendFileSync(METRICS_FILE, JSON.stringify({ metric: name, den, ms, t: now(), ...extra }) + "\n");
}
const state = loadState();
function countHttp(status, deliberate = false) {
  if (deliberate) state.http.deliberate429++;
  else if (status >= 200 && status < 300) state.http.ok++;
  else state.http.err++;
}

async function api(path, { method = "GET", body, headers = {}, deliberate429 = false } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...edge, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  });
  const data = await res.json().catch(() => null);
  countHttp(res.status, deliberate429 && res.status === 429);
  return { status: res.status, body: data, res };
}

function wsConnect(path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}${path}`, { headers: { ...edge, ...extraHeaders } });
    const frames = [];
    const waiters = [];
    ws.addEventListener("message", (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      f._rx = Date.now();
      frames.push(f);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(f)) { waiters[i].resolve(f); waiters.splice(i, 1); }
      }
    });
    ws.addEventListener("open", () => resolve({
      ws, frames,
      send: (obj) => ws.send(JSON.stringify(obj)),
      waitFor: (pred, ms = 10000) =>
        new Promise((res2, rej2) => {
          const found = frames.find(pred);
          if (found) return res2(found);
          const w = { pred, resolve: res2 };
          waiters.push(w);
          setTimeout(() => { const ix = waiters.indexOf(w); if (ix !== -1) waiters.splice(ix, 1); rej2(new Error(`timeout waiting for frame (${ms}ms)`)); }, ms);
        }),
      close: () => { try { ws.close(); } catch {} },
    }));
    ws.addEventListener("error", () => reject(new Error("ws error (handshake)")));
    setTimeout(() => reject(new Error("ws open timeout")), 15000);
  });
}

async function pingSamples(conn, den, n = 30, label = "ws_rtt") {
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const p = conn.waitFor((f) => f.type === "pong" && f._rx >= t0, 5000).catch(() => null);
    conn.send({ type: "ping" });
    const f = await p;
    if (f) metric(label, den, f._rx - t0);
    else metric(label + "_miss", den, -1);
    await sleep(150);
  }
}

const AV = "https://agentverse.ai/v1/hosting/agents";
const avKey = process.env.AGENTVERSE_API_KEY || "";
async function av(pathSuffix = "", init = {}) {
  const res = await fetch(`${AV}${pathSuffix}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${avKey}`, ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── seed ────────────────────────────────────────────────────────────────────
async function seed() {
  if (!admin || !svcId) throw new Error("need PACK_ADMIN_TOKEN + CF_ACCESS_CLIENT_ID/SECRET");
  if (!avKey) throw new Error("need AGENTVERSE_API_KEY for citizen connect");
  const tag = opt("tag", Date.now().toString(36).slice(-4));
  state.tag = tag;
  state.dens = {};
  const mk = async (h) => {
    const r = await api("/api/admin/agents", { method: "POST", headers: { "x-admin-token": admin }, body: { handle: h } });
    if (r.status !== 201 && r.status !== 200) throw new Error(`mint ${h} failed: ${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`);
    return r.body.key;
  };
  for (const [dk, wolves] of [["a", ["wolf-a", "wolf-b"]], ["b", ["wolf-c", "wolf-d"]]]) {
    const slug = `load-p1${dk}-${tag}`;
    const den = { slug, wolves: {}, citizen: null };
    for (const w of wolves) {
      const handle = `${w}-${tag}`;
      den.wolves[w] = { handle, key: await mk(handle) };
      log(`minted ${handle}`);
    }
    const firstKey = den.wolves[wolves[0]].key;
    const cr = await api("/api/dens", {
      method: "POST",
      headers: { authorization: `Bearer ${firstKey}` },
      body: { slug, name: `Load Den P1-${dk.toUpperCase()}`, topic: "P1 scale pilot — live agent-to-agent test (temporary)", searchTools: false, brainTier: "standard" },
    });
    if (cr.status !== 201) throw new Error(`den ${slug} create failed: ${cr.status} ${JSON.stringify(cr.body)?.slice(0, 160)}`);
    log(`den created: ${slug}`);
    // hosted citizen (fleet Agentverse account)
    const citizenHandle = `ember-${dk}-${tag}`;
    const cn = await api("/api/agents/connect", {
      method: "POST",
      body: {
        handle: citizenHandle,
        displayName: `Ember ${dk.toUpperCase()}`,
        agentverseApiKey: avKey,
        denSlug: slug,
        persona: "a thoughtful fire-keeper wolf of the pack; concise and warm; when asked to pass a question along to another pack member, address them directly by their @handle",
      },
    });
    if (cn.status !== 201) throw new Error(`citizen connect ${citizenHandle} failed: ${cn.status} ${JSON.stringify(cn.body)?.slice(0, 200)}`);
    den.citizen = { handle: citizenHandle, key: cn.body.packKey, address: cn.body.hosted.address, started: cn.body.hosted.started };
    log(`citizen connected: ${citizenHandle} -> ${cn.body.hosted.address} started=${cn.body.hosted.started}`);
    state.dens[dk] = den;
    saveState(state);
  }
  // wait for both citizens to be running with recent logs
  for (const dk of ["a", "b"]) {
    const c = state.dens[dk].citizen;
    let ready = false;
    for (let i = 0; i < 18 && !ready; i++) {
      await sleep(10000);
      const g = await av(`/${c.address}`);
      const l = await av(`/${c.address}/logs/latest`);
      const logs = Array.isArray(l.body) ? l.body : l.body?.logs || [];
      ready = g.body?.running === true && logs.length > 0;
      log(`citizen ${c.handle}: running=${g.body?.running} logs=${logs.length}`);
    }
    if (!ready) log(`WARN citizen ${c.handle} not confirmed running+logging after 3min`);
    state.dens[dk].citizen.ready = ready;
  }
  saveState(state);
  log("seed complete", JSON.stringify({ tag, dens: Object.fromEntries(Object.entries(state.dens).map(([k, d]) => [k, d.slug])) }));
}

// ── drive: marquee agent<->agent chain ─────────────────────────────────────
async function drive() {
  const dk = opt("den", "a");
  const turns = Number(opt("turns", 4));
  const den = state.dens[dk];
  if (!den) throw new Error(`no den ${dk} in state — run seed`);
  if (state.grokCalls + turns > MAX_GROK_CALLS) throw new Error(`budget: grokCalls ${state.grokCalls}+${turns} would exceed ${MAX_GROK_CALLS}`);
  const [wA, wB] = Object.values(den.wolves);
  const ember = den.citizen;
  const transcriptFile = `/tmp/p1/transcript-${dk}.jsonl`;

  const connA = await wsConnect(`/api/dens/${den.slug}/ws?key=${wA.key}`);
  await connA.waitFor((f) => f.type === "welcome");
  const connB = await wsConnect(`/api/dens/${den.slug}/ws?key=${wB.key}`);
  await connB.waitFor((f) => f.type === "welcome");
  log(`wolves ${wA.handle} + ${wB.handle} in ${den.slug} over live WS`);

  const record = (f) => appendFileSync(transcriptFile, JSON.stringify(f) + "\n");
  connA.ws.addEventListener("message", (ev) => { try { const f = JSON.parse(ev.data); if (f.type === "chat") record({ ...f, _rx: Date.now() }); } catch {} });

  const topics = [
    "what makes a den feel alive at night?",
    "and what should a young wolf learn first here?",
    "one more: how do you keep the fire from going out?",
    "last one: what do you remember about this den so far?",
    "bonus: what would you tell a wolf who is afraid of the dark?",
    "and finally: how does the pack decide when to rest?",
  ];
  let mentionTs = null;
  let replies = 0;
  const post = async (fromKey, body) => {
    const r = await api(`/api/dens/${den.slug}/messages`, { method: "POST", headers: { authorization: `Bearer ${fromKey}` }, body: { body } });
    if (r.status !== 201) log(`WARN post failed ${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`);
    return r.body?.message;
  };

  // turn 0: wolf-a opens, asking ember to also address wolf-b (organic cross-mention probe)
  let m = await post(wA.key, `@${ember.handle} ${topics[0]} (and if you like, pass a thought to @${wB.handle} by name)`);
  mentionTs = m?.ts;
  log(`wolf-a mentioned @${ember.handle} at ${mentionTs}`);

  while (replies < turns) {
    let frame;
    const sinceTs = mentionTs;
    try {
      frame = await connA.waitFor((f) => f.type === "chat" && f.from?.handle === ember.handle && new Date(f.ts) > new Date(sinceTs), 90000);
    } catch {
      log(`MISS: no reply from ${ember.handle} within 90s (turn ${replies + 1})`);
      metric("hosted_reply_miss", dk, -1, { turn: replies + 1 });
      break;
    }
    replies++;
    state.grokCalls++;
    saveState(state);
    const latMs = new Date(frame.ts) - new Date(mentionTs);
    metric("hosted_reply", dk, latMs, { turn: replies, server_ts_diff: true, mentions_back: /@wolf-/.test(frame.body) });
    log(`turn ${replies}: ${ember.handle} replied in ${(latMs / 1000).toFixed(1)}s (server ts diff): ${frame.body.slice(0, 120)}...`);
    if (replies >= turns) break;
    await sleep(3000); // stub politeness (agent-stub convention: cooldown before replying)
    m = await post(wB.key, `@${ember.handle} thanks — ${topics[replies] || "tell us more?"}`);
    mentionTs = m?.ts;
    log(`wolf-b follow-up posted at ${mentionTs}`);
  }
  log(`chain done: ${replies}/${turns} generated replies from ${ember.handle}`);
  await pingSamples(connA, dk, 15);
  connA.close(); connB.close();
}

// ── humans: K simulated human WS joiners ───────────────────────────────────
async function humans() {
  const dk = opt("den", "a");
  const k = Number(opt("k", 3));
  const den = state.dens[dk];
  if (!den) throw new Error(`no den ${dk}`);
  const tag = state.tag;
  const fans = [];
  for (let j = 1; j <= k; j++) {
    const handle = `fan-${j}-${tag}`;
    const r = await fetch(`${base}/api/handles`, {
      method: "POST",
      headers: { "content-type": "application/json", ...edge },
      body: JSON.stringify({ handle, displayName: `Fan ${j}` }),
    });
    countHttp(r.status);
    const bodyJ = await r.json().catch(() => null);
    const cookie = (r.headers.get("set-cookie") || "").match(/pack_session=[0-9a-f]+/)?.[0];
    if (r.status !== 201 || !cookie) throw new Error(`fan claim ${handle} failed: ${r.status} ${JSON.stringify(bodyJ)?.slice(0, 120)}`);
    fans.push({ handle, cookie });
  }
  log(`${k} human handles claimed`);

  // fan 1 joins, then measures presence propagation as fans 2..k join
  const c1 = await wsConnect(`/api/dens/${den.slug}/ws`, { cookie: fans[0].cookie });
  await c1.waitFor((f) => f.type === "welcome");
  const conns = [c1];
  for (let j = 1; j < k; j++) {
    const t0 = Date.now();
    const seen = c1.waitFor((f) => f.type === "presence" && f.action === "join" && f.user?.handle === fans[j].handle, 8000);
    const cj = await wsConnect(`/api/dens/${den.slug}/ws`, { cookie: fans[j].cookie });
    await cj.waitFor((f) => f.type === "welcome");
    const pj = await seen.catch(() => null);
    metric(pj ? "presence_propagation" : "presence_propagation_miss", dk, pj ? pj._rx - t0 : -1);
    conns.push(cj);
  }
  // chat roundtrip (own echo) + cross-client delivery, human cadence
  for (let i = 0; i < 8; i++) {
    const sender = conns[i % conns.length];
    const other = conns[(i + 1) % conns.length];
    const marker = `human cadence ${state.tag} ${i} ${Date.now().toString(36)}`;
    const t0 = Date.now();
    const own = sender.waitFor((f) => f.type === "chat" && f.body === marker, 8000).catch(() => null);
    const cross = other.waitFor((f) => f.type === "chat" && f.body === marker, 8000).catch(() => null);
    sender.send({ type: "chat", body: marker });
    const [o, x] = await Promise.all([own, cross]);
    metric(o ? "chat_roundtrip" : "chat_roundtrip_miss", dk, o ? o._rx - t0 : -1);
    metric(x ? "cross_delivery" : "cross_delivery_miss", dk, x ? x._rx - t0 : -1);
    await sleep(2500);
  }
  // WS-stub agent reply: run a faithful agent-stub loop on a wolf, human mentions it
  const wolf = Object.values(den.wolves)[1];
  const ws = await wsConnect(`/api/dens/${den.slug}/ws?key=${wolf.key}`);
  await ws.waitFor((f) => f.type === "welcome");
  let lastReply = 0;
  ws.ws.addEventListener("message", (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.type !== "chat" || f.from?.handle === wolf.handle) return;
    if (!new RegExp(`@${wolf.handle}\\b`, "i").test(f.body || "")) return;
    const t = Date.now();
    if (t - lastReply < 5000) return;
    lastReply = t;
    ws.send({ type: "chat", body: `🐺 ${wolf.handle} here — scripted WS stub reply for the pilot. Hello @${f.from.handle}.` });
  });
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const got = conns[0].waitFor((f) => f.type === "chat" && f.from?.handle === wolf.handle && f._rx >= t0, 20000).catch(() => null);
    conns[0].send({ type: "chat", body: `@${wolf.handle} are you around the fire? (${i})` });
    const g = await got;
    metric(g ? "stub_reply" : "stub_reply_miss", dk, g ? g._rx - t0 : -1);
    await sleep(6000);
  }
  // ping RTT per human conn
  for (const c of conns) await pingSamples(c, dk, 10);
  // churn: last fan leaves, fan1 observes leave
  const t0 = Date.now();
  const leave = c1.waitFor((f) => f.type === "presence" && f.action === "leave" && f.user?.handle === fans[k - 1].handle, 8000).catch(() => null);
  conns[k - 1].close();
  const lv = await leave;
  metric(lv ? "presence_leave" : "presence_leave_miss", dk, lv ? lv._rx - t0 : -1);
  ws.close(); for (const c of conns) c.close();
  log("humans phase complete");
}

// ── captest: server-enforced 30/hr politeness cap ──────────────────────────
async function captest() {
  const dk = opt("den", "a");
  const max = Number(opt("max", 34));
  const den = state.dens[dk];
  const ember = den.citizen;
  let successes = 0, got429 = false, i = 0;
  while (i < max) {
    i++;
    if (state.grokCalls >= MAX_GROK_CALLS) { log(`budget guard hit at grokCalls=${state.grokCalls}`); break; }
    const r = await api(`/api/dens/${den.slug}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${ember.key}` },
      body: { body: "say one short word of encouragement", generate: true, persona: "terse" },
      deliberate429: true,
    });
    if (r.status === 201) { successes++; state.grokCalls++; saveState(state); }
    else if (r.status === 429 && /resting/.test(r.body?.error?.message || "")) {
      got429 = true;
      log(`429 politeness cap after ${successes} generated replies this hour: "${r.body.error.message}"`);
      metric("politeness_cap_429", dk, successes, { message: r.body.error.message });
      break;
    } else {
      log(`unexpected ${r.status}: ${JSON.stringify(r.body)?.slice(0, 140)}`);
      metric("captest_unexpected", dk, -1, { status: r.status });
      break;
    }
    await sleep(1200);
  }
  log(`captest: ${successes} successes, cap429=${got429}`);
}

// ── hibernate: DO wake after idle ──────────────────────────────────────────
async function hibernate() {
  const dk = opt("den", "b");
  const den = state.dens[dk];
  const hist = await api(`/api/dens/${den.slug}/messages?limit=1`);
  const lastTs = hist.body?.messages?.[0]?.ts;
  const idleMin = lastTs ? (Date.now() - new Date(lastTs)) / 60000 : Infinity;
  log(`den ${den.slug} idle ${idleMin.toFixed(1)} min (last msg ${lastTs})`);
  const wolf = Object.values(den.wolves)[0];
  const c = await wsConnect(`/api/dens/${den.slug}/ws?key=${wolf.key}`);
  await c.waitFor((f) => f.type === "welcome");
  const marker = `wake-up ${state.tag} ${Date.now().toString(36)}`;
  const t0 = Date.now();
  const echo = c.waitFor((f) => f.type === "chat" && f.body === marker, 10000).catch(() => null);
  c.send({ type: "chat", body: marker });
  const e = await echo;
  metric(e ? "hibernation_resume" : "hibernation_resume_miss", dk, e ? e._rx - t0 : -1, { idleMin: Number(idleMin.toFixed(1)) });
  log(`hibernation resume roundtrip: ${e ? e._rx - t0 + "ms" : "MISS"} after ${idleMin.toFixed(1)}min idle`);
  c.close();
}

// ── verify: memory attach + provenance ─────────────────────────────────────
async function verifyCmd() {
  const dk = opt("den", "a");
  const den = state.dens[dk];
  const ember = den.citizen;
  const hist = await api(`/api/dens/${den.slug}/messages?limit=50`);
  const emberMsgs = (hist.body?.messages || []).filter((m2) => m2.from?.handle === ember.handle);
  log(`${emberMsgs.length} citizen messages in ${den.slug}`);
  // memory attach: newest citizen message recallable?
  const target = emberMsgs[emberMsgs.length - 1];
  let found = null, attachChecked = now();
  for (let i = 0; i < 12 && !found; i++) {
    const q = await api(`/api/dens/${den.slug}/memory?query=${encodeURIComponent(target.body.slice(0, 80))}&limit=10`);
    found = q.body?.memory?.results?.find((r2) => r2.content?.includes(target.body.slice(0, 60)));
    if (!found) await sleep(5000);
  }
  metric(found ? "memory_attach" : "memory_attach_miss", dk, found ? new Date(attachChecked) - new Date(target.ts) : -1, { msgTs: target.ts });
  log(`memory attach: ${found ? "FOUND" : "NOT FOUND"} (newest citizen msg ${target.ts})`);
  // provenance: verify every signed episode we can recall for this den
  const pub = await api("/api/aevs/pubkey");
  const jwk = pub.body?.jwk;
  const all = await api(`/api/dens/${den.slug}/memory?limit=25`);
  const results = all.body?.memory?.results || [];
  let signed = 0, verified = 0, parsed = 0;
  for (const r2 of results) {
    const content = r2.content || "";
    const mSig = content.match(/provenance: (ES256)\/([\w-]+)\/([\w-]+)/);
    if (!mSig) continue;
    signed++;
    const head = content.split("\nprovenance:")[0];
    const mHead = head.match(/^\[the-pack\] (den:[a-z0-9-]+) ([a-z_]+) — ([\s\S]*) \(([^()]*)\)$/);
    if (!mHead) continue;
    parsed++;
    const record = { platform: "the-pack", v: 1, kind: mHead[2], den: mHead[1], summary: mHead[3], ts: mHead[4] };
    const canonical = (function cj(v) {
      if (v === null || typeof v !== "object") return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(cj).join(",")}]`;
      return `{${Object.keys(v).sort().map((k2) => `${JSON.stringify(k2)}:${cj(v[k2])}`).join(",")}}`;
    })(record);
    const key = await webcrypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const b64 = mSig[3].replace(/-/g, "+").replace(/_/g, "/");
    const sigBytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
    const okv = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sigBytes, new TextEncoder().encode(canonical));
    if (okv) verified++;
  }
  metric("provenance_verified", dk, verified, { signed, parsed, sampled: results.length });
  log(`provenance: ${verified}/${signed} signed episodes verified (parsed ${parsed}, sampled ${results.length})`);
}

// ── liveness ───────────────────────────────────────────────────────────────
async function liveness() {
  for (const dk of Object.keys(state.dens || {})) {
    const c = state.dens[dk].citizen;
    if (!c) { log(`den ${dk}: no hosted citizen (quota-blocked) — skip`); continue; }
    const g = await av(`/${c.address}`);
    const l = await av(`/${c.address}/logs/latest`);
    const logs = Array.isArray(l.body) ? l.body : l.body?.logs || [];
    const newest = logs.map((x) => new Date(x.log_timestamp || x.timestamp || 0)).sort((p, q) => q - p)[0];
    const age = newest ? (Date.now() - newest) / 1000 : -1;
    metric("hosted_loop_age_s", dk, Math.round(age), { running: g.body?.running });
    log(`${c.handle}: running=${g.body?.running} newest log age=${age.toFixed(0)}s (${logs.length} entries)`);
  }
}

// ── summarize ──────────────────────────────────────────────────────────────
function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null; }
async function summarize() {
  const lines = readFileSync(METRICS_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const groups = {};
  for (const l of lines) (groups[l.metric] ||= []).push(l);
  let md = `## Harness metrics summary (${now()})\n\n| metric | n | p50 ms | p95 ms | max ms |\n|---|---|---|---|---|\n`;
  for (const [k, v] of Object.entries(groups)) {
    const ms = v.map((x) => x.ms).filter((x2) => x2 >= 0).sort((a2, b2) => a2 - b2);
    md += `| ${k} | ${v.length} | ${pct(ms, 50) ?? "-"} | ${pct(ms, 95) ?? "-"} | ${ms[ms.length - 1] ?? "-"} |\n`;
  }
  md += `\nHTTP: ${state.http.ok} ok, ${state.http.err} err, ${state.http.deliberate429} deliberate-429 · grok calls: ${state.grokCalls}\n`;
  writeFileSync(SUMMARY_FILE, md);
  console.log(md);
}

const cmds = { seed, drive, humans, captest, hibernate, verify: verifyCmd, liveness, summarize };
if (!cmds[cmd]) {
  console.log("usage: scale-harness.mjs <seed|drive|humans|captest|hibernate|verify|liveness|summarize> [--den a|b] [--turns N] [--k K] [--tag t]");
  process.exit(2);
}
try {
  await cmds[cmd]();
  saveState(state);
} catch (err) {
  saveState(state);
  console.error(`FAIL ${cmd}: ${err.message}`);
  process.exit(1);
}
