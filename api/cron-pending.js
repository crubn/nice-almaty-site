// Vercel Cron — flush pending WhatsApp replies after the 5-minute Phone grace.
// Schedule: every minute (see vercel.json). Without this, quiet chats would
// wait until the next inbound webhook to get a bot reply.

const webhook = require("./wazzup-webhook.js");

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Vercel Cron sets this header. Also allow ?secret= for manual runs.
  const isCron = req.headers["x-vercel-cron"] === "1";
  const cronSecret = process.env.CRON_SECRET || process.env.WAZZUP_WEBHOOK_SECRET;
  const provided =
    (req.query && (req.query.secret || req.query.token)) ||
    (String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  if (!isCron) {
    if (!cronSecret || provided !== cronSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  try {
    const flushed = await webhook.flushDuePendings();
    console.log("cron-pending: flushed", JSON.stringify({ flushed }));
    return res.status(200).json({ ok: true, flushed });
  } catch (e) {
    console.error("cron-pending: error", (e && e.message) || e);
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
