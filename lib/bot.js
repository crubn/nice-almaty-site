// Shared Nice Almaty AI concierge core — used by both the website chat
// (api/chat.js) and the WhatsApp/Wazzup webhook (api/wazzup-webhook.js).
//
// GROUNDING (anti-hallucination): the authoritative facts about each house live in
// hand-edited files data/houses/dom-*.md. ALL of them are injected into every prompt,
// and the model is told to answer ONLY from them. Live free-place counts come from
// data/availability.json. Personal data and street addresses are never sent.
//
// After editing a dom-*.md file: commit it and redeploy (vercel.json includeFiles
// ships the folder with the function). No build step.
//
// Required env:  DEEPSEEK_API_KEY
// Optional env:  DEEPSEEK_MODEL (default below), DEEPSEEK_BASE_URL

const fs = require("fs");
const path = require("path");

function safeRequire(rel) {
  try { return require(rel); } catch (e) { return null; }
}

// Live availability (numbers) is generated from the xlsx; require() bundles it reliably.
const availability = safeRequire("../data/availability.json");
// site-facts is used ONLY for FAQ + universities + contacts. Its house block (which
// still holds addresses) is deliberately NOT injected — see buildSystemPrompt.
const facts = safeRequire("../data/site-facts.json");

// Load every hand-edited house file (dom-*.md) once per cold start.
function loadHouseFiles() {
  const dir = path.join(__dirname, "..", "data", "houses");
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f), "utf-8").trim())
      .filter(Boolean);
  } catch (e) {
    console.error("bot: could not load data/houses/*.md —", (e && e.message) || e);
    return [];
  }
}
const HOUSE_FILES = loadHouseFiles();

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
    "You are the friendly AI concierge for Nice Almaty, a network of student houses in Almaty, Kazakhstan.",
    langLine,
    "Keep answers short, warm and helpful. Use plain text (this may be sent over WhatsApp).",
    "",
    "You help students with: room availability, prices, districts, bus routes to universities, amenities, and how to book.",
    "",
    "GROUNDING RULES (very important — the business loses trust if you invent things):",
    "- Answer ONLY with facts written in the HOUSE FILES and the LIVE ROOM AVAILABILITY below. If a fact is not written there, DO NOT guess or make it up.",
    "- If you don't have the info (a price, a bus route, a detail), say so honestly and offer to connect a manager via WhatsApp https://wa.me/77770739990. Never invent a number, bus, price or fact.",
    "- NEVER give a street address, street name or house number — only the district (район). If asked for the address, say the exact address and a viewing are arranged by a manager, and give only the district.",
    "- DO share, when asked or relevant, the nearby universities and the bus routes (bus numbers + approximate minutes) listed in the house file — this is public, helpful info. Only the exact address is secret; routes and universities are NOT.",
    "- Each house has its own file headed '# Дом N'. Take every fact from the correct house's file; never mix facts between houses.",
    "- You have NO access to residents' or staff personal data (names, phone numbers). If asked who lives or works somewhere, politely refuse.",
    "",
    "AVAILABILITY:",
    "- LIVE ROOM AVAILABILITY rows have: house, gender (муж/жен), roomType, floor, totalPlaces, free (open spots), price (KZT/month), status ('свободно' = free, 'занято' = taken, 'предварительная бронь' = tentatively booked).",
    "- This list is NOT exhaustive. If a house/room isn't in it, don't say 'no places' — availability depends on the move-in date, so ASK when the student plans to move in.",
    "- Respect gender (see each house file). Дом 1 is guys-only. Never offer a room to the wrong gender.",
    "- A house whose file says status 'на ремонте' (Дом 6) cannot be booked — suggest another house with free spots instead.",
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

  // Authoritative per-house facts (no addresses). ALL houses, each headed "# Дом N".
  lines.push("", "=== HOUSE FILES (authoritative — answer only from these; no addresses) ===");
  if (HOUSE_FILES.length) {
    lines.push(HOUSE_FILES.join("\n\n---\n\n"));
  } else {
    lines.push("(house files unavailable — do not invent house facts; offer WhatsApp https://wa.me/77770739990)");
  }

  lines.push(
    "",
    "=== LIVE ROOM AVAILABILITY (generated " + ((availability && availability.generatedAt) || "n/a") + ", no personal data) ===",
    JSON.stringify((availability && availability.rooms) || [])
  );

  // From site-facts inject ONLY universities + FAQ + contacts — NOT the house block
  // (that one still carries addresses, which must never reach the model).
  const extra = {};
  if (facts && facts.universities) extra.universities = facts.universities;
  if (facts && facts.faq) extra.faq = facts.faq;
  if (facts && facts.brand && facts.brand.contacts) extra.contacts = facts.brand.contacts;
  lines.push("", "=== UNIVERSITIES + FAQ + CONTACTS ===", JSON.stringify(extra));

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
