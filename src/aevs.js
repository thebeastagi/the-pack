// the-pack — provenance signing for platform records.
//
// Scheme: ECDSA over NIST P-256 with SHA-256 (ES256) — the same algorithm
// family as Fetch.ai AEVS v2 receipts. The platform signs a canonical-JSON
// record for every memory episode it writes; anyone can verify the signature
// against the public JWK published at GET /api/aevs/pubkey.
//
// Honesty note: true Fetch.ai AEVS receipts (hash-chained, KMS-anchored,
// explorer-verifiable) are minted by the AEVS Python SDK and can only be
// produced fleet-side (a Workers runtime cannot run the SDK). This module
// provides the platform-side equivalent: tamper-evident signatures with a
// published verification key. Fleet-side AEVS receipts remain available for
// any episode stored through the AEVS-wrapped MCP path by Beast agents.

const KEY_ID = "the-pack-v1";
const ALG = "ES256";

let cachedKey = null; // { jwk, key } — module-scope, per isolate, keyed by raw JWK

export function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** Public JWK for verification endpoints; null when not configured.
 *  Private material (`d`) is stripped defensively even if misconfigured. */
export function publicKeyJwk(env) {
  try {
    const jwk = JSON.parse(env.PACK_SIGNING_PUB_JWK || "");
    if (!jwk || jwk.kty !== "EC") return null;
    const { d, ...pub } = jwk;
    return pub;
  } catch {
    return null;
  }
}

async function signingKey(env) {
  const raw = env.PACK_SIGNING_KEY_JWK;
  if (!raw) return null;
  if (cachedKey && cachedKey.jwk === raw) return cachedKey.key;
  const jwk = JSON.parse(raw);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  cachedKey = { jwk: raw, key };
  return key;
}

/** Sign a record. Returns null when no signing key is configured. */
export async function signRecord(env, record) {
  const key = await signingKey(env).catch(() => null);
  if (!key) return null;
  const data = new TextEncoder().encode(canonicalJson(record));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return { alg: ALG, kid: KEY_ID, sig: b64urlEncode(new Uint8Array(sig)) };
}

/** Verify a signature against a public JWK (used by tests and verifiers). */
export async function verifyRecord(pubJwk, record, signature) {
  if (!signature || signature.alg !== ALG) return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    pubJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(canonicalJson(record));
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64urlDecode(signature.sig),
    data,
  );
}

export const PROVENANCE_KEY_ID = KEY_ID;
export const PROVENANCE_ALG = ALG;
