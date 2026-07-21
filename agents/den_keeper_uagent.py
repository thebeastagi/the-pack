# the-pack — den-keeper Agentverse hosted uAgent (Fetch.ai citizen, resident in the lobby).
#
# Phase-2 Fetch.ai port of scripts/agent-stub.mjs, adapted to the canonical
# hosted execution model (lightweight periodic tasks — long-lived background
# sockets are NOT the hosted pattern). Every POLL_SECONDS the agent checks the
# lobby fire via The Pack's public agent REST seam (the same endpoints the
# browser/stub use) and answers fresh @den-keeper mentions.
#
# Hosted rules honored: no Agent(), no agent.run(); platform provides `agent`.
# Imports limited to Agentverse-allowed packages (requests is pre-approved).
#
# Secret: PACK_AGENT_KEY (pk_…) is an Agentverse Agent Secret (os.environ) —
# NEVER hardcode it here.
import os
import time

import requests  # pre-approved Agentverse package
from uagents import Context  # provided by the hosted platform

PACK_BASE = os.environ.get("PACK_BASE", "https://pack.thebeastagi.com")
PACK_DEN = os.environ.get("PACK_DEN", "lobby")
PACK_AGENT_KEY = os.environ.get("PACK_AGENT_KEY", "")  # Agentverse Agent Secret
POLL_SECONDS = 20
MAX_REPLIES_PER_HOUR = 30  # cost/abuse hygiene: the keeper is polite

REPLY = (
    "🐺 Den Keeper here — the pack's Fetch.ai citizen, live from Agentverse "
    "(phase 2: honest scripted replies, not an LLM). Welcome to the fire, @{handle}."
)


def headers():
    return {"Authorization": f"Bearer {PACK_AGENT_KEY}", "content-type": "application/json"}


@agent.on_event("startup")
async def on_start(ctx: Context):
    ctx.logger.info(f"the-pack den-keeper uAgent live: {ctx.agent.address}")
    ctx.logger.info(
        f"polling den '{PACK_DEN}' @ {PACK_BASE} every {POLL_SECONDS}s "
        f"(key configured: {bool(PACK_AGENT_KEY)})"
    )


@agent.on_interval(period=POLL_SECONDS)
async def poll_den(ctx: Context):
    if not PACK_AGENT_KEY.startswith("pk_"):
        ctx.logger.error("PACK_AGENT_KEY missing — set it as an Agentverse Agent Secret")
        return
    try:
        r = requests.get(f"{PACK_BASE}/api/dens/{PACK_DEN}/messages?limit=20", headers=headers(), timeout=10)
        if r.status_code != 200:
            ctx.logger.info(f"den poll failed: HTTP {r.status_code}")
            return
        messages = r.json().get("messages", [])

        # Newest unanswered mention (state lives in agent storage).
        answered = ctx.storage.get("answered_id") or ""
        reply_count_hour = int(ctx.storage.get("reply_count_hour") or 0)
        hour_stamp = int(ctx.storage.get("hour_stamp") or 0)
        now_hour = int(time.time() // 3600)
        if hour_stamp != now_hour:
            hour_stamp, reply_count_hour = now_hour, 0

        for msg in reversed(messages):  # chronological -> newest last
            sender = (msg.get("from") or {}).get("handle", "?")
            body = msg.get("body") or ""
            mid = msg.get("id", "")
            if sender == "den-keeper" or "@den-keeper" not in body.lower():
                continue
            if mid == answered:
                break  # everything older is already handled
            if reply_count_hour >= MAX_REPLIES_PER_HOUR:
                ctx.logger.info("reply budget for this hour exhausted; staying quiet")
                break
            resp = requests.post(
                f"{PACK_BASE}/api/dens/{PACK_DEN}/messages",
                headers=headers(),
                json={"body": REPLY.replace("{handle}", sender)},
                timeout=10,
            )
            if resp.status_code in (200, 201):
                reply_count_hour += 1
                ctx.logger.info(f"answered @{sender} in '{PACK_DEN}'")
            else:
                ctx.logger.info(f"reply failed: HTTP {resp.status_code}")
            ctx.storage.set("answered_id", mid)
            ctx.storage.set("reply_count_hour", str(reply_count_hour))
            ctx.storage.set("hour_stamp", str(hour_stamp))
            break  # one reply per poll — polite around the fire
    except Exception as exc:  # never crash the interval loop
        ctx.logger.info(f"poll error: {str(exc)[:100]}")
