// the-pack voice — xAI Realtime protocol: event builders, parser, error
// classification (port from beast-super-app; pure functions, no secrets).
import { KEYTERMS, REPLACE_MAP, XAI_CHANNELS, XAI_RATE, denInstructions } from "./config.js";

export function defaultSessionConfig(denName, denTopic) {
  return {
    voice: "eve",
    instructions: denInstructions(denName, denTopic),
    vad: true,
    vadThreshold: 0.85,
    vadSilenceMs: 700,
    vadPrefixPaddingMs: 333,
    inputRate: XAI_RATE,
    outputRate: XAI_RATE,
    reasoningEffort: "high",
    keyterms: KEYTERMS,
    replace: REPLACE_MAP,
    resumption: true,
    idleTimeoutMs: 1_800_000,
  };
}

export function buildSessionUpdate(cfg) {
  const session = {
    voice: cfg.voice,
    instructions: cfg.instructions,
    turn_detection: cfg.vad
      ? {
          type: "server_vad",
          threshold: cfg.vadThreshold,
          silence_duration_ms: cfg.vadSilenceMs,
          prefix_padding_ms: cfg.vadPrefixPaddingMs,
        }
      : null,
    audio: {
      input: { format: { type: "audio/pcm", rate: cfg.inputRate, channels: XAI_CHANNELS } },
      output: { format: { type: "audio/pcm", rate: cfg.outputRate, channels: XAI_CHANNELS } },
      transport: "binary",
    },
  };
  if (cfg.reasoningEffort) session.reasoning = { effort: cfg.reasoningEffort };
  if (cfg.tools) session.tools = cfg.tools;
  if (cfg.keyterms?.length) session.keyterms = cfg.keyterms;
  if (cfg.replace) session.replace = cfg.replace;
  if (cfg.resumption) session.resumption = { enabled: true };
  if (cfg.idleTimeoutMs) session.idle_timeout_ms = cfg.idleTimeoutMs;
  return { type: "session.update", session };
}

/** xAI extension: verbatim TTS line WITHOUT the model. interruptible:false
 * drops caller audio until playback completes — the disclosure mechanism. */
export function buildForceMessage(text, interruptible) {
  return {
    type: "conversation.item.create",
    item: {
      type: "force_message",
      role: "assistant",
      interruptible,
      content: [{ type: "output_text", text }],
    },
  };
}

export function buildResponseCreate() {
  return { type: "response.create" };
}

export function parseEvent(raw) {
  const evt = JSON.parse(raw);
  if (typeof evt.type !== "string") throw new Error("server event missing 'type'");
  return evt;
}

export const ErrorKind = { NONE: "none", BILLING: "billing", AUTH: "auth", RATE_LIMIT: "rate_limit", OTHER: "other" };
export const TERMINAL_ERROR_KINDS = new Set([ErrorKind.BILLING, ErrorKind.AUTH]);

const BILLING_WORDS = ["billing", "credit", "balance", "insufficient", "quota", "payment", "paywall", "spending limit", "invoice"];
const AUTH_WORDS = ["unauthorized", "forbidden", "invalid api key", "invalid key", "authentication", "401", "403", "permission denied"];

export function classifyError(evt) {
  if (typeof evt !== "object" || evt === null) return ErrorKind.OTHER;
  const err = typeof evt.error === "object" && evt.error !== null ? evt.error : evt;
  const hay = ["type", "code", "message", "param"].map((k) => String(err[k] ?? "")).join(" ").toLowerCase();
  if (!hay.trim()) return ErrorKind.OTHER;
  if (BILLING_WORDS.some((w) => hay.includes(w))) return ErrorKind.BILLING;
  if (AUTH_WORDS.some((w) => hay.includes(w))) return ErrorKind.AUTH;
  if (hay.includes("rate") && hay.includes("limit")) return ErrorKind.RATE_LIMIT;
  return ErrorKind.OTHER;
}

export function isErrorEvent(evt) {
  return evt.type === "error";
}

export function extractTranscript(evt) {
  if (evt.type === "conversation.item.input_audio_transcription.completed" && typeof evt.transcript === "string") {
    return { role: "user", text: evt.transcript, final: true };
  }
  if (evt.type === "conversation.item.input_audio_transcription.delta" && typeof evt.delta === "string") {
    return { role: "user", text: evt.delta, final: false };
  }
  if ((evt.type === "response.output_audio_transcript.delta" || evt.type === "response.audio_transcript.delta") && typeof evt.delta === "string") {
    return { role: "assistant", text: evt.delta, final: false };
  }
  if ((evt.type === "response.output_audio_transcript.done" || evt.type === "response.audio_transcript.done") && typeof evt.transcript === "string") {
    return { role: "assistant", text: evt.transcript, final: true };
  }
  return null;
}

export function isSpeechStarted(evt) {
  return evt.type === "input_audio_buffer.speech_started";
}
