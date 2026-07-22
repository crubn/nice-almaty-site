// Auto-create Wazzup contacts on first inbound WhatsApp message.
//
 // Contact ids are sequential strings starting at 400 ("400", "401", …).
 // Mapping phone → contactId and the next free id live in Vercel Blob so every
 // serverless isolate shares the same counter.
 //
 // API: POST https://api.wazzup24.com/v3/contacts
 // Docs: https://wazzup24.com/help/api-en/working-with-contacts/

const WAZZUP_BASE = process.env.WAZZUP_API_BASE || "https://api.wazzup24.com/v3";
const BLOB_PATH = process.env.WA_CONTACTS_BLOB_PATH || "wa-contacts.json";
const START_ID = Number(process.env.WA_CONTACT_START_ID || 400);
const DEFAULT_USER_ID = process.env.WAZZUP_RESPONSIBLE_USER_ID || "nice-bot-owner";
const DEFAULT_USER_NAME = process.env.WAZZUP_RESPONSIBLE_USER_NAME || "Nice Almaty";

let chain = Promise.resolve();
let cache = { at: 0, nextId: START_ID, byPhone: new Map() };
const CACHE_TTL_MS = 5_000;
let responsibleUserIdCache = null;

function blobEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
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

function emptyState() {
  return { nextId: START_ID, byPhone: new Map() };
}

async function loadState(force) {
  const now = Date.now();
  if (!force && cache.at && now - cache.at < CACHE_TTL_MS) {
    return { nextId: cache.nextId, byPhone: cache.byPhone };
  }
  if (!blobEnabled()) {
    cache.at = now;
    return { nextId: cache.nextId, byPhone: cache.byPhone };
  }
  try {
    const { get } = require("@vercel/blob");
    const result = await get(BLOB_PATH, { access: "private", useCache: false });
    let nextId = START_ID;
    const byPhone = new Map();
    if (result && result.statusCode === 200) {
      const text = await streamToString(result.stream);
      const data = text ? JSON.parse(text) : {};
      nextId = Math.max(START_ID, Number(data.nextId) || START_ID);
      for (const [phone, id] of Object.entries(data.byPhone || {})) {
        if (phone && id != null) byPhone.set(String(phone), String(id));
      }
      // Keep counter above any already-assigned ids.
      for (const id of byPhone.values()) {
        const n = Number(id);
        if (Number.isFinite(n) && n >= nextId) nextId = n + 1;
      }
    }
    // Merge in-memory phones the blob may not have yet.
    for (const [phone, id] of cache.byPhone.entries()) {
      if (!byPhone.has(phone)) byPhone.set(phone, id);
    }
    if (cache.nextId > nextId) nextId = cache.nextId;
    cache = { at: now, nextId, byPhone };
    return { nextId, byPhone };
  } catch (e) {
    console.warn("wazzup-contacts: load failed", (e && e.message) || e);
    cache.at = now;
    return { nextId: cache.nextId, byPhone: cache.byPhone };
  }
}

async function saveState(nextId, byPhone) {
  cache = { at: Date.now(), nextId, byPhone };
  if (!blobEnabled()) return false;
  const out = { nextId, byPhone: {} };
  for (const [phone, id] of byPhone.entries()) out.byPhone[phone] = id;
  const { put } = require("@vercel/blob");
  await put(BLOB_PATH, JSON.stringify(out), {
    access: "private",
    allowOverwrite: true,
    contentType: "application/json",
    addRandomSuffix: false,
  });
  return true;
}

async function api(method, path, body) {
  const apiKey = process.env.WAZZUP_API_KEY;
  if (!apiKey) throw new Error("WAZZUP_API_KEY not set");
  const r = await fetch(`${WAZZUP_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  return { ok: r.ok, status: r.status, json, text };
}

/** Resolve responsibleUserId: env → existing Wazzup user → create default user. */
async function resolveResponsibleUserId() {
  if (process.env.WAZZUP_RESPONSIBLE_USER_ID) {
    return String(process.env.WAZZUP_RESPONSIBLE_USER_ID);
  }
  if (responsibleUserIdCache) return responsibleUserIdCache;

  const listed = await api("GET", "/users");
  if (listed.ok && Array.isArray(listed.json) && listed.json.length) {
    responsibleUserIdCache = String(listed.json[0].id);
    return responsibleUserIdCache;
  }

  // Ensure at least one CRM user exists (required by contacts API).
  const created = await api("POST", "/users", [{
    id: DEFAULT_USER_ID,
    name: DEFAULT_USER_NAME,
  }]);
  if (created.ok || created.status === 200 || created.status === 201) {
    responsibleUserIdCache = DEFAULT_USER_ID;
    return responsibleUserIdCache;
  }
  // Fallback: still try DEFAULT_USER_ID — Wazzup may already have it.
  console.warn("wazzup-contacts: users ensure failed", created.status, String(created.text || "").slice(0, 200));
  responsibleUserIdCache = DEFAULT_USER_ID;
  return responsibleUserIdCache;
}

/**
 * Ensure a Wazzup contact exists for this WhatsApp phone.
 * @param {string} phone normalized digits (e.g. 77052340280)
 * @param {{ name?: string, chatType?: string }} opts
 * @returns {Promise<{ contactId: string, created: boolean, skipped?: boolean }|null>}
 */
async function ensureContact(phone, opts) {
  opts = opts || {};
  const chatId = String(phone || "").replace(/\D/g, "");
  if (!chatId || chatId.length < 10) return null;
  if (!process.env.WAZZUP_API_KEY) {
    console.warn("wazzup-contacts: skip — no WAZZUP_API_KEY");
    return null;
  }

  return withLock(async () => {
    const state = await loadState(true);
    if (state.byPhone.has(chatId)) {
      return { contactId: state.byPhone.get(chatId), created: false, skipped: true };
    }

    const contactId = String(state.nextId);
    const nextId = state.nextId + 1;
    const responsibleUserId = await resolveResponsibleUserId();
    const name = String(opts.name || "").trim().slice(0, 200) || chatId;
    const chatType = opts.chatType || "whatsapp";

    const body = [{
      id: contactId,
      responsibleUserId,
      name,
      contactData: [{ chatType, chatId }],
    }];

    const res = await api("POST", "/contacts", body);
    if (!res.ok) {
      console.error("wazzup-contacts: create failed", res.status, String(res.text || "").slice(0, 300));
      // Still advance locally only on success — otherwise retry next message.
      return null;
    }

    state.byPhone.set(chatId, contactId);
    state.nextId = nextId;
    await saveState(state.nextId, state.byPhone);
    console.log("wazzup-contacts: created", JSON.stringify({
      contactId,
      chatId,
      name,
      responsibleUserId,
      nextId: state.nextId,
    }));
    return { contactId, created: true };
  });
}

module.exports = {
  ensureContact,
  resolveResponsibleUserId,
  START_ID,
  _internals: {
    loadState,
    saveState,
    emptyState,
    getCache: () => cache,
    BLOB_PATH,
  },
};
