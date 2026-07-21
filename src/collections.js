// the-pack — xAI Collections client (wave 2, 2026-07-21): per-den knowledge
// bases. Zero-dep REST (the regular XAI_API_KEY secret covers the management
// endpoints — live-proven 2026-07-21; no separate management key needed).
//
// Why xAI-side Collections (vs Workers AI embeddings + Vectorize or D1 FTS):
//   1. It rides the wave-1 Responses-API tool chain — den brains gain RAG by
//      adding ONE tool ({type:"file_search", vector_store_ids:[…]}) to a call
//      path that already exists, with native collections:// citations.
//   2. Zero new Cloudflare bindings/infra: no Vectorize index provisioning,
//      no embeddings pipeline, no new vendor SDK in a zero-dep worker.
//   3. Exact cost accounting: every search call returns cost_in_usd_ticks,
//      which the existing fail-closed caps ledger already understands.
//   4. xAI does not train on Collections data (docs.x.ai data-privacy note).
//
// REST shapes live-probed 2026-07-21:
//   POST   /v1/collections                       {collection_name, field_definitions:[]}
//   POST   /v1/files                             multipart form, field "file"
//   POST   /v1/collections/{cid}/documents/{fid} {collection_id, file_id, fields:{}}
//   GET    /v1/collections/{cid}/documents       → {documents:[…]}
//   DELETE /v1/collections/{cid}/documents/{fid}
//   DELETE /v1/collections/{cid}
//
// Rules: key from env ONLY, never logged; hard timeouts; NEVER throws into
// the request path — failures return { ok: false, reason } so callers
// degrade honestly (RAG off for that reply, honest errors on doc management).

const BASE = "https://api.x.ai/v1";
const MGMT_TIMEOUT_MS = 20000;

export function collectionsConfigFromEnv(env) {
  const key = env.XAI_API_KEY || "";
  return key ? { apiKey: key } : null;
}

async function call(cfg, method, path, body, { fetchImpl, formData } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MGMT_TIMEOUT_MS);
  try {
    const headers = { authorization: `Bearer ${cfg.apiKey}` };
    let payload;
    if (formData) {
      payload = formData; // browser/Worker FormData sets its own content-type
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await doFetch(`${BASE}${path}`, { method, headers, body: payload, signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = typeof data?.error === "string" ? data.error : data?.error?.message || data?.code || "";
      return { ok: false, reason: `xai http ${res.status}${detail ? `: ${String(detail).slice(0, 80)}` : ""}` };
    }
    return { ok: true, data };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : `${err?.name || "Error"}: ${err?.message || err}`;
    return { ok: false, reason: String(reason).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/** Create a collection. Returns { ok, collectionId?, reason? }. */
export async function createCollection(cfg, name, opts = {}) {
  const out = await call(cfg, "POST", "/collections", { collection_name: name, field_definitions: [] }, opts);
  if (!out.ok) return out;
  const id = out.data?.collection_id;
  return typeof id === "string" && id ? { ok: true, collectionId: id } : { ok: false, reason: "xai no collection_id" };
}

/** Upload a text doc as a file. Returns { ok, fileId?, reason? }. */
export async function uploadTextFile(cfg, name, text, opts = {}) {
  const fd = new FormData();
  fd.append("purpose", "collections");
  fd.append("file", new Blob([text], { type: "text/plain" }), name);
  const out = await call(cfg, "POST", "/files", undefined, { ...opts, formData: fd });
  if (!out.ok) return out;
  const id = out.data?.id;
  return typeof id === "string" && id ? { ok: true, fileId: id } : { ok: false, reason: "xai no file_id" };
}

/** Add an uploaded file to a collection (starts indexing). */
export async function addDocument(cfg, collectionId, fileId, opts = {}) {
  const out = await call(
    cfg,
    "POST",
    `/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(fileId)}`,
    { collection_id: collectionId, file_id: fileId, fields: {} },
    opts,
  );
  return out.ok ? { ok: true } : out;
}

/** List collection documents. Returns { ok, documents? } — raw xAI rows. */
export async function listDocuments(cfg, collectionId, opts = {}) {
  const out = await call(cfg, "GET", `/collections/${encodeURIComponent(collectionId)}/documents`, undefined, opts);
  if (!out.ok) return out;
  return { ok: true, documents: Array.isArray(out.data?.documents) ? out.data.documents : [] };
}

/** Remove a doc from the collection (xAI drops the underlying file too). */
export async function removeDocument(cfg, collectionId, fileId, opts = {}) {
  const out = await call(
    cfg,
    "DELETE",
    `/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(fileId)}`,
    undefined,
    opts,
  );
  return out.ok ? { ok: true } : out;
}

/** Delete a whole collection (den teardown / test cleanup). */
export async function deleteCollection(cfg, collectionId, opts = {}) {
  const out = await call(cfg, "DELETE", `/collections/${encodeURIComponent(collectionId)}`, undefined, opts);
  return out.ok ? { ok: true } : out;
}

/**
 * Map an xAI document row to the pack's doc status. Live-observed
 * 2026-07-21: the proto `status` field and the `processing_status` string
 * lag behind actual index readiness, but chunk counters are truthful — a
 * doc with all chunks processed IS searchable (proven by live file_search).
 */
export function docStatusFromXai(row) {
  if (!row || typeof row !== "object") return "processing";
  if (row.error_message) return "failed";
  const total = Number(row.chunk_count) || 0;
  const done = Number(row.chunks_processed_count) || 0;
  if (total > 0 && done >= total) return "ready";
  return "processing";
}
