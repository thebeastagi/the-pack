// the-pack — overnight QA round 1 (2026-07-24): honest-UX fixes.
//  * load-* internal test dens hidden from the public roster (self-audit K1)
//  * honest recency: real lastActivity on den cards (K4)
//  * cast dens (fireside-voices) speak about THEIR wolves, not the Den Keeper
//  * guest mode: read-only live view instead of a 401 WS "reconnecting…" loop
//  * empty-chat first-word invitation
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs } from "./fakes.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

function makeEnv(overrides = {}) {
  const DB = createFakeD1();
  return {
    DB,
    DEN_ROOMS: createFakeDoNamespace({ DB }),
    MEDIA: createFakeR2(),
    ADMIN_TOKEN: "test-admin-token",
    PACK_VERSION: "test",
    PRIVATE_BETA: "0",
    ...overrides,
  };
}
const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };
async function claimHandle(env, handle, extra = {}) {
  const res = await worker.fetch(
    req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle, ...extra }) }),
    env,
  );
  const cookie = res.headers.get("set-cookie")?.split(";")[0] || "";
  return { res, cookie, body: await res.json() };
}
async function mkDen(env, cookie, slug, extra = {}) {
  const res = await worker.fetch(
    req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug, name: slug, ...extra }) }),
    env,
  );
  assert.equal(res.status, 201);
  return res.json();
}

test("public den list hides load-* test dens but keeps direct access", async () => {
  const env = makeEnv();
  const { cookie } = await claimHandle(env, "qa-wolf");
  await mkDen(env, cookie, "real-den");
  await mkDen(env, cookie, "load-e2e-abc");
  const list = await (await worker.fetch(req("/api/dens"), env)).json();
  assert.ok(list.ok);
  const slugs = list.dens.map((d) => d.slug);
  assert.ok(slugs.includes("real-den"), "real dens stay listed");
  assert.ok(!slugs.some((s) => s.startsWith("load-")), "load-* dens never reach the public roster");
  // direct URL still works (hidden, not deleted)
  const direct = await (await worker.fetch(req("/api/dens/load-e2e-abc"), env)).json();
  assert.ok(direct.ok);
  const page = await worker.fetch(req("/den/load-e2e-abc"), env);
  assert.equal(page.status, 200);
});

test("den cards carry honest lastActivity (real timestamp or null, never invented)", async () => {
  const env = makeEnv();
  const { cookie } = await claimHandle(env, "recency-wolf");
  await mkDen(env, cookie, "quiet-den");
  await mkDen(env, cookie, "spoken-den");
  const post = await worker.fetch(
    req("/api/dens/spoken-den/messages", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ body: "first flame" }) }),
    env,
  );
  assert.equal(post.status, 201);
  const list = await (await worker.fetch(req("/api/dens"), env)).json();
  const quiet = list.dens.find((d) => d.slug === "quiet-den");
  const spoken = list.dens.find((d) => d.slug === "spoken-den");
  assert.equal(quiet.lastActivity, null, "no messages -> null, not a fake time");
  assert.ok(typeof spoken.lastActivity === "string" && spoken.lastActivity.length > 0);
  assert.ok(!Number.isNaN(new Date(spoken.lastActivity).getTime()));
});

test("cast den page speaks about its wolves, not the Den Keeper", async () => {
  const env = makeEnv();
  const { cookie } = await claimHandle(env, "cast-wolf");
  await mkDen(env, cookie, "fireside-voices", { name: "Fireside Voices" });
  const html = await (await worker.fetch(req("/den/fireside-voices", { headers: { cookie } }), env)).text();
  assert.match(html, /Ash/);
  assert.match(html, /Birch/);
  assert.match(html, /resident AI voices/);
  assert.match(html, /doze by the fire/);
  assert.ok(!/Den Keeper \(our AI host\)/.test(html), "generic Den Keeper copy must not show on a cast den");
  // non-cast dens keep the generic copy + default empty note
  await mkDen(env, cookie, "plain-den");
  const plain = await (await worker.fetch(req("/den/plain-den", { headers: { cookie } }), env)).text();
  assert.match(plain, /Den Keeper \(our AI host\)/);
  assert.match(plain, /the fire burns low — the pack is elsewhere/);
  assert.ok(!/resident AI voices/.test(plain));
});

test("guest den view is read-only live (no WS 401 loop); authed view keeps WS", async () => {
  const env = makeEnv();
  const { cookie } = await claimHandle(env, "guest-host");
  await mkDen(env, cookie, "open-den");
  const guest = await (await worker.fetch(req("/den/open-den"), env)).text();
  assert.match(guest, /const AUTHED=false/);
  assert.match(guest, /watching as a guest/);
  const authed = await (await worker.fetch(req("/den/open-den", { headers: { cookie } }), env)).text();
  assert.match(authed, /const AUTHED=true/);
  assert.match(authed, /new WebSocket/);
});

test("empty-chat invitation + public-room disclosure are in the den page", async () => {
  const env = makeEnv();
  const { cookie } = await claimHandle(env, "empty-wolf");
  await mkDen(env, cookie, "fresh-den");
  const html = await (await worker.fetch(req("/den/fresh-den", { headers: { cookie } }), env)).text();
  assert.match(html, /no words at this fire yet — say the first/);
  assert.match(html, /public room — anyone can read it/);
});

test("home page: peek affordance for signed-out visitors; post-claim script targets liveliest den", async () => {
  const env = makeEnv({ AUTH_MODE: "native", TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "s" });
  const html = await (await worker.fetch(req("/"), env)).text();
  assert.match(html, /peek into a live room before you sign up/);
  assert.match(html, /world-readable/);
  assert.match(html, /liveliest den/);
  assert.match(html, /last flame/);
});
