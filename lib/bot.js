// Shared Nice Almaty AI concierge core — used by both the website chat
// (api/chat.js) and the WhatsApp/Wazzup webhook (api/wazzup-webhook.js).
//
// Answers questions about seat availability + house facts using DeepSeek V4 Flash.
// Data comes from data/availability.json (generated from the occupancy table with
// residents' names stripped) + data/site-facts.json. No personal data is ever sent.
//
// Required env:  DEEPSEEK_API_KEY
// Optional env:  DEEPSEEK_MODEL (default below), DEEPSEEK_BASE_URL

// require() bundles these JSON files into every function that imports this module,
// which is more reliable on Vercel than reading them from disk at runtime.
const availability = safeRequire("../data/availability.json");
const facts = safeRequire("../data/site-facts.json");

function safeRequire(rel) {
  try { return require(rel); } catch (e) { return null; }
}

const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const MAX_MESSAGE_LEN = 1000;
const MAX_HISTORY = 8;

const LANG_NAME = { ru: "Russian", kz: "Kazakh", en: "English" };

// User-facing fallback when the model/key is unavailable.
const FALLBACK = {
  ru: "Извините, ассистент сейчас недоступен. Напишите нам в WhatsApp: https://wa.me/77770739990 — ответим быстро!",
  kz: "Кешіріңіз, көмекші қазір қолжетімсіз. WhatsApp арқылы жазыңыз: https://wa.me/77770739990 — тез жауап береміз!",
  en: "Sorry, the assistant is unavailable right now. Message us on WhatsApp: https://wa.me/77770739990 — we reply fast!",
};

function buildSystemPrompt(opts) {
  opts = opts || {};
  const lang = opts.lang;
  const channel = opts.channel || "web";
  const booking = !!opts.booking;

  // On the website we know the UI language; on WhatsApp we don't, so ask the
  // model to mirror whatever language the customer writes in.
  const langLine = LANG_NAME[lang]
    ? `Always answer in ${LANG_NAME[lang]}, regardless of the language of the data below.`
    : "Reply in the SAME language the customer writes in (Russian, Kazakh or English).";

  const lines = [
    "You are the friendly AI concierge for Nice Almaty, a network of 5 student houses in Almaty, Kazakhstan.",
    langLine,
    "Keep answers short, warm and helpful. Use plain text (this may be sent over WhatsApp).",
    "",
    "You help students with: seat/room availability, prices, districts, bus routes to universities, amenities, and how to book.",
    "",
    "RULES:",
    "- Use ONLY the data provided below. Never invent houses, prices, routes or free places.",
    "- You have NO access to residents' or staff personal data (names, phone numbers). If asked who lives or works somewhere, politely refuse and say you can only share availability.",
    "- Availability rooms have: house, gender (муж/жен), roomType, floor, totalPlaces, free (number of open spots), price (KZT/month), status ('свободно' = free, 'занято' = taken, 'предварительная бронь' = tentatively booked).",
    "- Respect gender: Дом 1 is for guys (парни) only; the others are mixed (смешанный) with separate rooms for guys and girls. Never offer a room to the wrong gender.",
    "- The availability list is not exhaustive. If a house/room isn't listed, availability depends on the move-in date — ASK the student when they plan to move in (as in the FAQ) instead of saying there are no places.",
    "- A house with status 'Ремонт' (e.g. Дом 6) is under renovation and cannot be booked.",
    "- If a house is full, proactively suggest houses that still have free spots.",
    "- Use the FAQ answers and university→recommended-houses info when relevant.",
    "- If a question is outside student housing, gently steer back.",
  ];

  if (booking) {
    lines.push(
      "",
      "BOOKING (you may guide the whole booking conversation):",
      "- Help the student pick a house that has free places for their budget/university.",
      "- To reserve, explain: they come to view the house, then hold a spot with a prepayment. Collect their preferred house, move-in month, and university.",
      "- You CANNOT finalize a reservation in the system yourself — after collecting the details, tell them a Nice Almaty manager will confirm and finalize shortly, and share WhatsApp https://wa.me/77770739990 for anything urgent.",
      "- Never promise a specific bed/room is locked for them — only a manager confirms that."
    );
  } else {
    lines.push("- To book or view a house, direct them to WhatsApp: https://wa.me/77770739990 (or Instagram @nice_almaty).");
  }

  lines.push(
    "",
    "=== LIVE ROOM AVAILABILITY (generated " + ((availability && availability.generatedAt) || "n/a") + ", no personal data) ===",
    JSON.stringify((availability && availability.rooms) || []),
    "",
    "=== HOUSE FACTS + universities + FAQ (districts, gender, addresses, amenities, contacts) ===",
    JSON.stringify(facts || {})
  );
  return lines.join("\n");
}

function sanitizeHistory(history) {
  return Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_MESSAGE_LEN) }))
    : [];
}

// Core call. Returns { reply, ok }. Never throws — on any failure returns the
// localized fallback with ok=false so callers can decide whether to send it.
async function ask(opts) {
  opts = opts || {};
  const lang = opts.lang;
  const fallback = FALLBACK[lang] || FALLBACK.ru;
  const message = typeof opts.message === "string" ? opts.message.trim() : "";
  if (!message) return { reply: fallback, ok: false, reason: "empty" };

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return { reply: fallback, ok: false, reason: "no_key" };

  const messages = [
    { role: "system", content: buildSystemPrompt(opts) },
    ...sanitizeHistory(opts.history),
    { role: "user", content: message.slice(0, MAX_MESSAGE_LEN) },
  ];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, temperature: 0.2, max_tokens: 500, messages }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error("DeepSeek error", resp.status, detail.slice(0, 300));
      return { reply: fallback, ok: false, reason: "api_" + resp.status };
    }
    const data = await resp.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const trimmed = reply && reply.trim();
    return trimmed ? { reply: trimmed, ok: true } : { reply: fallback, ok: false, reason: "empty_reply" };
  } catch (e) {
    console.error("bot.ask error", (e && e.name) || e);
    return { reply: fallback, ok: false, reason: "exception" };
  }
}

module.exports = { ask, buildSystemPrompt, FALLBACK, MAX_MESSAGE_LEN };
