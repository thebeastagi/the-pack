import assert from "node:assert/strict";
import test from "node:test";
import { avatarClientJs, avatarParams, avatarSvg, WOLF_PATHS } from "../src/avatar.js";
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

test("avatar: deterministic — same handle+kind → byte-identical SVG, across calls", () => {
  for (const kind of ["human", "agent"]) {
    const a = avatarSvg("night-wolf", kind, "general", 44);
    const b = avatarSvg("night-wolf", kind, "general", 44);
    assert.equal(a, b);
    assert.ok(a.startsWith("<svg"), "renders an inline svg");
  }
});

test("avatar: kind selects the wolf class — star-wolf for agents, human-wolf for humans", () => {
  const agent = avatarSvg("ember-keeper", "agent", "general", 44);
  const human = avatarSvg("robin", "human", "general", 44);
  assert.ok(agent.includes('class="pk-av star-wolf"') && agent.includes("<polygon"), "agent = star polygon");
  assert.ok(human.includes('class="pk-av human-wolf"') && human.includes("<path"), "human = silhouette path");
  // the human silhouette must be one of the checked-in poses, verbatim
  assert.ok(WOLF_PATHS.some((w) => human.includes(`d="${w.d}"`)), "path comes from WOLF_PATHS constants");
});

test("avatar: different handles diverge (spot check), unknown theme falls back to general", () => {
  const seen = new Set(["a", "b", "c", "d", "e", "f"].map((h) => avatarSvg(h, "agent", "general", 44)));
  assert.ok(seen.size >= 5, "agent avatars differ across handles");
  assert.equal(avatarSvg("x", "human", "no-such-theme", 44), avatarSvg("x", "human", "general", 44));
});

test("avatar: XSS — hostile handle is hashed, never interpolated", () => {
  const hostile = '"/><img src=x onerror=alert(1)>';
  for (const kind of ["human", "agent"]) {
    const out = avatarSvg(hostile, kind, "general", 44);
    assert.ok(!out.includes("onerror") && !out.includes("<img"), "no injected markup");
    assert.ok(!out.includes(hostile), "handle never appears in output");
    // whole output is only the tags we emit
    assert.ok(/^<svg[^>]*>(<g[^>]*>)?(<(polygon|polyline|path|circle)[^>]*\/?>)+(<\/g>)?<\/svg>$/.test(out.replaceAll("</svg>", "</svg>")), "output is a closed svg of known shapes");
  }
});

test("avatar: collision honesty — human-wolf space is small (~250 combos), collisions exist at 500 handles", () => {
  const keys = new Set();
  for (let i = 0; i < 500; i++) {
    const p = avatarParams(`handle-${i}`, "human", "general");
    keys.add([p.variant, p.flip, p.mark, p.color[0]].join("|"));
  }
  const max = WOLF_PATHS.length * 2 * 4 * 4; // poses × flip × mark × band = 192
  assert.ok(keys.size <= max, "cannot exceed the theoretical combo space");
  assert.ok(keys.size < 500, "pigeonhole: at 500 humans, some share a look — @handle labels disambiguate");
  assert.ok(keys.size > max * 0.6, "hash spreads across most of the combo space");
});

test("avatar: client serialization parses as a classic script and defines avatarSvg", () => {
  const src = avatarClientJs();
  assert.doesNotThrow(() => new Function(src), "client avatar JS must parse");
  const fn = new Function(`${src}; return avatarSvg;`)();
  assert.equal(fn("night-wolf", "human", "general", 44), avatarSvg("night-wolf", "human", "general", 44), "browser copy renders byte-identically to the worker copy");
});

test("pages: den page ships the avatar renderer + roster panel; header chip shows the wolf", async () => {
  const env = makeEnv();
  const claim = await worker.fetch(
    req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle: "av-tester" }) }),
    env,
  );
  const cookie = claim.headers.get("set-cookie")?.split(";")[0] || "";
  const mk = await worker.fetch(
    req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug: "av-den", name: "Avatar Den", topic: "t" }) }),
    env,
  );
  assert.equal((await mk.json()).ok, true);

  const den = await (await worker.fetch(req("/den/av-den", { headers: { cookie } }), env)).text();
  assert.ok(den.includes("function avatarSvg"), "avatar client JS is inlined in the den page");
  assert.ok(den.includes('id="roster"'), "roster panel markup present");
  assert.ok(den.includes("renderRoster"), "roster renderer wired");
  assert.ok(den.includes('class="pk-av human-wolf"'), "header identity chip renders a server-side wolf avatar");
  assert.ok(!den.includes("·agent"), "old ·agent text suffix replaced by the ✦ AI badge");

  const home = await (await worker.fetch(req("/", { headers: { cookie } }), env)).text();
  assert.ok(home.includes('class="pk-av human-wolf"'), "home header chip has the wolf too");
});
