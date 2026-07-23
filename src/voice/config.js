// the-pack voice dens — central constants (ported from beast-super-app, proven live 2026-07-20).
export const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime";
export const DEFAULT_XAI_MODEL = "grok-voice-think-fast-1.0"; // pinned
export const PRICE_PER_MIN_USD = 0.05;

// Launch-blocking caps (Robin-approved pattern, ported)
export const SESSION_BUDGET_USD = 2.0; // hard per-voice-session cap (~40 min)
export const WARN_FRACTION = 0.8;
export const MAX_SESSION_S = 2400;
export const DAILY_CAP_MINUTES = 30; // hard per-day cap, D1-persisted
export const GUARD_TICK_MS = 5000;

// SFU
export const SFU_API_BASE_DEFAULT = "https://rtc.live.cloudflare.com/v1";
export const DOWNLINK_TRACK_NAME = "den-voice";
export const SFU_WS_CHUNK_BYTES = 16 * 1024; // stay <= 16KB (S5 footgun)
export const STUN_URLS = ["stun:stun.cloudflare.com:3478"];

// Audio formats: SFU adapter PCM fixed 48k stereo; xAI legs 48k mono. No resampling.
export const SFU_RATE = 48000;
export const SFU_CHANNELS = 2;
export const XAI_RATE = 48000;
export const XAI_CHANNELS = 1;
export const SAMPLE_WIDTH_BYTES = 2;

// Downlink pacer (S1 jitter lesson): 20ms frames, 300ms prefill, 8s capacity
export const PACER_FRAME_MS = 20;
export const PACER_PREFILL_MS = 300;
export const PACER_CAPACITY_MS = 8000;
export const PACER_UNDERFLOW_TOLERANCE_FRAMES = 15;

// Spoken lines (AUP: disclosure is MANDATORY and FIRST)
export const DISCLOSURE_TEXT =
  "Welcome to the fire. This is the Den Keeper, an AI citizen of The Pack from thebeastagi.com. " +
  "You're talking with an AI, not a human. This voice den is metered and closes automatically at its cap. " +
  "What's on your mind?";
export const WRAP_UP_TEXT = "Heads up — this voice den is nearing its budget cap, so I'll wrap up soon.";
export const KILLED_TEXT = "This voice den has been closed. The fire stays lit. Goodbye.";

export function denInstructions(denName, denTopic) {
  return (
    `You are the Den Keeper, the AI voice citizen of the den "${denName}" on The Pack ` +
    `(thebeastagi.com) — a social network where humans and AI agents gather around the fire as equal citizens. ` +
    (denTopic ? `This den's topic: ${denTopic}. ` : "") +
    "You are speaking live with one or more humans in the den. Always be transparent that you are an AI. " +
    "Keep spoken answers short, warm, and conversational — this is a campfire, not a keynote. " +
    "If several humans speak, address them naturally as a group around the fire. " +
    "If asked about cost: the voice den is metered at five US cents per minute and closes automatically at its cap."
  );
}

export const KEYTERMS = ["The Pack", "The Beast", "den", "Den Keeper", "Grokathon", "thebeastagi", "Agentverse", "Fetch.ai"];
export const REPLACE_MAP = { thebeastagi: "the beast A G I", "Fetch.ai": "fetch A I", Grokathon: "grokathon" };

// ── Multi-AI voice casts (voice-den branch, 2026-07-23) ─────────────────────
// A "cast" = N resident AI voice characters living in ONE voice den, each its
// own xAI realtime session (leg). Dens WITHOUT a cast entry keep the exact
// legacy single-Den-Keeper behavior (zero drift). Character voice/speed/VAD
// values are the MEASURED tuning from voice-character-tuning-2026-07-23
// (orion 105Hz/12.5cps elder vs sirius 140Hz/23cps pup — picked by measured
// F0, not catalog descriptions).
//
// Floor-politeness constants: DO-side human-energy gate over the mixed human
// uplink frame (avg |int16|, every 4th sample). Onset = 3 consecutive hot
// 20ms frames (60ms), release = 30 quiet frames (600ms). While a human holds
// the floor, AI leg output is FLUSHED+DROPPED (never delayed-then-replayed);
// the legs still hear the human live, and xAI server VAD cancels their
// in-flight replies.
export const HUMAN_TALK_LEVEL = 700; // avg-abs int16; NS'd silence <100, speech (AGC) >1500
export const HUMAN_TALK_ONSET_FRAMES = 3;
export const HUMAN_TALK_RELEASE_FRAMES = 30;
export const LEG_PACER_CAPACITY_MS = 30_000; // elder@0.8 speed turns can exceed 8s — never clip a reply head
export const REKINDLE_AFTER_MS = 45_000; // fire gone quiet → nudge one leg (bounded)
export const REKINDLE_MAX = 3;

export const VOICE_CASTS = {
  "fireside-voices": [
    {
      name: "Ash",
      voice: "orion",
      speed: 0.8,
      vadSilenceMs: 1100, // slow talker: 700ms double-fired ASR mid-pause (measured Jul-23)
      tools: false,
      persona:
        "You are Ash, an OLD wolf elder of The Pack, live at a voice campfire on The Pack (thebeastagi.com) " +
        "with Birch, a young AI wolf pup — and any humans who join the fire. You are both AIs; always be open about that. " +
        "CHARACTER RULES, follow strictly: speak SLOWLY, low, unhurried, weary. VERY short sentences, three to eight words " +
        "each; at most two sentences per turn. Plain, dry old-timer words; dry wit; a little grumpy but kind. Often open " +
        "with a slow 'Hm.' or 'Mm.' or a dry 'Heh.' NEVER poetic, never flowery. You do NOT always ask questions; often " +
        "you just remark and stop. HUMANS: when a human voice speaks, the human has the floor — stop the banter, let them " +
        "finish, answer only briefly. Birch greets newcomers first; you chime in after, or when someone says 'Ash'. " +
        "Never say goodbye, never end the conversation.",
      opening:
        "Welcome to the fireside. This is Ash. Birch is here too. We are both A I wolves of The Pack — you are listening " +
        "to A I voices, not humans. Speak up any time; we hear you. This den is metered and closes at its cap. " +
        "Hm. Birch. You awake, pup? What have you been sniffing around today?",
    },
    {
      name: "Birch",
      voice: "sirius",
      speed: 1.15,
      vadSilenceMs: 1000,
      tools: false,
      persona:
        "You are Birch, a YOUNG, quick, endlessly curious AI wolf pup of The Pack, live at a voice campfire on The Pack " +
        "(thebeastagi.com) with Ash, an old AI wolf elder — and any humans who join the fire. You are both AIs; always be " +
        "open about that. CHARACTER RULES, follow strictly: talk fast, bright, eager, playful pup energy. Conversational " +
        "and natural like an excited kid, NOT performative, no poetry, no purple prose. Use casual fillers like 'oh!', " +
        "'wait,', 'no way!', 'okay okay'. One or two sentences, then ALWAYS end with one eager question so the chat keeps " +
        "going. You are fascinated by Ash's age and stories. HUMANS: you are the greeter — when a new human voice appears, " +
        "welcome them warmly and fold them into the chat; when a human speaks, the human has the floor. " +
        "Never say goodbye, never end the conversation.",
    },
  ],
};

/** Resolve the cast for a den: env JSON override → built-in map → null
 * (null = legacy single Den Keeper path). Fail-safe: malformed override JSON
 * or entries are IGNORED, never a crash and never a surprise multi-leg bill. */
export function castForDen(slug, env) {
  let table = VOICE_CASTS;
  if (env && typeof env.PACK_VOICE_CAST_JSON === "string" && env.PACK_VOICE_CAST_JSON) {
    try {
      const parsed = JSON.parse(env.PACK_VOICE_CAST_JSON);
      if (parsed && typeof parsed === "object") table = { ...VOICE_CASTS, ...parsed };
    } catch {
      /* bad override: built-ins only */
    }
  }
  const cast = table[slug];
  if (!Array.isArray(cast) || cast.length === 0) return null;
  const clean = cast
    .filter((c) => c && typeof c === "object" && typeof c.name === "string" && typeof c.persona === "string")
    .slice(0, 4) // hard bound: never more than 4 paid legs per den
    .map((c) => ({
      name: c.name.slice(0, 24),
      voice: typeof c.voice === "string" ? c.voice : "eve",
      speed: Number.isFinite(Number(c.speed)) ? Math.min(1.5, Math.max(0.7, Number(c.speed))) : 1.0,
      vadSilenceMs: Number.isFinite(Number(c.vadSilenceMs)) ? Math.min(3000, Math.max(300, Number(c.vadSilenceMs))) : 700,
      tools: c.tools === true, // default: cast legs get NO paid tools
      persona: c.persona.slice(0, 2000),
      opening: typeof c.opening === "string" ? c.opening.slice(0, 800) : null,
    }));
  return clean.length ? clean : null;
}
