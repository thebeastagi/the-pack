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

// 2. home page brand
const home = await fetch(`${base}/`);
const homeHtml = await home.text();
ok("GET / renders The Pack", home.status === 200 && homeHtml.includes("The Pack"));
ok("brand tokens present (obsidian + gradient)", homeHtml.includes("--obsidian-1:#0a0a13") && homeHtml.includes("--beast-grad"));
ok("honest-state footer", homeHtml.includes("presence rings are receipts"));

// 3. handle claim (human happy path)
const handle = `judge-${run}`.slice(0, 24);
const claim = await fetch(`${base}/api/handles`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ handle, displayName: "Grokathon Judge" }),
});
const claimBody = await claim.json();
const cookie = claim.headers.get("set-cookie") || "";
ok("POST /api/handles (human claim)", claim.status === 201 && claimBody.user?.handle === handle, claimBody.error?.message || "");
ok("session cookie issued", /pack_session=[0-9a-f]{64}/.test(cookie) && /HttpOnly/.test(cookie));

// 4. den directory + lobby
const dens = await getJson("/api/dens");
const lobby = dens.body?.dens?.find((d) => d.slug === "lobby");
ok("GET /api/dens lists lobby", dens.status === 200 && Boolean(lobby), dens.body?.dens ? `${dens.body.dens.length} dens` : "no list");
ok("lobby presence is a number (honest zero ok)", typeof lobby?.present === "number", `present=${lobby?.present}`);

// 5. den page
const denPage = await fetch(`${base}/den/lobby`);
const denHtml = await denPage.text();
ok("GET /den/lobby renders stage + chat", denPage.status === 200 && denHtml.includes("den-stage") && denHtml.includes("new WebSocket"));

// 6. human REST post → history
const posted = await getJson("/api/dens/lobby/messages", {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ body: `live verification ${run}` }),
});
ok("human REST post to lobby", posted.status === 201 && posted.body?.message?.from?.handle === handle);
const hist = await getJson("/api/dens/lobby/messages?limit=10");
ok("message appears in history", hist.body?.messages?.some((m) => m.body === `live verification ${run}`));

// 6.5 voice dens (non-spendy checks only — full duplex smoke is scripts/voice-smoke.mjs)
const vstatus = await getJson("/api/dens/lobby/voice/status");
ok("voice status endpoint (counts-only)", vstatus.status === 200 && typeof vstatus.body?.state === "string", `state=${vstatus.body?.state}`);
const vjoin401 = await fetch(`${base}/api/dens/lobby/voice/join`, { method: "POST" });
ok("voice join requires identity", vjoin401.status === 401);

// 7. live WS roundtrip with two agent citizens (needs admin token to mint keys)
if (admin) {
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
  console.log("SKIP  WS roundtrip (set PACK_ADMIN_TOKEN to enable)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
