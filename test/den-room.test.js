import assert from "node:assert/strict";
import test from "node:test";
import { DenRoom } from "../src/den-room.js";
import { FakeDurableObjectCtx, createFakeD1, installWebSocketStubs } from "./fakes.js";

installWebSocketStubs();

function setup(denId = "den-uuid-1") {
  const DB = createFakeD1();
  const ctx = new FakeDurableObjectCtx();
  const room = new DenRoom(ctx, { DB });
  return { DB, ctx, room };
}

const ID_A = { "x-pack-user-id": "u-a", "x-pack-handle": "anna", "x-pack-display": "Anna", "x-pack-kind": "human", upgrade: "websocket" };
const ID_B = { "x-pack-user-id": "u-b", "x-pack-handle": "bot-1", "x-pack-display": "Bot One", "x-pack-kind": "agent", upgrade: "websocket" };

async function joinWs(room, headers, denId = "den-uuid-1") {
  const res = await room.fetch(new Request(`https://do.internal/ws?den=${denId}`, { headers }));
  assert.equal(res.status, 101);
  return res.webSocket; // client side
}
const frames = (client) => client.received.map((f) => JSON.parse(f));

test("ws requires identity headers + upgrade", async () => {
  const { room } = setup();
  const noId = await room.fetch(new Request("https://do.internal/ws?den=x", { headers: { upgrade: "websocket" } }));
  assert.equal(noId.status, 401);
  const noUp = await room.fetch(new Request("https://do.internal/ws?den=x", { headers: { ...ID_A, upgrade: "" } }));
  assert.equal(noUp.status, 426);
});

test("join → welcome + join broadcast; presence roster per-identity", async () => {
  const { room } = setup();
  const a = await joinWs(room, ID_A);
  const b = await joinWs(room, ID_B);

  const welcomeA = frames(a).find((f) => f.type === "welcome");
  assert.equal(welcomeA.you.handle, "anna");
  assert.equal(welcomeA.present, 1);

  const aFrames = frames(a);
  const joinB = aFrames.find((f) => f.type === "presence" && f.user?.handle === "bot-1");
  assert.equal(joinB.action, "join");
  assert.equal(joinB.present, 2);
  assert.equal(joinB.user.kind, "agent");

  const pres = await (await room.fetch(new Request("https://do.internal/presence"))).json();
  assert.equal(pres.present, 2);
  assert.deepEqual(pres.roster.map((u) => u.handle).sort(), ["anna", "bot-1"]);
});

test("chat over WS persists + broadcasts; attachments survive (hibernation pattern)", async () => {
  const { DB, ctx, room } = setup();
  const a = await joinWs(room, ID_A);
  const b = await joinWs(room, ID_B);
  const serverB = ctx._sockets[1];

  await room.webSocketMessage(serverB, JSON.stringify({ type: "chat", body: "hello den" }));

  for (const client of [a, b]) {
    const chat = frames(client).find((f) => f.type === "chat");
    assert.ok(chat, "chat broadcast received");
    assert.equal(chat.body, "hello den");
    assert.equal(chat.from.handle, "bot-1");
    assert.equal(chat.from.kind, "agent");
  }
  const stored = DB._tables.messages;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].den_id, "den-uuid-1");
  assert.equal(stored[0].user_id, "u-b");
});

test("frame coercion: ArrayBuffer, TypedArray, Blob all accepted (never instanceof-gated)", async () => {
  const { ctx, room } = setup();
  const a = await joinWs(room, ID_A);
  const serverA = ctx._sockets[0];
  const payload = JSON.stringify({ type: "ping" });

  await room.webSocketMessage(serverA, new TextEncoder().encode(payload).buffer);
  await room.webSocketMessage(serverA, new TextEncoder().encode(payload));
  await room.webSocketMessage(serverA, new Blob([payload]));

  const pongs = frames(a).filter((f) => f.type === "pong");
  assert.equal(pongs.length, 3);
});

test("bad frames: invalid json → error frame; oversized → close 1009", async () => {
  const { ctx, room } = setup();
  const a = await joinWs(room, ID_A);
  const serverA = ctx._sockets[0];

  await room.webSocketMessage(serverA, "not json");
  assert.ok(frames(a).some((f) => f.type === "error" && f.code === "bad_json"));

  await room.webSocketMessage(serverA, "x".repeat(9000));
  assert.equal(serverA.closed?.code, 1009);
});

test("rate limit: 8 chat frames per 10s window per socket", async () => {
  const { ctx, room } = setup();
  const a = await joinWs(room, ID_A);
  const serverA = ctx._sockets[0];
  for (let i = 0; i < 8; i++) await room.webSocketMessage(serverA, JSON.stringify({ type: "chat", body: `m${i}` }));
  await room.webSocketMessage(serverA, JSON.stringify({ type: "chat", body: "one too many" }));
  const f = frames(a);
  assert.equal(f.filter((x) => x.type === "chat").length, 8);
  assert.ok(f.some((x) => x.type === "error" && x.code === "rate_limited"));
});

test("leave broadcast on close; empty-body chat rejected", async () => {
  const { ctx, room } = setup();
  const a = await joinWs(room, ID_A);
  const b = await joinWs(room, ID_B);
  const serverB = ctx._sockets[1];

  await room.webSocketMessage(serverB, JSON.stringify({ type: "chat", body: "   " }));
  assert.ok(frames(b).some((f) => f.type === "error" && f.code === "empty_message"));

  await room.webSocketClose(serverB);
  const leave = frames(a).filter((f) => f.type === "presence" && f.action === "leave").at(-1);
  assert.equal(leave.user.handle, "bot-1");
  assert.equal(leave.present, 1);

  const pres = await (await room.fetch(new Request("https://do.internal/presence"))).json();
  assert.equal(pres.present, 1);
});

test("internal broadcast (REST-originated posts) reaches live sockets", async () => {
  const { room } = setup();
  const a = await joinWs(room, ID_A);
  const res = await room.fetch(
    new Request("https://do.internal/internal/broadcast", {
      method: "POST",
      body: JSON.stringify({ type: "chat", id: "m1", ts: "t", from: { handle: "api-poster", display: "API", kind: "human" }, body: "via REST" }),
    }),
  );
  assert.equal(res.status, 200);
  const chat = frames(a).find((f) => f.type === "chat" && f.body === "via REST");
  assert.ok(chat);
});

test("multiple tabs of one identity dedupe in roster", async () => {
  const { room } = setup();
  await joinWs(room, ID_A);
  await joinWs(room, ID_A); // same human, second tab
  const pres = await (await room.fetch(new Request("https://do.internal/presence"))).json();
  assert.equal(pres.present, 1); // presence is per-identity
});
