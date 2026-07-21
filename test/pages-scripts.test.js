import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs } from "./fakes.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

function makeEnv(overrides = {}) {
  const DB = createFakeD1();
  const env = {
    DB,
    DEN_ROOMS: createFakeDoNamespace({ DB }),
    MEDIA: createFakeR2(),
    ADMIN_TOKEN: "test-admin-token",
    PACK_VERSION: "test",
    PRIVATE_BETA: "0",
    ...overrides,
  };
  return env;
}

const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };

function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

// Regression: v0.5.0 shipped an /imagine IMG_RE regex inside a template literal;
// the template ate the \/ and \. escapes, the served regex was unterminated,
// and the ENTIRE den-page script failed to parse — dead chat, dead WS, dead voice.
// Every inline <script> we serve MUST parse as classic-script JS.
test("served inline scripts parse as JavaScript (home + den pages)", async () => {
  const env = makeEnv();
  const home = await (await worker.fetch(req("/"), env)).text();
  const homeScripts = inlineScripts(home);
  assert.ok(homeScripts.length >= 1, "home page should have inline scripts");
  for (const src of homeScripts) assert.doesNotThrow(() => new Function(src), "home inline script must parse");

  // den page (needs a den)
  const claim = await worker.fetch(req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle: "script-checker" }) }), env);
  const cookie = claim.headers.get("set-cookie")?.split(";")[0] || "";
  const mk = await worker.fetch(
    req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug: "script-den", name: "Script Den", topic: "t" }) }),
    env,
  );
  assert.equal((await mk.json()).ok, true);
  const den = await (await worker.fetch(req("/den/script-den"), env)).text();
  const denScripts = inlineScripts(den);
  assert.ok(denScripts.length >= 1, "den page should have inline scripts");
  for (const src of denScripts) assert.doesNotThrow(() => new Function(src), "den inline script must parse");

  // the /imagine matcher must survive templating with its escapes intact
  const imgRe = den.match(/const IMG_RE=([^;]+);/);
  assert.ok(imgRe, "IMG_RE present in den page");
  assert.doesNotThrow(() => new Function(`return (${imgRe[1]});`), "IMG_RE literal must parse");
  const re = new Function(`return (${imgRe[1]});`)();
  assert.ok(re.test("🎨 /media/gen/abc12345-x.png"), "IMG_RE matches a painted line");
  assert.ok(!re.test("🎨 /media/gen/abc12345-x.png/eval"), "IMG_RE is anchored");
});

test("HTML pattern attributes are valid under Chrome's v-flag compilation", () => {
  // Chrome compiles pattern="..." as new RegExp('^(?:...)$','v'); invalid ones are
  // silently ignored (validation off) and spam console errors.
  for (const p of ["[a-z0-9][a-z0-9_\\-]{1,23}", "[a-z0-9][a-z0-9\\-]{1,39}"]) {
    assert.doesNotThrow(() => new RegExp(`^(?:${p})$`, "v"), `pattern must be v-mode valid: ${p}`);
  }
});

test("media routes: 404 for missing, 503 (not 404) for R2 errors, 200 for hits", async () => {
  const env = makeEnv();
  // missing object
  let res = await worker.fetch(req("/media/den-nope"), env);
  assert.equal(res.status, 404);
  // R2 get throws -> 503 media_unavailable (regression: used to masquerade as 404)
  const throwingMedia = {
    async get() { throw new Error("r2 exploded"); },
    async put() {},
  };
  const env2 = makeEnv({ MEDIA: throwingMedia });
  res = await worker.fetch(req("/media/den-nope"), env2);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "media_unavailable");
  // hit
  await env.MEDIA.put("den-art/lobby.png", new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
  res = await worker.fetch(req("/media/den-lobby"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-pack-art-source"), "r2");
});
