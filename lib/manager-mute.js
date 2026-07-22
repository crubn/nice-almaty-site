// Per-chat mute so the WhatsApp bot does not reply while a human manager is active.
//
// Rules (Phone vs bot):
//   • Bot answers immediately by default (normal debounce only).
//   • When Phone writes (Wazzup isEcho=true — handset/iframe, NOT Admin API),
//     mute that chat for 5 minutes. Each new Phone message restarts the 5-min window.
//   • While muted, customer messages are ignored. After 5 min without Phone → bot
//     answers again normally.
//   • Wazzup UI (sentFromApp) also mutes. Admin API echoes never mute.
//   • Bot handoff [МЕНЕДЖЕР] also mutes for the same window.
//
// Durable store: Vercel Blob (+ optional sheet tab «Молчит бот»).

const fs = require("fs");
const path = require("path");

const MUTE_FILE = process.env.WA_MUTE_FILE || "/tmp/wa-manager-mute.json";
const BLOB_PATH = process.env.WA_MUTE_BLOB_PATH || "wa-manager-mute.json";
// How long bot stays silent after Phone last wrote (default 5 minutes).
const DEFAULT_MUTE_MS = Number(process.env.WA_MANAGER_MUTE_MS || 5 * 60 * 1000);
const SHEET_REFRESH_MS = Number(process.env.WA_MUTE_SHEET_TTL_MS || 60_000);
const REMOTE_REFRESH_MS = Number(process.env.WA_MUTE_BLOB_TTL_MS || 3_000);

const MEM = new Map(); // key -> untilMs
let sheetCache = { at: 0, untilByPhone: new Map() };
let remoteCache = { at: 0, untilByPhone: new Map(), etag: null };
let persistChain = Promise.resolve(); // serialize blob read-modify-write

function chatKey(chatId, normalizePhone) {
  const n = typeof normalizePhone === "function" ? normalizePhone(chatId) : "";
  return n || String(chatId || "").trim();
}

function loadFile() {
  try {
    if (!fs.existsSync(MUTE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(MUTE_FILE, "utf8"));
    const now = Date.now();
    for (const [k, until] of Object.entries(data || {})) {
      if (Number(until) > now) MEM.set(k, Number(until));
    }
  } catch (e) { /* ignore */ }
}

function saveFile() {
  try {
    const now = Date.now();
    const out = {};
    for (const [k, until] of MEM.entries()) {
      if (until > now) out[k] = until;
      else MEM.delete(k);
    }
    fs.mkdirSync(path.dirname(MUTE_FILE), { recursive: true });
    fs.writeFileSync(MUTE_FILE, JSON.stringify(out));
  } catch (e) { /* ignore */ }
}

loadFile();

function blobEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

async function streamToString(stream) {
  if (!stream) return "";
  // Node 18+: Web ReadableStream or Node stream
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

function mergeRemoteIntoMem(map) {
  const now = Date.now();
  for (const [k, until] of map.entries()) {
    if (Number(until) > now) {
      const prev = MEM.get(k) || 0;
      if (Number(until) > prev) MEM.set(k, Number(until));
    }
  }
}

/** Pull shared mutes from Vercel Blob into MEM + remoteCache. */
async function refreshRemote(opts) {
  opts = opts || {};
  if (!blobEnabled()) return false;
  const force = opts.force === true;
  const now = Date.now();
  if (!force && remoteCache.at && now - remoteCache.at < REMOTE_REFRESH_MS) return false;
  try {
    const { get } = require("@vercel/blob");
    const result = await get(BLOB_PATH, {
      access: "private",
      useCache: false,
    });
    if (!result) {
      remoteCache = { at: now, untilByPhone: new Map(), etag: null };
      return true;
    }
    if (result.statusCode === 304) {
      remoteCache.at = now;
      return false;
    }
    const text = await streamToString(result.stream);
    const data = text ? JSON.parse(text) : {};
    const map = new Map();
    for (const [k, until] of Object.entries(data || {})) {
      if (Number(until) > now) map.set(k, Number(until));
    }
    remoteCache = {
      at: now,
      untilByPhone: map,
      etag: (result.blob && result.blob.etag) || null,
    };
    mergeRemoteIntoMem(map);
    return true;
  } catch (e) {
    console.warn("mute-blob: refresh failed", (e && e.message) || e);
    remoteCache.at = now; // back off
    return false;
  }
}

/** Merge local MEM into blob (serialized). */
async function persistRemote() {
  if (!blobEnabled()) return false;
  // Queue so concurrent muteChat calls don't clobber each other.
  const run = persistChain.then(async () => {
    try {
      await refreshRemote({ force: true });
      const now = Date.now();
      const out = {};
      for (const [k, until] of remoteCache.untilByPhone.entries()) {
        if (until > now) out[k] = until;
      }
      for (const [k, until] of MEM.entries()) {
        if (until > now && (!out[k] || until > out[k])) out[k] = until;
      }
      // Drop expired from MEM
      for (const [k, until] of MEM.entries()) {
        if (until <= now) MEM.delete(k);
      }
      const { put } = require("@vercel/blob");
      await put(BLOB_PATH, JSON.stringify(out), {
        access: "private",
        allowOverwrite: true,
        contentType: "application/json",
        addRandomSuffix: false,
      });
      const map = new Map();
      for (const [k, until] of Object.entries(out)) map.set(k, until);
      remoteCache = { at: Date.now(), untilByPhone: map, etag: null };
      return true;
    } catch (e) {
      console.warn("mute-blob: persist failed", (e && e.message) || e);
      return false;
    }
  });
  // Keep chain alive even on failure
  persistChain = run.catch(() => {});
  return run;
}

function muteChat(chatId, reason, normalizePhone, muteMs) {
  const key = chatKey(chatId, normalizePhone);
  if (!key) return null;
  const ms = Number(muteMs) > 0 ? Number(muteMs) : DEFAULT_MUTE_MS;
  // Always restart the silence window from now (each Phone message = fresh 5 min).
  const until = Date.now() + ms;
  MEM.set(key, until);
  saveFile();
  return { key, until, reason: reason || "mute" };
}

/** Sync mute + fire-and-forget blob persist (prefer muteChatAsync in webhook). */
function muteChatSync(chatId, reason, normalizePhone, muteMs) {
  const row = muteChat(chatId, reason, normalizePhone, muteMs);
  if (row) persistRemote().catch(() => {});
  return row;
}

/** Mute and wait until shared blob is updated (cross-isolate safe). */
async function muteChatAsync(chatId, reason, normalizePhone, muteMs) {
  const row = muteChat(chatId, reason, normalizePhone, muteMs);
  if (row) await persistRemote();
  return row;
}

function isMuted(chatId, normalizePhone) {
  const key = chatKey(chatId, normalizePhone);
  if (!key) return false;
  const now = Date.now();
  const memUntil = MEM.get(key);
  if (memUntil) {
    if (memUntil > now) return true;
    MEM.delete(key);
    saveFile();
  }
  const remoteUntil = remoteCache.untilByPhone.get(key);
  if (remoteUntil && remoteUntil > now) return true;
  const sheetUntil = sheetCache.untilByPhone.get(key);
  if (sheetUntil && sheetUntil > now) return true;
  return false;
}

/** Refresh shared stores then check mute. */
async function isMutedAsync(chatId, normalizePhone, opts) {
  opts = opts || {};
  await refreshRemote({ force: opts.force === true });
  return isMuted(chatId, normalizePhone);
}

function isBotCrmMessage(m) {
  const crm = String((m && (m.crmMessageId || m.crm_message_id)) || "");
  return crm.startsWith("nice-bot-");
}

/**
 * Outbound from our Admin API (POST /v3/message), not a human on Phone.
 * Wazzup echoes these back with isEcho=false; we tag them with crmMessageId nice-bot-*.
 */
function isAdminApiOutbound(m) {
  if (!m || typeof m !== "object") return false;
  if (isBotCrmMessage(m)) return true;
  // Explicit non-API signals → not Admin API.
  if (m.isEcho === true) return false;
  if (m.sentFromApp === true) return false;
  // Bare outbound without Phone/UI flags is the typical API echo shape.
  // Only treat as API when it looks outbound AND has no human author.
  const outbound =
    m.fromMe === true
    || m.isFromCrm === true
    || m.inbound === false
    || m.direction === "outbound"
    || (typeof m.status === "string" && /^(sent|delivered|read|outbound)$/i.test(m.status));
  if (!outbound) return false;
  if (m.authorName || m.authorId) return false;
  return true;
}

/**
 * Human typing on the linked WhatsApp Phone (or Wazzup iframe) — NOT Admin API.
 * Wazzup docs: isEcho=true → "outgoing, sent not from this API (from a phone or iFrame)".
 * sentFromApp is Wazzup native chat UI (also human, not Phone) — tracked separately.
 */
function isPhoneOutbound(m, isGroupFn) {
  if (!m || typeof m !== "object") return false;
  if (typeof isGroupFn === "function" && isGroupFn(m)) return false;
  if (isAdminApiOutbound(m) || isBotCrmMessage(m)) return false;
  // Exact Phone/iFrame signal from Wazzup.
  if (m.isEcho === true) return true;
  return false;
}

/** Human manager (Phone or Wazzup UI) — never Admin API. */
function isHumanOutbound(m, isGroupFn) {
  if (!m || typeof m !== "object") return false;
  if (typeof isGroupFn === "function" && isGroupFn(m)) return false;
  if (isAdminApiOutbound(m) || isBotCrmMessage(m)) return false;
  if (isPhoneOutbound(m, isGroupFn)) return true;
  // Wazzup native chat UI — human, but not the Phone handset.
  if (m.sentFromApp === true) return true;
  return false;
}

function classifyOutbound(m, isGroupFn) {
  if (!m || typeof m !== "object") return "unknown";
  if (typeof isGroupFn === "function" && isGroupFn(m)) return "group";
  if (isBotCrmMessage(m) || isAdminApiOutbound(m)) return "admin_api";
  if (isPhoneOutbound(m, isGroupFn)) return "phone";
  if (m.sentFromApp === true) return "wazzup_ui";
  return "other";
}

function noteManagerActivity(messages, opts) {
  opts = opts || {};
  const extractChatId = opts.extractChatId;
  const normalizePhone = opts.normalizePhone;
  const isGroupFn = opts.isGroup;
  // Mute only when Phone (or Wazzup UI) writes — never on Admin API echoes.
  const muted = [];
  for (const m of messages || []) {
    const kind = classifyOutbound(m, isGroupFn);
    if (kind !== "phone" && kind !== "wazzup_ui") continue;
    const id = typeof extractChatId === "function" ? extractChatId(m) : "";
    if (!id) continue;
    const reason = kind === "phone" ? "phone" : "wazzup_ui";
    const row = muteChat(id, reason, normalizePhone);
    if (row) muted.push(Object.assign({ kind }, row));
  }
  return muted;
}

/** Like noteManagerActivity but awaits blob persist when anything was muted. */
async function noteManagerActivityAsync(messages, opts) {
  const muted = noteManagerActivity(messages, opts);
  if (muted.length) await persistRemote();
  return muted;
}

function parseUntil(raw, now) {
  const s = String(raw || "").trim();
  if (!s) return now + DEFAULT_MUTE_MS;
  // ISO / Date.parse-friendly first.
  let until = Date.parse(s);
  if (Number.isFinite(until)) return until;
  // Common spreadsheet forms: DD.MM.YYYY or DD/MM/YYYY (+ optional time).
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]) - 1;
    const yyyy = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 23;
    const mi = m[5] != null ? Number(m[5]) : 59;
    until = new Date(yyyy, mm, dd, hh, mi, 59).getTime();
    if (Number.isFinite(until)) return until;
  }
  // Bare year → mute until end of that year.
  if (/^\d{4}$/.test(s)) {
    until = new Date(Number(s), 11, 31, 23, 59, 59).getTime();
    if (Number.isFinite(until)) return until;
  }
  return now + DEFAULT_MUTE_MS;
}

/** Merge phones from sheet objects [{phone|Телефон, until|Until|До}, ...]. */
function setSheetMutes(rows, normalizePhone) {
  const map = new Map();
  const now = Date.now();
  for (const o of rows || []) {
    const raw = o.phone || o.Phone || o["Телефон"] || o["телефон"] || o["Номер"] || "";
    const key = chatKey(raw, normalizePhone);
    if (!key) continue;
    const until = parseUntil(o.until || o.Until || o["До"] || o["until"] || "", now);
    if (until > now) map.set(key, until);
  }
  sheetCache = { at: now, untilByPhone: map };
  return map.size;
}

/** Call after a failed sheet fetch so we don't hammer Google every message. */
function markSheetFetchAttempt() {
  sheetCache = { at: Date.now(), untilByPhone: sheetCache.untilByPhone };
}

function sheetCacheStale() {
  return Date.now() - sheetCache.at > SHEET_REFRESH_MS;
}

module.exports = {
  muteChat,
  muteChatSync,
  muteChatAsync,
  isMuted,
  isMutedAsync,
  isHumanOutbound,
  isPhoneOutbound,
  isAdminApiOutbound,
  isBotCrmMessage,
  classifyOutbound,
  noteManagerActivity,
  noteManagerActivityAsync,
  setSheetMutes,
  markSheetFetchAttempt,
  sheetCacheStale,
  refreshRemote,
  persistRemote,
  parseUntil,
  chatKey,
  DEFAULT_MUTE_MS,
  _internals: {
    MEM,
    loadFile,
    saveFile,
    getSheetCache: () => sheetCache,
    getRemoteCache: () => remoteCache,
    BLOB_PATH,
  },
};
