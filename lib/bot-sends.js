// Registry of messages WE sent via Admin API.
//
// Wazzup sometimes webhooks our own API sends back with isEcho=true (as if from
 // Phone). The only reliable way to tell bot vs manager is to remember what we
 // sent: messageId from the API response, crmMessageId (nice-bot-*), and a short
 // text fingerprint — then ignore those on the way back.

const BLOB_PATH = process.env.WA_BOT_SENDS_BLOB_PATH || "wa-bot-sends.json";
const TTL_MS = Number(process.env.WA_BOT_SENDS_TTL_MS || 15 * 60 * 1000);
const MAX_PER_CHAT = 20;

let chain = Promise.resolve();
let cache = { at: 0, byChat: new Map() }; // chatKey -> [{messageId, crmId, fp, at}]
const CACHE_TTL_MS = 2_000;

function blobEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

function fingerprint(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!s) return "";
  // Simple stable hash — enough to match our own echoes.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + ":" + s.length;
}

async function streamToString(stream) {
  if (!stream) return "";
  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function prune(map, now) {
  for (const [k, rows] of map.entries()) {
    const kept = (rows || []).filter((r) => r && Number(r.at) + TTL_MS > now);
    if (!kept.length) map.delete(k);
    else map.set(k, kept.slice(-MAX_PER_CHAT));
  }
}

async function loadAll(force) {
  const now = Date.now();
  if (!force && cache.at && now - cache.at < CACHE_TTL_MS) return cache.byChat;
  if (!blobEnabled()) {
    prune(cache.byChat, now);
    cache.at = now;
    return cache.byChat;
  }
  try {
    const { get } = require("@vercel/blob");
    const result = await get(BLOB_PATH, { access: "private", useCache: false });
    const map = new Map();
    if (result && result.statusCode === 200) {
      const text = await streamToString(result.stream);
      const data = text ? JSON.parse(text) : {};
      for (const [k, rows] of Object.entries(data || {})) {
        if (Array.isArray(rows)) map.set(k, rows);
      }
    }
    prune(map, now);
    cache = { at: now, byChat: map };
    return map;
  } catch (e) {
    console.warn("bot-sends: load failed", (e && e.message) || e);
    cache.at = now;
    return cache.byChat;
  }
}

async function saveAll(map) {
  prune(map, Date.now());
  cache = { at: Date.now(), byChat: map };
  if (!blobEnabled()) return false;
  const out = {};
  for (const [k, rows] of map.entries()) out[k] = rows;
  const { put } = require("@vercel/blob");
  await put(BLOB_PATH, JSON.stringify(out), {
    access: "private",
    allowOverwrite: true,
    contentType: "application/json",
    addRandomSuffix: false,
  });
  return true;
}

/**
 * Remember a successful Admin API send so webhook echoes are not treated as Phone.
 * @param {string} chatKey normalized phone / chat key
 * @param {{ messageId?: string, crmMessageId?: string, text?: string }} info
 */
async function recordSend(chatKey, info) {
  if (!chatKey) return null;
  const now = Date.now();
  const row = {
    messageId: info.messageId ? String(info.messageId) : "",
    crmId: info.crmMessageId ? String(info.crmMessageId) : "",
    fp: fingerprint(info.text),
    at: now,
  };
  // Also keep in memory immediately (same isolate) before blob round-trip.
  const mem = cache.byChat.get(chatKey) || [];
  mem.push(row);
  cache.byChat.set(chatKey, mem.slice(-MAX_PER_CHAT));
  cache.at = now;

  return withLock(async () => {
    const map = await loadAll(true);
    const list = map.get(chatKey) || [];
    list.push(row);
    map.set(chatKey, list.slice(-MAX_PER_CHAT));
    await saveAll(map);
    return row;
  });
}

function rowsFor(chatKey, map) {
  return (map && map.get(chatKey)) || cache.byChat.get(chatKey) || [];
}

/**
 * True if this webhook message is one we sent via Admin API.
 */
function isOurSend(m, chatKey) {
  if (!m || typeof m !== "object") return false;
  const crm = String(m.crmMessageId || m.crm_message_id || "");
  if (crm.startsWith("nice-bot-")) return true;

  const mid = String(m.messageId || m.message_id || "");
  const fp = fingerprint(m.text || m.body || "");
  const rows = rowsFor(chatKey);
  const now = Date.now();
  for (const r of rows) {
    if (!r || Number(r.at) + TTL_MS < now) continue;
    if (mid && r.messageId && mid === r.messageId) return true;
    if (crm && r.crmId && crm === r.crmId) return true;
    // Text match: only if fingerprint non-empty and equal (API echo of our reply).
    if (fp && r.fp && fp === r.fp) return true;
  }
  return false;
}

/** Async refresh then check — use before mute decisions across isolates. */
async function isOurSendAsync(m, chatKey) {
  await loadAll(true);
  return isOurSend(m, chatKey);
}

module.exports = {
  fingerprint,
  recordSend,
  isOurSend,
  isOurSendAsync,
  loadAll,
  TTL_MS,
  _internals: { getCache: () => cache, BLOB_PATH },
};
