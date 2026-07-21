// the-pack voice — CostGuard + DailyCap (verbatim port from beast-super-app;
// xAI realtime is $0.05/min; we meter wall-clock connected seconds as an
// UPPER BOUND. KillReason preservation: a specific reason is never
// overwritten by a later generic status() call.)
import { MAX_SESSION_S, PRICE_PER_MIN_USD, SESSION_BUDGET_USD, WARN_FRACTION } from "./config.js";

export const KillReason = {
  NONE: "none",
  BUDGET_EXCEEDED: "budget_exceeded",
  MAX_DURATION: "max_duration",
  DAILY_CAP: "daily_cap",
  MANUAL: "manual",
  XAI_ERROR: "xai_error",
  BILLING_ERROR: "billing_error",
  AUTH_ERROR: "auth_error",
  HANGUP: "hangup",
  ADAPTER_LOST: "adapter_lost",
  IDLE_TIMEOUT: "idle_timeout",
};

export const GuardStatus = { OK: "ok", WARN: "warn", KILL: "kill" };

export class CostGuard {
  constructor(opts = {}) {
    this.budgetUsd = opts.budgetUsd ?? SESSION_BUDGET_USD;
    this.pricePerMin = opts.pricePerMin ?? PRICE_PER_MIN_USD;
    this.warnFraction = opts.warnFraction ?? WARN_FRACTION;
    this.maxSessionS = opts.maxSessionS ?? MAX_SESSION_S;
    this.startedAt = opts.startedAt ?? Date.now();
    this.manualKill = false;
    this.reason = KillReason.NONE;
  }
  elapsedS(now) {
    return ((now ?? Date.now()) - this.startedAt) / 1000;
  }
  estimateCostUsd(now) {
    return (this.elapsedS(now) / 60) * this.pricePerMin;
  }
  status(now) {
    if (this.manualKill) {
      if (this.reason === KillReason.NONE) this.reason = KillReason.MANUAL;
      return GuardStatus.KILL;
    }
    if (this.elapsedS(now) >= this.maxSessionS) {
      this.reason = KillReason.MAX_DURATION;
      return GuardStatus.KILL;
    }
    if (this.estimateCostUsd(now) >= this.budgetUsd) {
      this.reason = KillReason.BUDGET_EXCEEDED;
      return GuardStatus.KILL;
    }
    if (this.estimateCostUsd(now) >= this.warnFraction * this.budgetUsd) return GuardStatus.WARN;
    return GuardStatus.OK;
  }
  kill(reason = KillReason.MANUAL) {
    this.manualKill = true;
    if (this.reason === KillReason.NONE) this.reason = reason;
  }
  get killReason() {
    return this.reason;
  }
}

/** DailyCap — D1-persisted seconds per UTC day (voice_usage table). */
export class DailyCap {
  constructor(maxSeconds, nowFn = () => new Date()) {
    this.maxSeconds = maxSeconds;
    this.now = nowFn;
  }
  static keyFor(date) {
    return date.toISOString().slice(0, 10);
  }
  get key() {
    return DailyCap.keyFor(this.now());
  }
  allow(usedSeconds) {
    return usedSeconds < this.maxSeconds;
  }
}
