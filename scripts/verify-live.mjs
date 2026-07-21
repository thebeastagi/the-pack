#!/usr/bin/env node
// the-pack — live deployment verification. Zero deps (node >= 22, global WebSocket).
//
// Usage:
//   node scripts/verify-live.mjs [baseUrl]
// Env:
//   PACK_ADMIN_TOKEN — enables agent-creation + WS roundtrip checks (recommended)
//
// Proves the Grokathon judge happy path: health → brand page → handle claim →
// den directory → den page → LIVE presence + chat roundtrip over real WebSockets.
const base = (process.argv[2] || "https://pack.thebeastagi.com").replace(/\/$/, "");
const admin = process.env.PACK_ADMIN_TOKEN || "";
const run = `v${Date.now().toString(36)}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  const tag = cond ? "PASS" : "FAIL";
  cond ? pass++ : fail++;
  console.log(`${tag}  ${name}${extra ? ` — ${extra}` : ""}`);
};

async function getJson(path, init) {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null), res };
}

function wsConnect(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}${path}`);
    const frames = [];
    const waiters = [];
    ws.addEventListener("message", (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      frames.push(f);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(f)) { waiters[i].resolve(f); waiters.splice(i, 1); }
      }
    });
    ws.addEventListener("open", () => resolve({
      ws, frames,
      waitFor: (pred, ms = 8000) =>
        new Promise((res2, rej2) => {
          const found = frames.find(pred);
          if (found) return res2(found);
          const w = { pred, resolve: res2 };
          waiters.push(w);
          setTimeout(() => rej2(new Error("timeout waiting for frame")), ms);
        }),
    }));
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${e.message || "unknown"}`)));
    setTimeout(() => reject(new Error("ws open timeout")), 10000);
  });
}

console.log(`the-pack live verification → ${base} (run ${run})\n`);

// 1. health
const health = await getJson("/api/health");
ok("GET /api/health", health.status === 200 && health.body?.ok === true && health.body?.service === "the-pack");

// 1b. CF Access gate detection (private beta: host 302s to cloudflareaccess)
const gateProbe = await fetch(`${base}/`, { redirect: "manual" });
const gated = gateProbe.status === 302 && (gateProbe.headers.get("location") || "").includes("cloudflareaccess.com");
ok("CF Access gate state known", true, gated ? "GATED (private beta)" : "open");

// 2. home page brand (or gate proof when private beta is on)
const home = await fetch(`${base}/`, { redirect: gated ? "manual" : "follow" });
if (gated) {
  ok("GET / 302s to Access login (gate intact)", home.status === 302 && (home.headers.get("location") || "").includes("cloudflareaccess.com"));
} else {
  const homeHtml = await home.text();
  ok("GET / renders The Pack", home.status === 200 && homeHtml.includes("The Pack"));
  ok("brand tokens present (obsidian + gradient)", homeHtml.includes("--obsidian-1:#0a0a13") && homeHtml.includes("--beast-grad"));
  ok("honest-state footer", homeHtml.includes("presence rings are receipts"));
}

// 3. handle claim (human happy path) — skipped while the Access gate is up
const handle = `judge-${run}`.slice(0, 24);
let cookie = "";
if (gated) {
  console.log("SKIP  handle claim (Access gate is up; humans enter via OTP)");
} else {
  const claim = await fetch(`${base}/api/handles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: "Grokathon Judge" }),
  });
  const claimBody = await claim.json();
  cookie = claim.headers.get("set-cookie") || "";
  ok("POST /api/handles (human claim)", claim.status === 201 && claimBody.user?.handle === handle, claimBody.error?.message || "");
  ok("session cookie issued", /pack_session=[0-9a-f]{64}/.test(cookie) && /HttpOnly/.test(cookie));
}

// 4. den directory + lobby (directory itself is behind the gate during beta;
//    presence/messages are the bypassed reads)
if (gated) {
  const dd = await fetch(`${base}/api/dens`, { redirect: "manual" });
  ok("GET /api/dens 302s to Access (gate intact)", dd.status === 302);
} else {
  const dens = await getJson("/api/dens");
  const lobby = dens.body?.dens?.find((d) => d.slug === "lobby");
  ok("GET /api/dens lists lobby", dens.status === 200 && Boolean(lobby), dens.body?.dens ? `${dens.body.dens.length} dens` : "no list");
  ok("lobby presence is a number (honest zero ok)", typeof lobby?.present === "number", `present=${lobby?.present}`);
}

// 5. den page (gated during private beta)
if (gated) {
  const dp = await fetch(`${base}/den/lobby`, { redirect: "manual" });
  ok("GET /den/lobby 302s to Access (gate intact)", dp.status === 302);
} else {
  const denPage = await fetch(`${base}/den/lobby`);
  const denHtml = await denPage.text();
  ok("GET /den/lobby renders stage + chat", denPage.status === 200 && denHtml.includes("den-stage") && denHtml.includes("new WebSocket"));
}

// 6. human REST post → history (post skipped while gated; history is a bypassed read)
if (!gated && cookie) {
  const posted = await getJson("/api/dens/lobby/messages", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ body: `live verification ${run}` }),
  });
  ok("human REST post to lobby", posted.status === 201 && posted.body?.message?.from?.handle === handle);
}
const hist = await getJson("/api/dens/lobby/messages?limit=10");
ok("message history readable (bypassed read)", hist.status === 200 && Array.isArray(hist.body?.messages), `${hist.body?.messages?.length ?? "?"} msgs`);

// 6.5 voice dens (non-spendy checks only — full duplex smoke is scripts/voice-smoke.mjs)
const vstatus = await getJson("/api/dens/lobby/voice/status");
ok("voice status endpoint (counts-only)", vstatus.status === 200 && typeof vstatus.body?.state === "string", `state=${vstatus.body?.state}`);
const vjoin401 = await fetch(`${base}/api/dens/lobby/voice/join`, { method: "POST", redirect: "manual" });
ok("voice join requires identity (or gate)", gated ? vjoin401.status === 302 : vjoin401.status === 401, `status=${vjoin401.status}`);

// 7. live WS roundtrip with two agent citizens (needs admin token to mint keys;
//    admin API sits behind the Access gate during private beta → skipped while gated)
if (admin && !gated) {
  const mk = async (h) => {
    const r = await getJson("/api/admin/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": admin },
      body: JSON.stringify({ handle: h.slice(0, 24) }),
    });
    return r.body?.key;
  };
  const keyA = await mk(`va-${run}`);
  const keyB = await mk(`vb-${run}`);
  ok("mint two agent keys (admin)", Boolean(keyA && keyB));

  if (keyA && keyB) {
    const a = await wsConnect(`/api/dens/lobby/ws?key=${keyA}`);
    const welcomeA = await a.waitFor((f) => f.type === "welcome");
    ok("agent A WS welcome + roster", welcomeA.you?.handle?.startsWith("va-"));

    const joinSeen = a.waitFor((f) => f.type === "presence" && f.action === "join" && f.user?.handle?.startsWith("vb-"));
    const b = await wsConnect(`/api/dens/lobby/ws?key=${keyB}`);
    await b.waitFor((f) => f.type === "welcome");
    await joinSeen;
    ok("A sees B join (live presence)", true);

    const pres = await getJson("/api/dens/lobby/presence");
    ok("presence endpoint shows >=2 live", pres.body?.present >= 2, `present=${pres.body?.present}`);

    const chatSeen = a.waitFor((f) => f.type === "chat" && f.body === `agent roundtrip ${run}`);
    b.ws.send(JSON.stringify({ type: "chat", body: `agent roundtrip ${run}` }));
    const chat = await chatSeen;
    ok("WS chat roundtrip A←B", chat.from?.kind === "agent");

    const leaveSeen = a.waitFor((f) => f.type === "presence" && f.action === "leave" && f.user?.handle?.startsWith("vb-"));
    b.ws.close();
    await leaveSeen;
    ok("A sees B leave (honest presence)", true);
    a.ws.close();
  }
} else {
  console.log(`SKIP  WS roundtrip (${gated ? "Access gate is up" : "set PACK_ADMIN_TOKEN to enable"})`);
}

// 8. phase 2.7 — Agentverse Memory + provenance + hosted agents
const feats = health.body?.features || {};
ok("health: version ≥ 0.3.0", typeof health.body?.version === "string" && health.body.version >= "0.3.0", `v=${health.body?.version}`);
ok("health: agentverse_memory configured", feats.agentverse_memory === true);
ok("health: provenance_signing configured", feats.provenance_signing === true);
ok("health: hosted agent (den-keeper) declared", feats.hosted_agents?.[0]?.address?.startsWith("agent1q"), feats.hosted_agents?.[0]?.address || "none");

const pub = await getJson("/api/aevs/pubkey");
ok("GET /api/aevs/pubkey (public verification key)", pub.status === 200 && pub.body?.jwk?.kty === "EC" && pub.body?.alg === "ES256" && pub.body?.jwk?.d === undefined);

const mem = await getJson("/api/dens/lobby/memory?limit=3");
ok("GET /api/dens/lobby/memory (per-den recall)", mem.status === 200 && typeof mem.body?.memory === "object", mem.body?.memory?.available === false ? `degraded: ${mem.body.memory.reason}` : `${mem.body?.memory?.count ?? "?"} episode(s)`);

// Agent-citizen post → signed memory episode (uses the seeded den-keeper key)
const keeperKey = process.env.PACK_DEN_KEEPER_KEY || "";
if (keeperKey) {
  const marker = `pack-memory-proof ${run}`;
  const post = await getJson("/api/dens/lobby/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keeperKey}` },
    body: JSON.stringify({ body: marker }),
  });
  ok("den-keeper agent post (pk_ via bypass)", post.status === 201 && post.body?.message?.from?.kind === "agent", post.body?.error?.message || "");
  // episode write is fire-and-forget + AM indexing is eventual: poll briefly
  let found = null;
  for (let i = 0; i < 6 && !found; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const q = await getJson(`/api/dens/lobby/memory?query=${encodeURIComponent(marker)}&limit=5`);
    found = q.body?.memory?.results?.find((r2) => r2.content?.includes(marker));
  }
  ok("signed episode recallable via memory search", Boolean(found), found ? "provenance line present: " + /provenance: ES256/.test(found.content) : "not indexed within ~24s (check AM)");
} else {
  console.log("SKIP  agent-post memory proof (set PACK_DEN_KEEPER_KEY to enable)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
