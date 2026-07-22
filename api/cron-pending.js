// Flush pending WhatsApp replies after the 5-minute Phone grace.
//
// Hobby plans cannot run per-minute Vercel Cron, so we also chain short
// self-wakes from the webhook (`armPendingWake` → this endpoint → re-arm
// while anything is still waiting). Manual: GET ?secret=WAZZUP_WEBHOOK_SECRET

const webhook = require("./wazzup-webhook.js");
const pendingReply = require("../lib/pending-reply.js");

let waitUntil = null;
try { ({ waitUntil } = require("@vercel/functions")); } catch (e) { /* local */ }

function publicBaseUrl() {
  if (process.env.WA_PUBLIC_BASE_URL) return process.env.WA_PUBLIC_BASE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return "https://" + String(process.env.VERCEL_PROJECT_PRODUCTION_URL).replace(/^https?:\/\//, "");
  }
  if (process.env.VERCEL_URL) return "https://" + String(process.env.VERCEL_URL).replace(/^https?:\/\//, "");
  return "";
}

function armNextWake() {
  const base = publicBaseUrl();
  const secret = process.env.CRON_SECRET || process.env.WAZZUP_WEBHOOK_SECRET || "";
  if (!base || !secret) return;
  const url = base + "/api/cron-pending?secret=" + encodeURIComponent(secret) + "&wake=1";
  const delayMs = Number(process.env.WA_PENDING_WAKE_MS || 55_000);
  const work = (async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    try { await fetch(url, { method: "GET" }); } catch (e) { /* ignore */ }
  })();
  if (waitUntil) waitUntil(work);
  else work.catch(() => {});
}

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

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
    const waiting = await pendingReply.listAll().catch(() => []);
    const stillWaiting = waiting.filter((r) => Number(r.answerAfter) > Date.now());
    if (stillWaiting.length) armNextWake();
    console.log("cron-pending: flushed", JSON.stringify({
      flushed,
      stillWaiting: stillWaiting.length,
    }));
    return res.status(200).json({ ok: true, flushed, stillWaiting: stillWaiting.length });
  } catch (e) {
    console.error("cron-pending: error", (e && e.message) || e);
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
