// the-pack — login recovery (0009): email↔username permanent binding,
// re-login via the Access-verified email, anti-squat, silent page resume.
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

let ipN = 0;
const nextIp = () => `10.9.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);

function claimReq(handle, { email = null, accessEmail = null, ip = nextIp() } = {}) {
  const headers = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (accessEmail) headers["cf-access-authenticated-user-email"] = accessEmail;
  return req("/api/handles", { method: "POST", headers, body: JSON.stringify({ handle, ...(email ? { email } : {}) }) });
}

function recoverReq({ accessEmail = null, ip = nextIp() } = {}) {
  const headers = { "cf-connecting-ip": ip };
  if (accessEmail) headers["cf-access-authenticated-user-email"] = accessEmail;
  return req("/api/session/recover", { method: "POST", headers });
}

test("claim binds the Access-verified email (verified wins over typed)", async () => {
  const env = makeEnv();
  const res = await worker.fetch(claimReq("night-wolf", { email: "typed@other.net", accessEmail: "Real@Wolf.Net" }), env);
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.emailBound, true);
  const u = env.DB._tables.users[0];
  assert.equal(u.email, "real@wolf.net"); // lowercased, Access email wins
  assert.ok(u.email_verified_at);
});

test("claim without Access email stays unbound (agents/CI path unchanged)", async () => {
  const env = makeEnv();
  const res = await worker.fetch(claimReq("lone-wolf", { email: "self@asserted.net" }), env);
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.emailBound, false);
  const u = env.DB._tables.users[0];
  assert.equal(u.email, "self@asserted.net");
  assert.equal(u.email_verified_at, null);
});

test("one username per email: second claim from same email → 409 email_bound", async () => {
  const env = makeEnv();
  await worker.fetch(claimReq("first-wolf", { accessEmail: "one@wolf.net" }), env);
  const res = await worker.fetch(claimReq("second-wolf", { accessEmail: "one@wolf.net" }), env);
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error.code, "email_bound");
  assert.match(body.error.message, /@first-wolf/);
  assert.equal(env.DB._tables.users.length, 1);
});

test("anti-squat: email B cannot claim a handle bound to email A", async () => {
  const env = makeEnv();
  await worker.fetch(claimReq("alpha", { accessEmail: "a@wolf.net" }), env);
  const res = await worker.fetch(claimReq("alpha", { accessEmail: "b@wolf.net" }), env);
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error.code, "handle_taken");
});

test("recover: same email gets back the SAME account with a fresh session", async () => {
  const env = makeEnv();
  const claimed = await worker.fetch(claimReq("come-back", { accessEmail: "return@wolf.net" }), env);
  assert.equal(claimed.status, 201);
  // No cookie presented — simulates a new device / expired session.
  const res = await worker.fetch(recoverReq({ accessEmail: "RETURN@wolf.net" }), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.recovered, true);
  assert.equal(body.user.handle, "come-back");
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^pack_session=[0-9a-f]{64}/);
  // The fresh session resolves to the same user via /api/me.
  const me = await worker.fetch(req("/api/me", { headers: { cookie: cookie.split(";")[0] } }), env);
  const meBody = await me.json();
  assert.equal(me.status, 200);
  assert.equal(meBody.user.handle, "come-back");
  assert.equal(meBody.emailBound, true);
  assert.equal(meBody.email, "return@wolf.net");
});

test("recover: unknown email → 404 no_account; no header → 400", async () => {
  const env = makeEnv();
  const missing = await worker.fetch(recoverReq({ accessEmail: "ghost@wolf.net" }), env);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "no_account");
  const bare = await worker.fetch(recoverReq(), env);
  assert.equal(bare.status, 400);
  assert.equal((await bare.json()).error.code, "no_verified_email");
});

test("legacy grandfather: pre-cutoff self-asserted email recovers + promotes; post-cutoff typed email is NOT recovery bait", async () => {
  const env = makeEnv();
  // Legacy account: unverified email, created before the cutoff.
  env.DB._tables.users.push({
    id: "legacy-1", handle: "old-wolf", display_name: "Old Wolf", email: "old@wolf.net",
    email_verified_at: null, kind: "human", created_at: "2026-07-20T00:00:00.000Z", last_seen_at: null,
  });
  const res = await worker.fetch(recoverReq({ accessEmail: "old@wolf.net" }), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.handle, "old-wolf");
  assert.ok(env.DB._tables.users.find((u) => u.id === "legacy-1").email_verified_at); // promoted
  // Post-cutoff typed (unverified) email: recovery must NOT hand the account over.
  await worker.fetch(claimReq("bait-wolf", { email: "victim@mail.net" }), env); // created now (> cutoff), unverified
  const bait = await worker.fetch(recoverReq({ accessEmail: "victim@mail.net" }), env);
  assert.equal(bait.status, 404);
});

test("silent page resume: home GET with Access email + no cookie signs the user back in", async () => {
  const env = makeEnv();
  await worker.fetch(claimReq("page-wolf", { accessEmail: "page@wolf.net" }), env);
  const res = await worker.fetch(
    req("/", { headers: { "cf-access-authenticated-user-email": "page@wolf.net", "cf-connecting-ip": nextIp() } }),
    env,
  );
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") || "", /^pack_session=/);
  assert.match(html, /Welcome back, @page-wolf/);
  // Stranger email: no resume, no cookie, claim form shown.
  const anon = await worker.fetch(
    req("/", { headers: { "cf-access-authenticated-user-email": "new@wolf.net", "cf-connecting-ip": nextIp() } }),
    env,
  );
  assert.equal(anon.headers.get("set-cookie"), null);
  assert.match(await anon.text(), /Join the pack/);
});
