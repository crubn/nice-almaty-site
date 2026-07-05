// Vercel serverless function — WhatsApp bot via Wazzup24.
//
// Flow: Wazzup POSTs an incoming WhatsApp message here → we run it through the
// shared concierge core (lib/bot.js, booking enabled) → send the reply back
// through the Wazzup API. Website chat and WhatsApp share the same data + brain.
//
// SAFETY — this talks to real customers on WhatsApp. Two kill switches:
//   1. Instant, no redeploy: Vercel Edge Config flag `waBotEnabled=false`
//      (works if EDGE_CONFIG is set). Falls back to env WA_BOT_ENABLED.
//   2. Hard off at the source: disable the channel / remove the webhook in Wazzup.
//
// Required env:  WAZZUP_API_KEY, DEEPSEEK_API_KEY
// Optional env:  WAZZUP_CHANNEL_ID (default channel for replies),
//                WAZZUP_WEBHOOK_SECRET (shared secret in the webhook URL query),
//                WA_BOT_ENABLED ("false" to mute), WAZZUP_API_BASE,
//                EDGE_CONFIG (enables the instant kill switch)

const bot = require("../lib/bot.js");

const WAZZUP_BASE = process.env.WAZZUP_API_BASE || "https://api.wazzup24.com/v3";

// Best-effort import of Vercel's waitUntil so AI+send finish after we ack the
// webhook fast (Wazzup expects a quick 200). Falls back to inline await locally.
let waitUntil = null;
try { ({ waitUntil } = require("@vercel/functions")); } catch (e) { /* local dev */ }

// ── Kill switch ──────────────────────────────────────────────────────────────
// Instant toggle via Edge Config when available, else the env flag. Defaults ON.
async function isBotEnabled() {
  const conn = process.env.EDGE_CONFIG;
  if (conn) {
    try {
      // EDGE_CONFIG looks like: https://edge-config.vercel.com/ecfg_xxx?token=yyy
      const u = new URL(conn);
      const token = u.searchParams.get("token");
      const id = u.pathname.replace(/^\//, "");
      const r = await fetch(`https://edge-config.vercel.com/${id}/item/waBotEnabled?token=${token}`);
      if (r.ok) {
        const val = await r.json().catch(() => undefined);
        if (val === false) return false;
        if (val === true) return true;
      }
    } catch (e) { /* fall through to env */ }
  }
  return process.env.WA_BOT_ENABLED !== "false";
}

// ── Defensive field extraction (Wazzup v3 payload shape confirmed on 1st msg) ──
function extractText(m) {
  return (typeof m.text === "string" && m.text)
    || (typeof m.body === "string" && m.body)
    || (m.content && typeof m.content.text === "string" && m.content.text)
    || "";
}
function extractChatId(m) {
  return m.chatId || m.chatID || m.chat_id || (m.contact && m.contact.chatId) || "";
}
function isOutbound(m) {
  // Ignore anything we (the connected account) authored, or delivery statuses.
  return m.isEcho === true || m.fromMe === true || m.isFromCrm === true
    || m.inbound === false || m.direction === "outbound";
}
function isGroup(m) {
  const t = (m.chatType || "").toLowerCase();
  const id = extractChatId(m);
  return t.indexOf("group") !== -1 || (typeof id === "string" && id.indexOf("@g.us") !== -1);
}

// A message is actionable only if it's a real inbound text from a 1:1 chat.
function actionable(m) {
  if (!m || typeof m !== "object") return false;
  if (m.type && m.type !== "text") return false;   // skip images/audio/etc.
  if (isOutbound(m)) return false;
  if (isGroup(m)) return false;
  if (!extractChatId(m)) return false;
  return !!extractText(m);
}

async function sendReply(channelId, chatId, chatType, text) {
  const apiKey = process.env.WAZZUP_API_KEY;
  if (!apiKey) { console.error("wazzup: WAZZUP_API_KEY not set"); return; }
  const body = {
    channelId: channelId || process.env.WAZZUP_CHANNEL_ID,
    chatId,
    chatType: chatType || "whatsapp",
    text,
  };
  try {
    const r = await fetch(`${WAZZUP_BASE}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("wazzup send failed", r.status, detail.slice(0, 300));
    } else {
      console.log("wazzup: replied", JSON.stringify({ chatId, len: text.length }));
    }
  } catch (e) {
    console.error("wazzup send error", (e && e.name) || e);
  }
}

async function handleMessage(m) {
  const chatId = extractChatId(m);
  const text = extractText(m);
  const chatType = m.chatType || "whatsapp";
  const channelId = m.channelId || process.env.WAZZUP_CHANNEL_ID;
  console.log("wazzup: inbound", JSON.stringify({ chatId, text: text.slice(0, 200) }));

  // WhatsApp: language unknown → let the model mirror the customer. Booking on.
  const { reply } = await bot.ask({ message: text, channel: "whatsapp", booking: true });
  await sendReply(channelId, chatId, chatType, reply);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Shared-secret guard: keeps randoms from triggering DeepSeek cost / WhatsApp sends.
  const secret = process.env.WAZZUP_WEBHOOK_SECRET;
  if (secret) {
    const provided = (req.query && (req.query.secret || req.query.token)) || "";
    if (provided !== secret) return res.status(401).json({ error: "unauthorized" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // Wazzup verifies a new webhook by POSTing {test:true} — must 200 quickly.
  if (body.test === true) return res.status(200).json({ ok: true });

  // Kill switch: ack but stay silent when disabled.
  if (!(await isBotEnabled())) {
    console.log("wazzup: bot disabled, ignoring");
    return res.status(200).json({ ok: true, muted: true });
  }

  const messages = Array.isArray(body.messages) ? body.messages.filter(actionable) : [];

  // Ack fast so Wazzup doesn't retry; process AI + send in the background.
  res.status(200).json({ ok: true, accepted: messages.length });

  const work = Promise.all(messages.map((m) => handleMessage(m).catch((e) =>
    console.error("wazzup: handleMessage error", (e && e.name) || e))));
  if (waitUntil) { waitUntil(work); } else { await work; }
};
