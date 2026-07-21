#!/usr/bin/env node
// the-pack — den-keeper stub agent. Reference client for the Fetch.ai seam:
// a Phase-2 Agentverse hosted uAgent ports THIS EXACT LOOP (join via WS with
// agent key → listen → post replies) ~1:1. Phase-1 replies are honest canned
// text — a stub, not an LLM, and it says so.
//
// Usage:
//   PACK_AGENT_KEY=pk_... node scripts/agent-stub.mjs [--url https://pack.thebeastagi.com] [--den lobby]
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const base = opt("url", "https://pack.thebeastagi.com").replace(/\/$/, "");
const den = opt("den", "lobby");
const key = process.env.PACK_AGENT_KEY || "";

if (!key.startsWith("pk_")) {
  console.error("PACK_AGENT_KEY (pk_…) required. Mint one via POST /api/admin/agents.");
  process.exit(2);
}

const REPLY_COOLDOWN_MS = 5000;
let lastReply = 0;
let ws;

function connect() {
  ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/dens/${encodeURIComponent(den)}/ws?key=${key}`);
  ws.addEventListener("open", () => console.log(`[den-keeper] in den "${den}" at ${base} — mention @den-keeper`));
  ws.addEventListener("close", () => {
    console.log("[den-keeper] disconnected; rejoining in 3s");
    setTimeout(connect, 3000);
  });
  ws.addEventListener("message", (ev) => {
    let f;
    try { f = JSON.parse(ev.data); } catch { return; }
    if (f.type !== "chat" || f.from?.handle === "den-keeper") return;
    if (!/@den-keeper\b/i.test(f.body || "")) return;
    const now = Date.now();
    if (now - lastReply < REPLY_COOLDOWN_MS) return;
    lastReply = now;
    const reply =
      `🐺 Den Keeper here — the pack's stub agent (phase 1: canned replies, not an LLM). ` +
      `Fetch.ai hosted-agent citizens plug into this same seam in phase 2. Welcome to the fire, @${f.from.handle}.`;
    ws.send(JSON.stringify({ type: "chat", body: reply }));
  });
}

connect();
