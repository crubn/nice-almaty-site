// Pending WhatsApp replies — wait for a human (Phone) before the bot answers.
//
// Flow:
//   1. Customer message → schedule pending with answerAfter = now + GRACE (5 min)
//   2. New customer message in same chat → merge texts, RESET the 5-min timer
//   3. Manager/Phone replies during the window → mute 1h + cancel pending
//   4. After 5 min with no Phone reply → cron/webhook flush runs handleChat
//
// Stored in Vercel Blob so every isolate shares the queue (maxDuration is only 120s,
// so we cannot sleep 5 minutes inside one function).

const GRACE_MS = Number(process.env.WA_MANAGER_GRACE_MS || 5 * 60 * 1000);
const BLOB_PATH = process.env.WA_PENDING_BLOB_PATH || "wa-pending-replies.json";

let chain = Promise.resolve();
let cache = { at: 0, byKey: new Map() }; // key -> pending row
const CACHE_TTL_MS = 2_000;

function blobEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
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

async function loadAll(force) {
  if (!blobEnabled()) {
    return cache.byKey;
  }
  const now = Date.now();
  if (!force && cache.at && now - cache.at < CACHE_TTL_MS) return cache.byKey;
  try {
    const { get } = require("@vercel/blob");
    const result = await get(BLOB_PATH, { access: "private", useCache: false });
    const map = new Map();
    if (result && result.statusCode === 200) {
      const text = await streamToString(result.stream);
      const data = text ? JSON.parse(text) : {};
      for (const [k, row] of Object.entries(data || {})) {
        if (row && row.answerAfter) map.set(k, row);
      }
    }
    cache = { at: now, byKey: map };
    return map;
  } catch (e) {
    console.warn("pending-reply: load failed", (e && e.message) || e);
    cache.at = now;
    return cache.byKey;
  }
}

async function saveAll(map) {
  if (!blobEnabled()) {
    cache = { at: Date.now(), byKey: map };
    return false;
  }
  const out = {};
  for (const [k, row] of map.entries()) out[k] = row;
  const { put } = require("@vercel/blob");
  await put(BLOB_PATH, JSON.stringify(out), {
    access: "private",
    allowOverwrite: true,
    contentType: "application/json",
    addRandomSuffix: false,
  });
  cache = { at: Date.now(), byKey: map };
  return true;
}

function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/**
 * Schedule or merge a pending bot reply for chatKey.
 * parts: [{ text, messageId, channelId, chatType, source, error, provider }]
 */
async function schedule(chatKey, parts, opts) {
  opts = opts || {};
  const graceMs = Number(opts.graceMs) > 0 ? Number(opts.graceMs) : GRACE_MS;
  const now = Date.now();
  return withLock(async () => {
    const map = await loadAll(true);
    const prev = map.get(chatKey);
    const merged = [];
    if (prev && Array.isArray(prev.parts)) merged.push(...prev.parts);
    for (const p of parts || []) merged.push(p);
    // Cap history so a long idle spam session cannot grow forever.
    const trimmed = merged.slice(-40);
    const row = {
      chatId: (prev && prev.chatId) || opts.chatId || chatKey,
      chatKey,
      channelId: opts.channelId || (trimmed[0] && trimmed[0].channelId) || null,
      chatType: opts.chatType || (trimmed[0] && trimmed[0].chatType) || "whatsapp",
      parts: trimmed,
      createdAt: (prev && prev.createdAt) || now,
      // Each new customer message restarts the Phone grace window.
      answerAfter: now + graceMs,
      updatedAt: now,
    };
    map.set(chatKey, row);
    await saveAll(map);
    return row;
  });
}

async function cancel(chatKey) {
  if (!chatKey) return false;
  return withLock(async () => {
    const map = await loadAll(true);
    if (!map.has(chatKey)) return false;
    map.delete(chatKey);
    await saveAll(map);
    return true;
  });
}

async function cancelMany(chatKeys) {
  const keys = (chatKeys || []).filter(Boolean);
  if (!keys.length) return 0;
  return withLock(async () => {
    const map = await loadAll(true);
    let n = 0;
    for (const k of keys) {
      if (map.delete(k)) n++;
    }
    if (n) await saveAll(map);
    return n;
  });
}

/** Due rows ready for the bot to answer (answerAfter <= now). Removes them from store. */
async function takeDue(nowMs) {
  const now = nowMs || Date.now();
  return withLock(async () => {
    const map = await loadAll(true);
    const due = [];
    for (const [k, row] of map.entries()) {
      if (Number(row.answerAfter) <= now) {
        due.push(row);
        map.delete(k);
      }
    }
    if (due.length) await saveAll(map);
    return due;
  });
}

async function listAll() {
  const map = await loadAll(true);
  return [...map.values()];
}

module.exports = {
  GRACE_MS,
  schedule,
  cancel,
  cancelMany,
  takeDue,
  listAll,
  _internals: { loadAll, saveAll, BLOB_PATH, getCache: () => cache },
};
