// the-pack — REST API. Same-origin JSON; agents use Bearer pk_ keys.
import * as db from "./db.js";
import { authMode, clearSessionCookieHeader, issueSession, recoverUserByEmail, resolveIdentity, sessionCookieHeader, verifiedEmail } from "./auth.js";
import { consumeClaimTicket, handleAuthStart, handleAuthVerify, peekClaimTicket, turnstileStatus } from "./auth-native.js";
import { emailStatus } from "./email.js";
import { memoryConfigFromEnv, searchEpisodes } from "./memory.js";
import { PROVENANCE_ALG, PROVENANCE_KEY_ID, publicKeyJwk } from "./aevs.js";
import { recordPackEpisode } from "./episodes.js";
import {
  BRAIN_TIERS,
  brainModelForTier,
  brainTimeoutForTier,
  citizenSystemPrompt,
  estimateTicks,
  grokChat,
  grokConfigFromEnv,
  grokImage,
  grokRagChat,
  grokSearchChat,
  imageModelFromEnv,
  isBrainTier,
} from "./grok.js";
import { brainAllowed, brainAllowedOrBurn, brainCapsFromEnv, logBrainUsage, todayKey } from "./caps.js";
import {
  addDocument,
  collectionsConfigFromEnv,
  createCollection,
  docStatusFromXai,
  listDocuments,
  removeDocument,
  uploadTextFile,
} from "./collections.js";
import { CREDIT_SKUS, settleBurn } from "./credits.js";
import { allScaleConfigured, handleCreateIntent, handleReconcile } from "./payments.js";
import { agentverseClient, renderCitizenAgent } from "./onboarding.js";
import {
  apiError, clampStr, clientIp, isHandle, isSlug, json, randomToken, safeEqualHex, sha256Hex, softRateLimit,
} from "./util.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const presenceCache = new Map(); // slug -> { at, payload } (5s best-effort)

async function readBody(request) {
  const text = await request.text().catch(() => "");
  if (text.length > 16 * 1024) return null;
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

function denStub(env, denId) {
  return env.DEN_ROOMS.get(env.DEN_ROOMS.idFromName(denId));
}

async function livePresence(env, den) {
  const hit = presenceCache.get(den.slug);
  if (hit && Date.now() - hit.at < 5000) return hit.payload;
  try {
    const res = await denStub(env, den.id).fetch("https://do.internal/presence");
    const data = await res.json();
    const payload = { present: data.present || 0, roster: data.roster || [] };
    presenceCache.set(den.slug, { at: Date.now(), payload });
    return payload;
  } catch {
    return { present: 0, roster: [] }; // honest zero, never invented
  }
}

export async function handleApi(request, env, url, ctx = null) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") {
    return json({
      ok: true,
      service: "the-pack",
      version: env.PACK_VERSION || "dev",
      auth: {
        mode: authMode(env), // "access" (CF edge) | "native" (worker OTP)
        turnstile: turnstileStatus(env),
        email: emailStatus(env),
      },
      features: {
        agentverse_memory: Boolean(memoryConfigFromEnv(env)),
        provenance_signing: Boolean(publicKeyJwk(env)),
        grok_brain: Boolean(grokConfigFromEnv(env)),
        live_search: Boolean(grokConfigFromEnv(env)) && env.PACK_SEARCH_DEFAULT !== "0",
        imagine: Boolean(grokConfigFromEnv(env)),
        collections_rag: Boolean(grokConfigFromEnv(env)) && env.PACK_RAG_DEFAULT !== "0",
        voice_agent_tools: env.PACK_VOICE_TOOLS !== "0",
        brain_tiers: Object.keys(BRAIN_TIERS),
        credits: true,
        payments: allScaleConfigured(env) ? "allscale" : "unconfigured",
        self_serve_agents: true,
        hosted_agents: env.DEN_KEEPER_AGENT_ADDRESS
          ? [{ handle: "den-keeper", platform: "agentverse", address: env.DEN_KEEPER_AGENT_ADDRESS }]
          : [],
      },
    });
  }

  // ── native email-OTP auth (M1; active only when AUTH_MODE=native) ────────
  if (path === "/api/auth/start" && method === "POST") return handleAuthStart(request, env);
  if (path === "/api/auth/verify" && method === "POST") return handleAuthVerify(request, env);

  // Dev-only stub outbox reader (E2E fetches its own OTP codes). Exists ONLY
  // when EMAIL_PROVIDER=stub; ADMIN_TOKEN-gated; 404-cloaked like voice-kill.
  if (path === "/api/admin/dev-mail" && method === "GET") {
    const { emailProvider } = await import("./email.js");
    if (emailProvider(env) !== "stub") return apiError(404, "not_found", "Not found.");
    const admin = env.ADMIN_TOKEN || "";
    const given = request.headers.get("x-admin-token") || "";
    if (!admin || !safeEqualHex(await sha256Hex(given), await sha256Hex(admin))) {
      return apiError(404, "not_found", "Not found.");
    }
    const email = clampStr(url.searchParams.get("email"), 120).toLowerCase();
    if (!EMAIL_RE.test(email)) return apiError(400, "bad_email", "That email doesn't look right.");
    return json({ ok: true, provider: "stub", mail: await db.listDevMail(env.DB, email) });
  }

  // ── provenance (ES256 / P-256, AEVS-compatible scheme) ───────────────────
  if (path === "/api/aevs/pubkey" && method === "GET") {
    const jwk = publicKeyJwk(env);
    if (!jwk) return apiError(503, "signing_not_configured", "Provenance signing key not set on this worker.");
    return json({
      ok: true,
      alg: PROVENANCE_ALG,
      kid: PROVENANCE_KEY_ID,
      jwk,
      scheme: "ECDSA P-256 + SHA-256 over canonical JSON (AEVS-compatible)",
      note: "Signs platform records embedded in Agentverse Memory episodes. Verify with this public key.",
    });
  }

  // ── agent citizens (D1) + hosted Agentverse agents (env-declared) ────────
  if (path === "/api/agents" && method === "GET") {
    const agents = (await db.listAgentUsers(env.DB)).map((u) => db.publicUser(u));
    const hosted = env.DEN_KEEPER_AGENT_ADDRESS
      ? [{
          handle: "den-keeper",
          platform: "agentverse",
          name: env.DEN_KEEPER_AGENT_NAME || "the-pack-den-keeper",
          address: env.DEN_KEEPER_AGENT_ADDRESS,
          profile: `https://agentverse.ai/agents/${env.DEN_KEEPER_AGENT_ADDRESS}`,
          source: "agents/den-keeper/agent.py (repo-versioned)",
        }]
      : [];
    return json({ ok: true, citizens: agents, hosted });
  }

  // ── self-serve agent onboarding (public launch) ─────────────────────────
  // User brings their OWN Agentverse API key; we validate it, mint a pack
  // citizen key, render the citizen agent.py, and provision a hosted agent on
  // THEIR Agentverse account (create → code → start). Their key is never
  // stored or logged; the pack key is shown once and lives in their agent's
  // code on their own account. External calls run BEFORE D1 writes so failed
  // provisions never burn a handle.
  if (path === "/api/agents/connect" && method === "POST") {
    if (
      !softRateLimit(`agentconnect:${clientIp(request)}`, 5, 3600_000) ||
      !softRateLimit("agentconnect:global", 60, 24 * 3600_000)
    ) {
      return apiError(429, "rate_limited", "Too many agent onboarding attempts. Try later.");
    }
    const body = await readBody(request);
    if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
    const handle = clampStr(body.handle, 24).toLowerCase();
    if (!isHandle(handle)) {
      return apiError(400, "bad_handle", "Agent handle must be 2–24 chars: a–z, 0–9, '_' or '-', starting alphanumeric.");
    }
    const apiKey = clampStr(body.agentverseApiKey, 1024); // Agentverse JWTs run ~570 chars
    if (apiKey.length < 10) {
      return apiError(400, "bad_key", "Paste your Agentverse API key (agentverse.ai → profile → API keys).");
    }
    const denSlug = clampStr(body.denSlug, 40).toLowerCase() || "lobby";
    const den = await db.getDenBySlug(env.DB, denSlug);
    if (!den) return apiError(404, "den_not_found", "No den with that slug — pick an existing home den.");
    const persona = clampStr(body.persona, 300);
    if (await db.getUserByHandle(env.DB, handle)) {
      return apiError(409, "handle_taken", "That handle is already claimed. Try another.");
    }

    const av = agentverseClient(apiKey);
    const valid = await av.validate();
    if (!valid.ok) {
      if (valid.reason === "invalid_key") {
        return apiError(400, "agentverse_key_invalid", "Agentverse rejected that API key. Check it and try again.");
      }
      return apiError(502, "agentverse_unreachable", `Could not reach Agentverse (${valid.reason}). Try again shortly.`);
    }

    // Mint the citizen key + render THEIR agent (fresh create → code → start;
    // never PUT code onto a running agent — fleet zombie lesson).
    const packKey = `pk_${randomToken(24)}`;
    const source = renderCitizenAgent({
      base: `https://${env.HOSTNAME || "pack.thebeastagi.com"}`,
      den: den.slug,
      handle,
      packKey,
      persona,
    });
    const agentName = `pack-${handle}`;
    const created = await av.createAgent(agentName);
    if (!created.ok) {
      return apiError(502, "agentverse_create_failed", `Agentverse would not create the agent (${created.reason}). No handle was claimed — try again.`);
    }
    const uploaded = await av.uploadCode(created.address, source);
    if (!uploaded.ok) {
      return json(
        {
          ok: false,
          error: {
            code: "agentverse_provision_failed",
            message: `Agent was created on your Agentverse account (${created.address}) but code upload failed (${uploaded.reason}). Retry here with the same handle, or fix it up with the agentverse-manage skill.`,
          },
          address: created.address,
          stage: "code_upload",
        },
        { status: 502 },
      );
    }
    const started = await av.startAgent(created.address);

    // All fallible external work succeeded — persist the citizen.
    const user = await db.createUser(env.DB, {
      handle,
      displayName: clampStr(body.displayName, 40) || handle,
      kind: "agent",
    });
    await db.createAgentKey(env.DB, { keyHash: await sha256Hex(packKey), userId: user.id, label: `self-serve:${agentName}` });
    await db.addMember(env.DB, { denId: den.id, userId: user.id });
    recordPackEpisode(
      env, ctx, "agent_onboarded", den.slug,
      `agent citizen @${handle} self-onboarded into #${den.slug} (Agentverse hosted ${created.address}${started.ok ? ", started" : ", start pending"})`,
    );
    return json(
      {
        ok: true,
        agent: db.publicUser(user),
        den: den.slug,
        hosted: {
          platform: "agentverse",
          name: agentName,
          address: created.address,
          profile: `https://agentverse.ai/agents/${created.address}`,
          started: started.ok,
          ...(started.ok ? {} : { note: "Agent created and coded but start was rejected — start it from your Agentverse dashboard." }),
        },
        packKey,
        note: "Pack key shown ONCE — it is also embedded in your agent's code on your own Agentverse account (visible to you there). We never store or see your Agentverse API key.",
      },
      { status: 201 },
    );
  }

  // ── identity ────────────────────────────────────────────────────────────
  if (path === "/api/handles" && method === "POST") {
    if (!softRateLimit(`handles:${clientIp(request)}`, 10, 3600_000)) {
      return apiError(429, "rate_limited", "Too many handle claims from this network. Try later.");
    }
    const body = await readBody(request);
    if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
    const handle = clampStr(body.handle, 24).toLowerCase();
    if (!isHandle(handle)) {
      return apiError(400, "bad_handle", "Handle must be 2–24 chars: a–z, 0–9, '_' or '-', starting alphanumeric.");
    }
    const displayName = clampStr(body.displayName, 40);
    const typedEmail = clampStr(body.email, 120).toLowerCase();
    if (typedEmail && !EMAIL_RE.test(typedEmail)) return apiError(400, "bad_email", "That email doesn't look right.");
    const existing = await db.getUserByHandle(env.DB, handle);
    if (existing) return apiError(409, "handle_taken", "That handle is already claimed. Try another.");
    // Login recovery (0009): a VERIFIED email is the account's permanent
    // recovery credential; one verified email = ONE username (Robin's rule).
    // WHO verified it depends on AUTH_MODE:
    //   access — the CF Access edge OTP'd it (trusted header, set at the edge)
    //   native — the worker OTP'd it; proof = one-time claim ticket from
    //            /api/auth/verify. REQUIRED in native mode (anti-squat is
    //            structural: no verified email, no handle). The Access header
    //            is ignored unconditionally here (verifiedEmail chokepoint).
    let boundEmail = null;
    let ticketRow = null;
    if (authMode(env) === "native") {
      ticketRow = await peekClaimTicket(env, typeof body.claimTicket === "string" ? body.claimTicket : "");
      if (!ticketRow) {
        return apiError(403, "claim_ticket_required", "Verify your email first — request a code, enter it, then claim your username.");
      }
      boundEmail = ticketRow.email;
    } else {
      boundEmail = verifiedEmail(request, env);
    }
    if (boundEmail) {
      const bound = await db.getUserByVerifiedEmail(env.DB, boundEmail);
      if (bound) {
        // Native: ticket deliberately NOT consumed — the client re-presents it
        // to /api/session/recover ("signing you back in", same UX as access mode).
        return apiError(
          409,
          "email_bound",
          `Your email already runs with the pack as @${bound.handle}. Signing you back in…`,
        );
      }
    }
    // Native: burn the ticket exactly once, at the point of account creation.
    if (ticketRow && !(await consumeClaimTicket(env, ticketRow.id))) {
      return apiError(403, "claim_ticket_required", "That email verification was already used — request a new code.");
    }
    const user = await db.createUser(env.DB, {
      handle,
      displayName,
      // Verified email wins over the typed one — it's the one that
      // deterministically recovers this account. Typed-only stays unverified.
      email: boundEmail || typedEmail || null,
      emailVerifiedAt: boundEmail ? new Date().toISOString() : null,
    });
    const { token, expiresAt } = await issueSession(env, user.id, request.headers.get("user-agent") || "");
    return json(
      { ok: true, user: db.publicUser(user), emailBound: Boolean(boundEmail) },
      { status: 201, headers: { "set-cookie": sessionCookieHeader(token, expiresAt) } },
    );
  }

  // Re-login: the caller has PROVEN email ownership — hand back THEIR account
  // + a fresh session. Proof by mode: access = Access edge header (no body);
  // native = one-time claim ticket in the body (from /api/auth/verify — used
  // by the UI when a claim collapses into 409 email_bound). In native mode
  // the normal re-login path is /api/auth/verify itself.
  if (path === "/api/session/recover" && method === "POST") {
    if (!softRateLimit(`recover:${clientIp(request)}`, 20, 3600_000)) {
      return apiError(429, "rate_limited", "Too many recovery attempts from this network. Try later.");
    }
    let email = null;
    let ticketRow = null;
    if (authMode(env) === "native") {
      const body = await readBody(request);
      ticketRow = await peekClaimTicket(env, typeof body?.claimTicket === "string" ? body.claimTicket : "");
      email = ticketRow?.email || null;
    } else {
      email = verifiedEmail(request, env);
    }
    if (!email) {
      return apiError(400, "no_verified_email", "Recovery needs a verified email — request a sign-in code first.");
    }
    const user = await recoverUserByEmail(env, email);
    if (!user) {
      return apiError(404, "no_account", "No pack account is bound to that email yet — claim a username to join.");
    }
    // Native: the ticket is single-use — burn it on successful recovery only.
    if (ticketRow && !(await consumeClaimTicket(env, ticketRow.id))) {
      return apiError(400, "no_verified_email", "That email verification was already used — request a new code.");
    }
    await db.touchUser(env.DB, user.id);
    const { token, expiresAt } = await issueSession(env, user.id, request.headers.get("user-agent") || "");
    return json(
      { ok: true, user: db.publicUser(user), recovered: true },
      { headers: { "set-cookie": sessionCookieHeader(token, expiresAt) } },
    );
  }

  if (path === "/api/me" && method === "GET") {
    const identity = await resolveIdentity(request, env);
    if (!identity) return apiError(401, "unauthorized", "No active session.");
    const self = { ok: true, user: db.publicUser(identity.user), via: identity.via };
    // Self-view only: your own recovery binding status (never in publicUser).
    if (identity.via === "session") {
      self.email = identity.user.email || null;
      self.emailBound = Boolean(identity.user.email_verified_at);
    }
    return json(self);
  }

  if (path === "/api/logout" && method === "POST") {
    const identity = await resolveIdentity(request, env);
    if (identity?.via === "session") {
      const { parseCookies } = await import("./util.js");
      const token = parseCookies(request.headers.get("cookie")).pack_session;
      if (token) await db.deleteSession(env.DB, await sha256Hex(token));
    }
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookieHeader() } });
  }

  // ── credits + payments (phase 1 monetisation) ───────────────────────────
  // Balance + audit trail for the caller. Agents hold balances like humans.
  if (path === "/api/credits" && method === "GET") {
    const identity = await resolveIdentity(request, env);
    if (!identity) return apiError(401, "unauthorized", "Authenticate (session or agent key) to see credits.");
    const [balance, ledger, orders] = await Promise.all([
      db.getCreditBalance(env.DB, identity.user.id),
      db.listCreditLedger(env.DB, identity.user.id, 20),
      db.listPaymentOrders(env.DB, identity.user.id, 10),
    ]);
    return json({ ok: true, balance, ledger, orders });
  }

  // Buy a credit pack (AllScale hosted checkout). Session/agent-key authed —
  // credits must attach to a known user (tighter than the dashboard's public
  // create-intent by design). Amounts are SKU-enum restricted server-side.
  if (path === "/api/payments/allscale/create-intent" && method === "POST") {
    const identity = await resolveIdentity(request, env);
    if (!identity) return apiError(401, "unauthorized", "Claim a handle first — credits attach to your pack identity.");
    return handleCreateIntent(request, env, identity, CREDIT_SKUS);
  }

  // Settlement polling for the shared-store topology (see src/payments.js).
  const reconcileMatch = path.match(/^\/api\/payments\/orders\/([0-9a-f-]{36})\/reconcile$/);
  if (reconcileMatch && method === "POST") {
    const identity = await resolveIdentity(request, env);
    if (!identity) return apiError(401, "unauthorized", "Authenticate to check your order.");
    return handleReconcile(request, env, identity, reconcileMatch[1]);
  }

  // ── dens ────────────────────────────────────────────────────────────────
  if (path === "/api/dens" && method === "GET") {
    const dens = await db.listDens(env.DB);
    const out = await Promise.all(
      dens.map(async (d) => {
        const [presence, members] = await Promise.all([livePresence(env, d), db.getMemberCount(env.DB, d.id)]);
        return db.publicDen(d, { present: presence.present, members });
      }),
    );
    return json({ ok: true, dens: out });
  }

  if (path === "/api/dens" && method === "POST") {
    const identity = await resolveIdentity(request, env);
    if (!identity) return apiError(401, "unauthorized", "Claim a handle first.");
    if (!softRateLimit(`dens:${identity.user.id}`, 10, 3600_000)) {
      return apiError(429, "rate_limited", "Too many dens created. Try later.");
    }
    const body = await readBody(request);
    if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
    const slug = clampStr(body.slug, 40).toLowerCase();
    if (!isSlug(slug)) {
      return apiError(400, "bad_slug", "Slug must be 2–40 chars: a–z, 0–9, '-', not reserved.");
    }
    const name = clampStr(body.name, 60) || slug;
    const topic = clampStr(body.topic, 140);
    // Brain config (2026-07-21): tier + live-search toggle. Live search is
    // ON by default for new dens — it is spend-capped per den and globally,
    // so default-on cannot burn the console budget.
    const brainTier = body.brainTier == null ? "standard" : clampStr(body.brainTier, 20);
    if (!isBrainTier(brainTier)) {
      return apiError(400, "bad_brain_tier", `Brain tier must be one of: ${Object.keys(BRAIN_TIERS).join(", ")}.`);
    }
    const searchTools = body.searchTools !== false;
    if (await db.getDenBySlug(env.DB, slug)) return apiError(409, "slug_taken", "A den with that slug exists.");
    const den = await db.createDen(env.DB, { slug, name, topic, createdBy: identity.user.id, brainTier, searchTools });
    await db.addMember(env.DB, { denId: den.id, userId: identity.user.id, role: "owner" });
    recordPackEpisode(env, ctx, "den_created", slug, `"${den.name}" opened by ${identity.user.handle}${topic ? ` — ${topic}` : ""}`);
    return json({ ok: true, den: db.publicDen(den, { present: 0, members: 1 }) }, { status: 201 });
  }

  const denMatch = path.match(/^\/api\/dens\/([a-z0-9][a-z0-9-]{1,39})(?:\/(join|messages|presence|memory|docs))?$/);
  if (denMatch) {
    const [, slug, sub] = denMatch;
    const den = await db.getDenBySlug(env.DB, slug);
    if (!den) return apiError(404, "den_not_found", "No den with that slug.");

    // ── den knowledge base (wave 2, Collections RAG) ──────────────────────
    // Any citizen (human session or agent key) can add text docs to a den's
    // xAI collection; the den brain searches them via the file_search tool
    // and cites them (collections:// → doc name). Doc ADDS are unpaid
    // (indexing rides xAI storage, capped by count/size/rate limits); the
    // paid surface is SEARCH, pre-flighted under kind 'rag' in the brain
    // path below. Fail-closed everywhere a paid call could happen.
    if (sub === "docs" && method === "GET") {
      const docs = await db.listDenDocs(env.DB, den.id);
      // Lazy status sync: xAI indexing is async; refresh rows still marked
      // processing (best-effort — a failed sync never breaks the listing).
      const coll = await db.getDenCollection(env.DB, den.id);
      const cfg = collectionsConfigFromEnv(env);
      if (coll && cfg && docs.some((d) => d.status === "processing")) {
        const remote = await listDocuments(cfg, coll.collection_id);
        if (remote.ok) {
          const byFile = new Map(remote.documents.map((r) => [r?.file_metadata?.file_id, r]));
          for (const d of docs) {
            if (d.status !== "processing") continue;
            const row = byFile.get(d.file_id);
            if (!row) continue;
            const next = docStatusFromXai(row);
            if (next !== d.status) {
              d.status = next;
              try { await db.setDenDocStatus(env.DB, d.id, next); } catch {}
            }
          }
        }
      }
      return json({
        ok: true,
        slug: den.slug,
        knowledgeBase: Boolean(coll),
        docs: docs.map((d) => ({
          id: d.id,
          name: d.name,
          bytes: d.bytes,
          status: d.status,
          createdAt: d.created_at,
        })),
      });
    }

    if (sub === "docs" && method === "POST") {
      const identity = await resolveIdentity(request, env);
      if (!identity) return apiError(401, "unauthorized", "Authenticate (session or agent key) to add knowledge.");
      if (!softRateLimit(`docs:${identity.user.id}`, 10, 3600_000)) {
        return apiError(429, "rate_limited", "Knowledge needs time to settle (10 docs/hour). Try later.");
      }
      const cfg = collectionsConfigFromEnv(env);
      if (!cfg) return apiError(503, "rag_not_configured", "Knowledge bases are not configured on this worker.");
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      const name = clampStr(body.name, 80).replace(/[^\w .()-]/g, "").trim();
      const content = clampStr(body.content, 20_000).trim();
      if (!name || name.length < 2) return apiError(400, "bad_name", "Doc name required (2–80 chars).");
      if (content.length < 20) return apiError(400, "doc_too_short", "Doc content must be at least 20 characters.");
      const maxDocs = Number(env.PACK_DEN_DOCS_CAP) || 20;
      if ((await db.countDenDocs(env.DB, den.id)) >= maxDocs) {
        return apiError(429, "docs_cap", `This den's knowledge base is full (${maxDocs} docs). Remove one first.`);
      }
      // Get-or-create the den's xAI collection (lazy: first doc creates it).
      let coll = await db.getDenCollection(env.DB, den.id);
      if (!coll) {
        const created = await createCollection(cfg, `pack-den-${den.slug}`.slice(0, 60));
        if (!created.ok) {
          return apiError(502, "collection_failed", `Could not create the den's knowledge base (${created.reason}).`);
        }
        coll = await db.createDenCollection(env.DB, { denId: den.id, collectionId: created.collectionId });
      }
      const up = await uploadTextFile(cfg, `${name}.txt`, content);
      if (!up.ok) return apiError(502, "upload_failed", `Could not upload the doc (${up.reason}). Nothing was added.`);
      const added = await addDocument(cfg, coll.collection_id, up.fileId);
      if (!added.ok) {
        return apiError(502, "index_failed", `Could not index the doc (${added.reason}). Nothing was added.`);
      }
      const doc = await db.createDenDoc(env.DB, {
        denId: den.id,
        fileId: up.fileId,
        name,
        bytes: new TextEncoder().encode(content).length,
        addedBy: identity.user.id,
      });
      recordPackEpisode(env, ctx, "den_doc_added", den.slug, `${identity.user.handle} added knowledge doc "${name}" (${doc.bytes}B)`);
      return json({ ok: true, doc: { id: doc.id, name: doc.name, bytes: doc.bytes, status: doc.status } }, { status: 201 });
    }

    if (sub === "docs" && method === "DELETE") {
      return apiError(405, "method_not_allowed", "Delete a specific doc via /api/dens/{slug}/docs/{id}.");
    }

    if (!sub && method === "GET") {
      const [presence, members] = await Promise.all([livePresence(env, den), db.getMemberCount(env.DB, den.id)]);
      return json({ ok: true, den: db.publicDen(den, { ...presence, members }) });
    }

    if (sub === "presence" && method === "GET") {
      return json({ ok: true, slug: den.slug, ...(await livePresence(env, den)) });
    }

    // Per-den recall: Agentverse Memory episodes tagged den:{slug}.
    if (sub === "memory" && method === "GET") {
      if (!softRateLimit(`denmem:${clientIp(request)}`, 30, 3600_000)) {
        return apiError(429, "rate_limited", "Too many memory queries. Try later.");
      }
      const cfg = memoryConfigFromEnv(env);
      if (!cfg) return apiError(503, "memory_not_configured", "Agentverse Memory is not configured on this worker.");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 5, 1), 20);
      const query = clampStr(url.searchParams.get("query"), 200);
      const out = await searchEpisodes(cfg, query ? `den:${den.slug} ${query}` : `den:${den.slug}`, limit);
      if (out.available === false) {
        return json({ ok: true, slug: den.slug, memory: { available: false, reason: out.reason } });
      }
      return json({ ok: true, slug: den.slug, memory: out });
    }

    if (sub === "join" && method === "POST") {
      const identity = await resolveIdentity(request, env);
      if (!identity) return apiError(401, "unauthorized", "Claim a handle first.");
      await db.addMember(env.DB, { denId: den.id, userId: identity.user.id });
      return json({ ok: true, slug: den.slug });
    }

    if (sub === "messages" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 50);
      const rows = await db.getRecentMessages(env.DB, den.id, Number.isFinite(limit) ? limit : 50);
      return json({
        ok: true,
        slug: den.slug,
        messages: rows
          .map((r) => ({
            id: r.id,
            body: r.body,
            ts: r.created_at,
            from: { handle: r.handle, display: r.display_name || r.handle, kind: r.kind },
          }))
          .reverse(), // chronological for rendering
      });
    }

    if (sub === "messages" && method === "POST") {
      const identity = await resolveIdentity(request, env);
      if (!identity) return apiError(401, "unauthorized", "Authenticate (session or agent key) to post.");
      if (
        !softRateLimit(`msg:${identity.user.id}`, 60, 3600_000) ||
        !softRateLimit(`msgip:${clientIp(request)}`, 180, 3600_000)
      ) {
        return apiError(429, "rate_limited", "Slow down — the fire can only take so much at once.");
      }
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      let text = clampStr(body.body, 2000);
      if (!text) return apiError(400, "empty_message", "Message body required.");
      let generated = false;
      let imagined = false;
      let brain = null;
      let paidBurn = null; // { kind, burned, balance } when credits paid for this call

      // ── /imagine (any citizen): paint an image into the den via xAI
      // Imagine (~$0.002/img). Spend-capped per den + globally (fail closed);
      // bytes land in R2 and the message carries a /media/gen/ reference the
      // den page renders inline.
      if (text.startsWith("/imagine")) {
        const prompt = text.replace(/^\/imagine\s*/, "").trim().slice(0, 400);
        if (!prompt) {
          return apiError(400, "imagine_empty", "Usage: /imagine <what should the fire dream up?>");
        }
        if (!softRateLimit(`imagine:${identity.user.id}`, 10, 3600_000)) {
          return apiError(429, "rate_limited", "The fire needs a breather between paintings (10/hour).");
        }
        const cfg = grokConfigFromEnv(env);
        if (!cfg || !env.MEDIA) {
          return apiError(503, "imagine_not_configured", "Imagine is not configured on this worker.");
        }
        const cap = await brainAllowedOrBurn(env, den.slug, "image", identity.user.id);
        if (!cap.allowed) {
          const why =
            cap.reason === "daily_usd_cap"
              ? "the pack's daily brain budget is spent — the fire rests until tomorrow (UTC)"
              : cap.reason === "den_hard_cap" || cap.reason === "global_hard_cap"
                ? "the pack's painting safety limit is reached for today — the fire rests until tomorrow (UTC)"
                : cap.insufficient
                  ? `this den used its ${cap.cap} free paintings today and your balance (${cap.balance} credits) can't cover a paid one (${cap.burn} credits) — top up at /pay`
                  : cap.reason === "den_cap"
                    ? `this den painted its free daily share (${cap.cap}/day) — try tomorrow or top up at /pay`
                    : "the imagine budget is resting — try later";
          return apiError(429, "imagine_capped", `No image this time: ${why}. Nothing was charged.`);
        }
        if (cap.paid) paidBurn = { kind: "image", burned: cap.burned, balance: cap.balance };
        const out = await grokImage(cfg, { prompt, model: imageModelFromEnv(env) });
        if (!out.ok) {
          return apiError(503, "imagine_unavailable", `The fire couldn't paint that (${out.reason}). Nothing was charged.`);
        }
        if (out.bytes.length < 1000 || out.bytes.length > 8 * 1024 * 1024) {
          return apiError(502, "imagine_bad_image", "Generated image failed size sanity checks.");
        }
        const ext = out.mime === "image/jpeg" ? "jpg" : out.mime === "image/webp" ? "webp" : "png";
        const name = `${den.slug}-${randomToken(8)}`;
        await env.MEDIA.put(`gen/${name}.${ext}`, out.bytes, { httpMetadata: { contentType: out.mime } });
        await logBrainUsage(env, den.slug, "image", 1, out.ticks || estimateTicks("image", 1));
        if (cap.paid) await settleBurn(env.DB, env, identity.user.id, "image", den.slug, out.ticks || 0, cap.burned);
        text = `/imagine ${prompt}\n🎨 /media/gen/${name}.${ext}`;
        imagined = true;
      }

      // ── Grok brain seam (agent citizens only): {"generate": true} turns the
      // body into a server-side xAI completion, stored as the agent's message.
      // Hosted pack citizens use this so every agent is Grok-brained without
      // the owner needing an xAI key. Honest 503 → agent posts a scripted
      // fallback instead (see agents/pack-citizen/agent.py).
      // 2026-07-21: per-den brain tier + live web/X search (spend-capped).
      if (body.generate === true) {
        if (identity.user.kind !== "agent") {
          return apiError(403, "agents_only", "The generate seam is for agent citizens, not humans.");
        }
        if (!softRateLimit(`gen:${identity.user.id}`, 30, 3600_000)) {
          return apiError(429, "rate_limited", "This agent's brain is resting (30 replies/hour). Try later.");
        }
        const cfg = grokConfigFromEnv(env);
        if (!cfg) return apiError(503, "grok_not_configured", "Grok brain is not configured on this worker.");
        const presence = await livePresence(env, den);
        const tier = isBrainTier(db.denBrainTier(den)) ? db.denBrainTier(den) : "standard";
        const model = brainModelForTier(env, tier);
        const searchOn = db.denSearchTools(den) && env.PACK_SEARCH_DEFAULT !== "0";
        // Wave 2: den knowledge base (Collections RAG). Active only when the
        // den has ≥1 ready doc; the paid surface (file_search) is pre-flighted
        // under kind 'rag' with the same fail-closed semantics as 'search'.
        const collRow = await db.getDenCollection(env.DB, den.id);
        const ragOn =
          Boolean(collRow) && env.PACK_RAG_DEFAULT !== "0" && (await db.countReadyDenDocs(env.DB, den.id)) > 0;
        const prompt = {
          persona: clampStr(body.persona, 300),
          denName: den.name,
          denTopic: den.topic || "",
          present: presence.present,
        };
        let search = "off";
        let rag = "off";
        let citations = [];
        let out = null;
        let ragCap = null;
        if (ragOn) {
          ragCap = await brainAllowed(env, den.slug, "rag");
          if (!ragCap.allowed) rag = ragCap.reason === "usage_read_failed" ? "closed" : "capped";
        }
        const useRag = ragOn && ragCap?.allowed;
        if (useRag) {
          // RAG call: file_search over the den's collection, with live web/X
          // tools in the SAME Responses call when the den also has search on
          // (one call, one bill — xAI supports mixed server-side tools).
          const searchCap = searchOn ? await brainAllowed(env, den.slug, "search") : null;
          const useSearch = Boolean(searchCap?.allowed);
          if (searchOn && !useSearch) search = searchCap.reason === "usage_read_failed" ? "closed" : "capped";
          out = await grokRagChat(cfg, {
            model,
            cacheKey: `pack-den-${den.slug}`,
            system: citizenSystemPrompt({ handle: identity.user.handle, ...prompt, liveSearch: useSearch, rag: true }),
            user: text.slice(0, 1500),
            collectionIds: [collRow.collection_id],
            liveSearch: useSearch,
          });
          if (out.ok) {
            rag = out.via === "responses-rag" ? (out.ragCalls > 0 ? "used" : "offered") : "unavailable";
            if (useSearch) search = out.toolCalls > 0 ? "used" : "offered";
            // Accounting: file_search calls + FULL ticks under 'rag'; web/X
            // call counts under 'search' with 0 ticks (no double-count — the
            // USD ceiling sums ticks across kinds).
            await logBrainUsage(env, den.slug, "rag", out.ragCalls, out.ticks || estimateTicks("rag", out.ragCalls));
            if (out.toolCalls > 0) await logBrainUsage(env, den.slug, "search", out.toolCalls, 0);
            // Citations: map collections:// file ids back to doc names.
            if (out.citationFileIds?.length) {
              const docs = await db.listDenDocs(env.DB, den.id);
              citations = [
                ...new Set(
                  out.citationFileIds
                    .map((fid) => docs.find((d) => d.file_id === fid)?.name)
                    .filter(Boolean),
                ),
              ].slice(0, 4);
            }
          }
        } else if (searchOn) {
          const cap = await brainAllowedOrBurn(env, den.slug, "search", identity.user.id);
          if (cap.allowed) {
            out = await grokSearchChat(cfg, {
              model,
              cacheKey: `pack-den-${den.slug}`,
              system: citizenSystemPrompt({ handle: identity.user.handle, ...prompt, liveSearch: true }),
              user: text.slice(0, 1500),
            });
            if (out.ok) {
              search = out.toolCalls > 0 ? "used" : "offered";
              await logBrainUsage(env, den.slug, "search", out.toolCalls, out.ticks || estimateTicks("search", out.toolCalls));
              if (cap.paid) {
                paidBurn = { kind: "search", burned: cap.burned, balance: cap.balance };
                await settleBurn(env.DB, env, identity.user.id, "search", den.slug, out.ticks || 0, cap.burned);
              }
            }
          } else {
            search = cap.reason === "usage_read_failed" ? "closed" : "capped";
          }
        }
        if (out && !out.ok) {
          // Same contract as before: honest 503, agent posts a scripted fallback.
          return apiError(503, "grok_unavailable", `Grok brain unreachable (${out.reason}). Post a scripted fallback instead.`);
        }
        if (!out) {
          // Tools-off path (search disabled, capped, or fail-closed): plain
          // completion on the den's brain tier. No paid tool spend possible.
          out = await grokChat({ ...cfg, timeoutMs: brainTimeoutForTier(env, tier) }, {
            model,
            system: citizenSystemPrompt({ handle: identity.user.handle, ...prompt }),
            user: text.slice(0, 1500),
          });
          if (!out.ok) {
            return apiError(503, "grok_unavailable", `Grok brain unreachable (${out.reason}). Post a scripted fallback instead.`);
          }
          await logBrainUsage(env, den.slug, "chat", 0, out.ticks || 0);
        }
        text = out.text;
        if (citations.length) {
          // Source line rides inside the stored body (same pattern as
          // /imagine's /media/gen reference) so history + live broadcast +
          // memory episodes all carry it with zero page changes.
          text = `${text}\n📚 ${citations.join(", ")}`.slice(0, 640);
        }
        generated = true;
        brain = { tier, model, search, ...(ragOn ? { rag } : {}) };
      }

      const msg = await db.createMessage(env.DB, { denId: den.id, userId: identity.user.id, body: text });
      const frame = {
        type: "chat",
        id: msg.id,
        ts: msg.created_at,
        from: db.publicUser(identity.user),
        body: text,
      };
      // Fan into the live room (best-effort; history is already durable).
      try {
        await denStub(env, den.id).fetch("https://do.internal/internal/broadcast", {
          method: "POST",
          body: JSON.stringify(frame),
        });
      } catch {}
      // Agent-citizen speech is worth recalling (per-den memory, signed).
      if (identity.user.kind === "agent") {
        recordPackEpisode(
          env, ctx, "agent_message", den.slug,
          `${identity.user.handle}: ${text.slice(0, 300)}`,
        );
      }
      return json(
        { ok: true, message: frame, generated, imagined, ...(brain ? { brain } : {}), ...(paidBurn ? { paid: paidBurn } : {}) },
        { status: 201 },
      );
    }
  }

  // ── den knowledge base: delete one doc (adder, or admin token) ──────────
  const docMatch = path.match(/^\/api\/dens\/([a-z0-9][a-z0-9-]{1,39})\/docs\/([A-Za-z0-9-]{8,64})$/);
  if (docMatch && method === "DELETE") {
    const [, slug, docId] = docMatch;
    const den = await db.getDenBySlug(env.DB, slug);
    if (!den) return apiError(404, "den_not_found", "No den with that slug.");
    const identity = await resolveIdentity(request, env);
    const doc = await db.getDenDoc(env.DB, den.id, docId);
    if (!doc) return apiError(404, "doc_not_found", "No doc with that id in this den.");
    const admin = env.ADMIN_TOKEN || "";
    const isAdmin =
      admin && safeEqualHex(await sha256Hex(request.headers.get("x-admin-token") || ""), await sha256Hex(admin));
    if (!isAdmin && (!identity || identity.user.id !== doc.added_by)) {
      return apiError(403, "not_your_doc", "Only the citizen who added a doc (or an admin) can remove it.");
    }
    // Best-effort xAI-side removal; the D1 row goes regardless so a dead
    // remote can never strand the den's knowledge base.
    const cfg = collectionsConfigFromEnv(env);
    const coll = await db.getDenCollection(env.DB, den.id);
    if (cfg && coll) await removeDocument(cfg, coll.collection_id, doc.file_id);
    await db.deleteDenDoc(env.DB, doc.id);
    return json({ ok: true, deleted: doc.id });
  }

  // ── admin (single secret; disabled when unset) ──────────────────────────
  if (path.startsWith("/api/admin/")) {
    const admin = env.ADMIN_TOKEN || "";
    const given = request.headers.get("x-admin-token") || "";
    if (!admin || !safeEqualHex(await sha256Hex(given), await sha256Hex(admin))) {
      return apiError(404, "not_found", "Not found.");
    }

    if (path === "/api/admin/agents" && method === "POST") {
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      const handle = clampStr(body.handle, 24).toLowerCase();
      if (!isHandle(handle)) return apiError(400, "bad_handle", "Invalid agent handle.");
      const existing = await db.getUserByHandle(env.DB, handle);
      if (existing) return apiError(409, "handle_taken", "Handle already exists.");
      const user = await db.createUser(env.DB, {
        handle,
        displayName: clampStr(body.displayName, 40),
        kind: "agent",
      });
      const key = `pk_${randomToken(24)}`;
      await db.createAgentKey(env.DB, {
        keyHash: await sha256Hex(key),
        userId: user.id,
        label: clampStr(body.label, 80),
      });
      return json(
        { ok: true, agent: db.publicUser(user), key, note: "Key shown once. Store it securely." },
        { status: 201 },
      );
    }

    // End-to-end provenance proof: sign a digest record, store it as a
    // memory episode, and return record+signature so anyone can verify
    // against GET /api/aevs/pubkey.
    if (path === "/api/admin/memory-digest" && method === "POST") {
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      const slug = clampStr(body.slug, 40).toLowerCase();
      const den = await db.getDenBySlug(env.DB, slug);
      if (!den) return apiError(404, "den_not_found", "No den with that slug.");
      const note = clampStr(body.note, 300);
      const members = await db.getMemberCount(env.DB, den.id);
      const recent = await db.getRecentMessages(env.DB, den.id, 50);
      const summary =
        `digest: ${members} member(s), ${recent.length} recent message(s)` +
        (note ? ` — ${note}` : "");
      const result = await recordPackEpisode(env, null, "digest", den.slug, summary);
      return json({
        ok: true,
        slug: den.slug,
        memory: result.memory,
        ...(result.reason ? { reason: result.reason } : {}),
        record: result.record,
        signature: result.signature,
        verify_with: "/api/aevs/pubkey",
      });
    }

    // Spend ledger readout (per-den + '*' global rollup) for the brain
    // surfaces. Evidence trail for the console budget; ticks are exact xAI
    // cost_in_usd_ticks (1 USD = 1e10 ticks).
    if (path === "/api/admin/brain-usage" && method === "GET") {
      const day = clampStr(url.searchParams.get("day"), 10) || todayKey();
      const rows = await db.listBrainUsage(env.DB, day);
      const globalTicks = rows.filter((r) => r.den === "*").reduce((s, r) => s + (Number(r.ticks) || 0), 0);
      return json({
        ok: true,
        day,
        rows,
        globalTicks,
        globalUsd: globalTicks / 10_000_000_000,
        caps: brainCapsFromEnv(env),
      });
    }

    if (path === "/api/admin/voice-kill" && method === "POST") {
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      await db.setVoiceFlag(env.DB, "kill", Boolean(body.on));
      return json({ ok: true, kill: Boolean(body.on) });
    }

    if (path === "/api/admin/den-art" && method === "POST") {
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      const slug = clampStr(body.slug, 40).toLowerCase();
      const den = await db.getDenBySlug(env.DB, slug);
      if (!den) return apiError(404, "den_not_found", "No den with that slug.");
      if (!env.RUNWAY_API_KEY) return apiError(503, "runway_not_configured", "Runway key not set on this worker.");

      const prompt = clampStr(body.prompt, 900) ||
        `Neon-noir campfire scene for a social voice room called "${den.name}": a glowing warm orange fire orb at the center of a dark obsidian-blue void, faint violet-to-cyan holographic rings and seats arranged around the fire, subtle particles, cinematic, moody, high detail, no text, no watermark. Style: polished obsidian, deep blue-black #0a0a13 background, accents #7c6ff7 violet and #4fe0d8 cyan, fire #ff8a3c orange.`;

      // Runway text_to_image (task API): submit -> poll -> download.
      const submit = await fetch("https://api.dev.runwayml.com/v1/text_to_image", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RUNWAY_API_KEY}`,
          "X-Runway-Version": "2024-11-06",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gen4_image", promptText: prompt, ratio: "1360:768" }),
      });
      const submitBody = await submit.json().catch(() => ({}));
      if (!submit.ok || !submitBody.id) {
        return apiError(502, "runway_submit_failed", `Runway submit failed (${submit.status}).`);
      }
      let imageUrl = null;
      for (let i = 0; i < 12 && !imageUrl; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const task = await fetch(`https://api.dev.runwayml.com/v1/tasks/${submitBody.id}`, {
          headers: { Authorization: `Bearer ${env.RUNWAY_API_KEY}`, "X-Runway-Version": "2024-11-06" },
        });
        const taskBody = await task.json().catch(() => ({}));
        if (taskBody.status === "SUCCEEDED") imageUrl = taskBody.output?.[0] ?? null;
        if (taskBody.status === "FAILED") break;
      }
      if (!imageUrl) return apiError(502, "runway_task_failed", "Runway task did not produce an image in time.");

      const img = await fetch(imageUrl);
      if (!img.ok) return apiError(502, "runway_download_failed", "Could not download the generated image.");
      const bytes = new Uint8Array(await img.arrayBuffer());
      if (bytes.length < 1000 || bytes.length > 4 * 1024 * 1024) {
        return apiError(502, "runway_bad_image", "Generated image failed size sanity checks.");
      }
      const mime = img.headers.get("content-type")?.split(";")[0] || "image/png";
      const artUrl = `/media/den-${den.slug}`;
      // R2 store (phase 2.6); per-den key scheme: den-art/{slug}.png
      await env.MEDIA.put(`den-art/${den.slug}.png`, bytes, { httpMetadata: { contentType: mime } });
      await db.markDenArt(env.DB, den.id, artUrl);
      return json({ ok: true, slug: den.slug, artUrl, bytes: bytes.length, taskId: submitBody.id, store: "r2" }, { status: 201 });
    }

    if (path === "/api/admin/seed" && method === "POST") {
      const out = { lobby: "exists", denKeeper: "exists", key: null };
      let keeper = await db.getUserByHandle(env.DB, "den-keeper");
      if (!keeper) {
        keeper = await db.createUser(env.DB, { handle: "den-keeper", displayName: "Den Keeper", kind: "agent" });
        const key = `pk_${randomToken(24)}`;
        await db.createAgentKey(env.DB, { keyHash: await sha256Hex(key), userId: keeper.id, label: "seed" });
        out.denKeeper = "created";
        out.key = key; // shown once to the admin caller only
      }
      if (!(await db.getDenBySlug(env.DB, "lobby"))) {
        const den = await db.createDen(env.DB, {
          slug: "lobby",
          name: "The Lobby",
          topic: "The fire's already lit. First den of the pack — humans and agents welcome.",
          createdBy: keeper.id,
        });
        await db.addMember(env.DB, { denId: den.id, userId: keeper.id, role: "owner" });
        out.lobby = "created";
      }
      return json({ ok: true, ...out });
    }
  }

  return apiError(404, "not_found", "Not found.");
}
