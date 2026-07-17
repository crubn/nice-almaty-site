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
const sheets = require("../lib/sheets.js");
const transcribe = require("../lib/transcribe.js");

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

// Inbound 1:1 text OR voice (audio) — images/docs/etc. still skipped.
function actionable(m) {
  if (!m || typeof m !== "object") return false;
  const isAudio = transcribe.isAudioType(m);
  if (m.type && m.type !== "text" && !isAudio) return false;
  if (isOutbound(m)) return false;
  if (isGroup(m)) return false;
  if (!extractChatId(m)) return false;
  if (isAudio) return !!transcribe.extractContentUri(m);
  return !!extractText(m);
}

// Voice URLs from Wazzup expire quickly — download + STT BEFORE debounce.
async function materializeTexts(messages) {
  const out = [];
  for (const m of messages) {
    const resolved = await transcribe.resolveMessageText(m);
    out.push({
      chatId: extractChatId(m),
      channelId: m.channelId,
      chatType: m.chatType,
      messageId: m.messageId || m.message_id || null,
      text: resolved.text || "",
      source: resolved.source,
      error: resolved.error || null,
      provider: resolved.provider || null,
    });
  }
  return out;
}

const VOICE_FAIL = {
  no_stt_key:
    "Сейчас голосовые ещё настраиваются. Напишите, пожалуйста, текстом — отвечу сразу.",
  default:
    "Не удалось распознать голосовое сообщение. Напишите, пожалуйста, текстом — отвечу сразу.",
};

// Wazzup rejects a second POST with the same crmMessageId (≈60s window).
// Lock MUST be keyed to the inbound batch (message ids / text), NOT wall-clock
// buckets — a time bucket would also block legitimate follow-up replies.
function fnv1a(s) {
  let h = 2166136261;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function burstCrmMessageId(chatId, parts) {
  const ids = (parts || [])
    .map((p) => p && (p.messageId || p.message_id))
    .filter(Boolean)
    .map(String)
    .sort();
  if (ids.length) {
    const full = "nice-bot-" + chatId + "-" + ids.join(",");
    // Truncation alone collides on large bursts — keep a hash of the full key.
    if (full.length <= 120) return full;
    return (full.slice(0, 100) + "-" + fnv1a(full)).slice(0, 120);
  }
  const text = (parts || []).map((p) => String((p && p.text) || "")).join("\n");
  return ("nice-bot-" + chatId + "-t" + fnv1a(text)).slice(0, 120);
}

// Stickers / thumbs-up reactions — do not waste a full AI reply (and do not
// touch the unanswered badge).
function isNonTextNoise(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  // Only emoji / symbols / variation selectors / ZWJ — no letters or digits.
  return /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D\s️]+$/u.test(t)
    && !/[0-9a-zа-яёәіңғүұқөһ]/iu.test(t);
}

async function sendReply(channelId, chatId, chatType, text, crmMessageId, opts) {
  opts = opts || {};
  const apiKey = process.env.WAZZUP_API_KEY;
  if (!apiKey) { console.error("wazzup: WAZZUP_API_KEY not set"); return { ok: false }; }
  const body = {
    channelId: channelId || process.env.WAZZUP_CHANNEL_ID,
    chatId,
    chatType: chatType || "whatsapp",
    text,
  };
  if (crmMessageId) body.crmMessageId = crmMessageId;
  if (opts.refMessageId) body.refMessageId = opts.refMessageId;
  // Wazzup unanswered (= green/red badge in inbox):
  //   clearUnanswered:true  → bot fully answered → chat looks handled
  //   clearUnanswered:false → need a human → keep unanswered badge
  // Always send the boolean explicitly (omit was unreliable in practice).
  const keepUnanswered = opts.clearUnanswered === false;
  body.clearUnanswered = keepUnanswered ? false : true;
  try {
    const r = await fetch(`${WAZZUP_BASE}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      if (r.status === 400 && /repeatedCrmMessageId/i.test(detail)) {
        console.log("wazzup: burst lock — duplicate reply skipped", JSON.stringify({ chatId, crmMessageId }));
        return { ok: false, skipped: true };
      }
      console.error("wazzup send failed", r.status, detail.slice(0, 300));
      return { ok: false };
    }
    console.log("wazzup: replied", JSON.stringify({
      chatId,
      len: text.length,
      crmMessageId: crmMessageId || null,
      clearUnanswered: body.clearUnanswered,
      needsManager: keepUnanswered,
    }));
    return { ok: true };
  } catch (e) {
    console.error("wazzup send error", (e && e.name) || e);
    return { ok: false };
  }
}

// Send an image via Wazzup (contentUri). On any failure, fall back to sending
// the URL as plain text so the customer still gets the photo link.
async function sendMedia(channelId, chatId, chatType, url, caption, opts) {
  opts = opts || {};
  const apiKey = process.env.WAZZUP_API_KEY;
  if (!apiKey || !url) return;
  const keepUnanswered = opts.clearUnanswered === false;
  const body = {
    channelId: channelId || process.env.WAZZUP_CHANNEL_ID,
    chatId,
    chatType: chatType || "whatsapp",
    contentUri: url,
    // Keep the same unanswered policy as the text reply (media must not wipe a handoff badge).
    clearUnanswered: keepUnanswered ? false : true,
  };
  if (opts.crmMessageId) body.crmMessageId = opts.crmMessageId;
  const linkFallback = () => sendReply(
    channelId, chatId, chatType,
    (caption ? caption + " " : "") + url,
    opts.crmMessageId ? String(opts.crmMessageId).slice(0, 116) + "-L" : null,
    { clearUnanswered: keepUnanswered ? false : true }
  );
  try {
    const r = await fetch(`${WAZZUP_BASE}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("wazzup media failed", r.status, detail.slice(0, 300));
      await linkFallback();
    } else {
      console.log("wazzup: sent media", JSON.stringify({ chatId, clearUnanswered: body.clearUnanswered }));
    }
  } catch (e) {
    console.error("wazzup media error", (e && e.name) || e);
    await linkFallback();
  }
}

// Short in-memory history per WhatsApp chat (best-effort on warm serverless
// instances). Stops the bot re-asking university/district after a prior reply.
const CHAT_HISTORY = new Map(); // chatId -> { at, turns:[{role,content}] }
const CHAT_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const CHAT_HISTORY_MAX_TURNS = 8;

// Last time we greeted this chat — suppress «Здравствуйте» / «Сәлеметсіз бе»
// for 24h (same isolate). ask() also hard-strips if skipGreeting is set.
const GREETED_AT = new Map(); // chatId -> timestamp
const GREET_TTL_MS = 24 * 60 * 60 * 1000;

function historyFor(chatId) {
  const row = CHAT_HISTORY.get(chatId);
  if (!row) return [];
  if (Date.now() - row.at > CHAT_HISTORY_TTL_MS) {
    CHAT_HISTORY.delete(chatId);
    return [];
  }
  return row.turns.slice(-CHAT_HISTORY_MAX_TURNS);
}
function remember(chatId, userText, assistantText) {
  const prev = historyFor(chatId);
  const turns = prev.concat(
    { role: "user", content: userText },
    { role: "assistant", content: assistantText }
  ).slice(-CHAT_HISTORY_MAX_TURNS);
  CHAT_HISTORY.set(chatId, { at: Date.now(), turns });
}
function recentlyGreeted(chatId) {
  const at = GREETED_AT.get(chatId);
  if (!at) return false;
  if (Date.now() - at > GREET_TTL_MS) {
    GREETED_AT.delete(chatId);
    return false;
  }
  return true;
}
function markGreeted(chatId) {
  GREETED_AT.set(chatId, Date.now());
}

// Group inbound messages by chat and answer ONCE per chat. Rapid double-sends
// ("Біз МУИТпіз" + "Жақын үй керек") used to trigger two conflicting replies.
function groupByChat(messages) {
  const order = [];
  const map = new Map();
  for (const m of messages) {
    const chatId = extractChatId(m);
    if (!map.has(chatId)) {
      map.set(chatId, []);
      order.push(chatId);
    }
    map.get(chatId).push(m);
  }
  return order.map((chatId) => ({ chatId, messages: map.get(chatId) }));
}

// Debounce per chat on the SAME isolate. Cross-isolate doubles are stopped by
// crmMessageId burst lock in sendReply (see burstCrmMessageId).
const PENDING = new Map(); // chatId -> { messages, waiters, timer }
const INFLIGHT = new Map(); // chatId -> Promise (serialize handleChat per chat)
// ≥12–15s so «Я учусь в кому» + quick correction «Крму» merge into one reply.
const DEBOUNCE_MS = Number(process.env.WA_DEBOUNCE_MS || 15000);

function enqueueChat(chatId, parts) {
  return new Promise((resolve) => {
    let slot = PENDING.get(chatId);
    if (!slot) {
      slot = { messages: [], waiters: [], timer: null };
      PENDING.set(chatId, slot);
    }
    slot.messages.push(...parts);
    slot.waiters.push(resolve);
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      PENDING.delete(chatId);
      const batch = slot.messages;
      const waiters = slot.waiters;
      const run = () => handleChat(chatId, batch)
        .catch((e) => console.error("wazzup: handleChat error", (e && e.name) || e));
      const prev = INFLIGHT.get(chatId);
      const chain = (prev ? prev.then(run, run) : run()).finally(() => {
        if (INFLIGHT.get(chatId) === chain) INFLIGHT.delete(chatId);
        for (const w of waiters) w();
      });
      INFLIGHT.set(chatId, chain);
    }, DEBOUNCE_MS);
  });
}

async function handleChat(chatId, parts) {
  const texts = parts.map((p) => String(p.text || "").trim()).filter(Boolean);
  const first = parts[0] || {};
  const chatType = first.chatType || "whatsapp";
  const channelId = first.channelId || process.env.WAZZUP_CHANNEL_ID;
  const lockId = burstCrmMessageId(chatId, parts);

  // Defense-in-depth: blocklist also checked before STT in the webhook entry.
  const ignored = await sheets.getIgnoredPhones().catch(() => []);
  if (sheets.isIgnoredPhone(chatId, ignored)) {
    console.log("wazzup: ignored (blocklist)", JSON.stringify({ chatId: sheets.normalizePhone(chatId) }));
    return;
  }

  if (!texts.length) {
    const voiceTried = parts.some((p) => p.source === "audio");
    if (voiceTried) {
      const reason = (parts.find((p) => p.error) || {}).error;
      const reply = reason === "no_stt_key" ? VOICE_FAIL.no_stt_key : VOICE_FAIL.default;
      console.log("wazzup: voice fail", JSON.stringify({ chatId, reason: reason || "empty" }));
      await sendReply(channelId, chatId, chatType, reply, lockId, {
        clearUnanswered: true,
        refMessageId: [...parts].reverse().map((p) => p.messageId).find(Boolean) || null,
      });
    }
    return;
  }

  const combined = texts.join("\n");
  const hadVoice = parts.some((p) => p.source === "audio" && p.text);
  const refMessageId = [...parts].reverse().map((p) => p.messageId).find(Boolean) || null;
  console.log("wazzup: inbound", JSON.stringify({
    chatId,
    parts: texts.length,
    voice: hadVoice,
    text: combined.slice(0, 300),
  }));

  // Ignore emoji-only reactions (👍) — answering them looks spammy and can
  // leave odd unread states in Wazzup.
  if (isNonTextNoise(combined)) {
    console.log("wazzup: ignore emoji/reaction", JSON.stringify({ chatId, text: combined }));
    return;
  }

  // WhatsApp: language unknown → let the model mirror the customer. Booking on.
  // Almost never greet — chat is already open. Only answer a hello once / 24h.
  const hist = historyFor(chatId);
  const userHello = bot.userLooksLikeGreeting(combined);
  const skipGreeting = recentlyGreeted(chatId)
    || hist.some((t) => t.role === "assistant")
    || !userHello;
  const { reply, attachments, needsManager } = await bot.ask({
    message: combined,
    history: hist,
    channel: "whatsapp",
    booking: true,
    skipGreeting,
  });
  if (!reply) return;

  // Handoff ONLY via explicit [МЕНЕДЖЕР] → keep unanswered (green) badge.
  // Ordinary answers clearUnanswered:true so the chat does not stay "unread".
  const sendOpts = {
    clearUnanswered: needsManager ? false : true,
    refMessageId,
  };
  if (needsManager) {
    console.log("wazzup: handoff → keep unanswered badge", JSON.stringify({ chatId }));
  }
  const sent = await sendReply(
    channelId,
    chatId,
    chatType,
    reply,
    lockId,
    sendOpts
  );
  if (sent && sent.skipped) {
    // Winner isolate already replied — still store context on this isolate.
    remember(chatId, combined, reply);
    return;
  }
  if (sent && sent.ok) {
    remember(chatId, combined, reply);
    if (userHello || bot.startsWithFormalGreeting(reply)) markGreeted(chatId);
  }

  // Photos only if the text reply landed (avoid orphan media after a skip).
  if (sent && sent.ok) {
    let i = 0;
    for (const a of attachments || []) {
      // Keep suffix room so "-mN" / "-mN-L" never collide with truncated lockId.
      const mediaLock = (String(lockId).slice(0, 100) + "-m" + (i++)).slice(0, 120);
      await sendMedia(channelId, chatId, chatType, a.mediaUrl, a.caption, {
        clearUnanswered: needsManager ? false : true,
        crmMessageId: mediaLock,
      });
    }
  }
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
  const chats = groupByChat(messages);

  // Ack fast so Wazzup doesn't retry; process AI + send in the background.
  res.status(200).json({ ok: true, accepted: messages.length, chats: chats.length });

  // Blocklist BEFORE STT (voice URLs + Whisper cost). Then materialize voice
  // immediately (Wazzup store links expire) and debounce text handling.
  const work = Promise.all(chats.map(async ({ chatId, messages: ms }) => {
    const ignored = await sheets.getIgnoredPhones().catch(() => []);
    if (sheets.isIgnoredPhone(chatId, ignored)) {
      console.log("wazzup: ignored (blocklist)", JSON.stringify({ chatId: sheets.normalizePhone(chatId) }));
      return;
    }
    const parts = await materializeTexts(ms);
    for (const p of parts) {
      if (p.source === "audio") {
        console.log("wazzup: voice", JSON.stringify({
          chatId,
          ok: !!p.text,
          error: p.error || null,
          provider: p.provider || null,
          preview: (p.text || "").slice(0, 120),
        }));
      }
    }
    return enqueueChat(chatId, parts);
  }));
  if (waitUntil) { waitUntil(work); } else { await work; }
};
