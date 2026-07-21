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
