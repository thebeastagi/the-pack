import assert from "node:assert/strict";
import test from "node:test";
import {
  clampStr, coerceToText, escapeHtml, isHandle, isSlug, parseCookies, safeEqualHex, sha256Hex, softRateLimit,
} from "../src/util.js";

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml(`<script>"x"&'</script>`), "&lt;script&gt;&quot;x&quot;&amp;&#39;&lt;/script&gt;");
  assert.equal(escapeHtml(null), "");
});

test("handle validation", () => {
  for (const ok of ["ab", "night-wolf", "wolf_42", "a".repeat(24), "00agent"]) assert.ok(isHandle(ok), ok);
  for (const bad of ["a", "Abc", "-x", "_x", "has space", "x".repeat(25), "", 42, "éwolf"]) assert.ok(!isHandle(bad), String(bad));
});

test("slug validation incl. reserved", () => {
  for (const ok of ["lobby", "frontend-wolves", "a1", "x".repeat(40)]) assert.ok(isSlug(ok), ok);
  for (const bad of ["a", "API", "api", "admin", "-x", "x".repeat(41), "under_score"]) assert.ok(!isSlug(bad), String(bad));
});

test("safeEqualHex", async () => {
  const h = await sha256Hex("secret");
  assert.ok(safeEqualHex(h, h));
  assert.ok(!safeEqualHex(h, await sha256Hex("other")));
  assert.ok(!safeEqualHex(h, "short"));
  assert.ok(!safeEqualHex(null, h));
});

test("coerceToText handles every frame shape (Jul-20 Blob lesson)", async () => {
  assert.equal(await coerceToText("hello"), "hello");
  assert.equal(await coerceToText(new TextEncoder().encode("buf").buffer), "buf");
  assert.equal(await coerceToText(new Uint8Array([104, 105])), "hi");
  assert.equal(await coerceToText(new DataView(new TextEncoder().encode("dv").buffer)), "dv");
  assert.equal(await coerceToText(new Blob(["bl", "ob"])), "blob");
  assert.equal(await coerceToText(null), "");
  assert.equal(await coerceToText(42), "");
});

test("softRateLimit windows", () => {
  const key = `t:${Math.random()}`;
  for (let i = 0; i < 3; i++) assert.ok(softRateLimit(key, 3, 60_000));
  assert.ok(!softRateLimit(key, 3, 60_000));
});

test("parseCookies + clampStr", () => {
  assert.deepEqual(parseCookies("a=1; b=hello world; pack_session=abc"), { a: "1", b: "hello world", pack_session: "abc" });
  assert.deepEqual(parseCookies(null), {});
  assert.equal(clampStr("  abc  ", 2), "ab");
  assert.equal(clampStr(5, 2), "");
});
