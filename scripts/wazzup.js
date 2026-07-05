#!/usr/bin/env node
// Small Wazzup24 API helper for setup + testing. Node 18+ (global fetch).
//
//   WAZZUP_API_KEY=xxx node scripts/wazzup.js channels
//   WAZZUP_API_KEY=xxx node scripts/wazzup.js get-webhook
//   WAZZUP_API_KEY=xxx node scripts/wazzup.js set-webhook https://your-app.vercel.app/api/wazzup-webhook?secret=YOURSECRET
//   WAZZUP_API_KEY=xxx node scripts/wazzup.js send <chatId> "text"   # chatId = phone digits, e.g. 77770739990
//
// NOTE: exact endpoints follow Wazzup API v3. If a call 4xx's, check the current
// docs (https://wazzup24.com/help/) — the paths here are the v3 conventions.

const BASE = process.env.WAZZUP_API_BASE || "https://api.wazzup24.com/v3";
const KEY = process.env.WAZZUP_API_KEY;

function die(msg) { console.error(msg); process.exit(1); }
if (!KEY) die("Set WAZZUP_API_KEY in the environment first.");

async function call(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = text; }
  console.log(`HTTP ${r.status}`);
  console.log(typeof json === "string" ? json : JSON.stringify(json, null, 2));
  if (!r.ok) process.exit(2);
  return json;
}

const [cmd, ...args] = process.argv.slice(2);

(async () => {
  switch (cmd) {
    case "channels":
      // List connected channels — grab the WhatsApp channelId for replies.
      await call("GET", "/channels");
      break;
    case "get-webhook":
      await call("GET", "/webhooks");
      break;
    case "set-webhook": {
      const uri = args[0];
      if (!uri) die("Usage: set-webhook <https url to /api/wazzup-webhook?secret=...>");
      await call("PATCH", "/webhooks", {
        webhooksUri: uri,
        subscriptions: { messagesAndStatuses: true, contactsAndDealsCreation: false },
      });
      break;
    }
    case "disable-webhook":
      // Soft-disable subscriptions (hard kill = remove the channel in the dashboard).
      await call("PATCH", "/webhooks", { subscriptions: { messagesAndStatuses: false } });
      break;
    case "send": {
      const [chatId, ...rest] = args;
      const text = rest.join(" ");
      if (!chatId || !text) die('Usage: send <chatId> "text"');
      await call("POST", "/message", {
        channelId: process.env.WAZZUP_CHANNEL_ID,
        chatId,
        chatType: "whatsapp",
        text,
      });
      break;
    }
    default:
      console.log("Commands: channels | get-webhook | set-webhook <url> | disable-webhook | send <chatId> \"text\"");
  }
})().catch((e) => die(String((e && e.stack) || e)));
