// Vercel serverless function — website chat widget endpoint.
// Thin wrapper over the shared concierge core in lib/bot.js.
//
// Required env:  DEEPSEEK_API_KEY   (see lib/bot.js for optional env)

const bot = require("../lib/bot.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const lang = ["ru", "kz", "en"].includes(body.lang) ? body.lang : "ru";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return res.status(400).json({ error: "Empty message" });
  if (message.length > bot.MAX_MESSAGE_LEN) {
    return res.status(400).json({ error: "Message too long" });
  }

  // ask() never throws; it returns the localized fallback on any failure.
  const { reply } = await bot.ask({ lang, message, history: body.history, channel: "web" });
  return res.status(200).json({ reply });
};
