// Voice → text for WhatsApp (Wazzup) inbound audio.
//
// Downloads contentUri ASAP (Wazzup store links expire), then calls an
// OpenAI-compatible /audio/transcriptions endpoint:
//   OPENAI_API_KEY  → https://api.openai.com/v1  (model whisper-1)
//   GROQ_API_KEY    → https://api.groq.com/openai/v1  (whisper-large-v3)
// Overrides: WHISPER_API_KEY, WHISPER_BASE_URL, WHISPER_MODEL, WHISPER_LANGUAGE

const MAX_BYTES = 24 * 1024 * 1024; // Whisper hard limit is 25MB

function sttConfig() {
  const whisperKey = process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY;
  if (whisperKey) {
    return {
      provider: "openai",
      apiKey: whisperKey,
      baseUrl: (process.env.WHISPER_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: process.env.WHISPER_MODEL || "whisper-1",
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      provider: "groq",
      apiKey: process.env.GROQ_API_KEY,
      baseUrl: (process.env.WHISPER_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
      model: process.env.WHISPER_MODEL || "whisper-large-v3",
    };
  }
  return null;
}

function isConfigured() {
  return !!sttConfig();
}

function isAudioType(m) {
  const t = String((m && m.type) || "").toLowerCase();
  return t === "audio" || t === "ptt" || t === "voice";
}

function extractContentUri(m) {
  if (!m || typeof m !== "object") return "";
  return (
    (typeof m.contentUri === "string" && m.contentUri) ||
    (typeof m.content_uri === "string" && m.content_uri) ||
    (m.content && typeof m.content.uri === "string" && m.content.uri) ||
    (m.content && typeof m.content.url === "string" && m.content.url) ||
    ""
  );
}

function guessExt(mime, url) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  const fromUrl = /\.(ogg|opus|mp3|m4a|wav|webm|mpeg)(?:\?|$)/i.exec(String(url || ""));
  if (fromUrl) return fromUrl[1].toLowerCase() === "opus" ? "ogg" : fromUrl[1].toLowerCase();
  // WhatsApp voice notes are almost always ogg/opus; Wazzup sometimes uses .was
  return "ogg";
}

function mimeFromExt(ext) {
  if (ext === "mp3" || ext === "mpeg") return "audio/mpeg";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "wav") return "audio/wav";
  if (ext === "webm") return "audio/webm";
  return "audio/ogg";
}

async function downloadAudio(url) {
  if (!url) return { ok: false, reason: "no_uri" };
  const headers = {};
  if (process.env.WAZZUP_API_KEY) {
    headers.Authorization = "Bearer " + process.env.WAZZUP_API_KEY;
  }
  let res;
  try {
    res = await fetch(url, { headers, redirect: "follow" });
  } catch (e) {
    return { ok: false, reason: "download_error", detail: (e && e.message) || String(e) };
  }
  // Some store URLs are public; retry without auth if Bearer was rejected.
  if (!res.ok && headers.Authorization) {
    try {
      res = await fetch(url, { redirect: "follow" });
    } catch (e) {
      return { ok: false, reason: "download_error", detail: (e && e.message) || String(e) };
    }
  }
  if (!res.ok) {
    return { ok: false, reason: "download_http_" + res.status };
  }
  const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return { ok: false, reason: "empty_audio" };
  if (buf.length > MAX_BYTES) return { ok: false, reason: "too_large", bytes: buf.length };
  const ext = guessExt(mime, url);
  return {
    ok: true,
    buffer: buf,
    mime: mime || mimeFromExt(ext),
    filename: "voice." + ext,
  };
}

async function transcribeBuffer(buffer, mime, filename) {
  const cfg = sttConfig();
  if (!cfg) return { ok: false, reason: "no_stt_key" };

  const form = new FormData();
  const file = new File([buffer], filename || "voice.ogg", {
    type: mime || "audio/ogg",
  });
  form.append("file", file);
  form.append("model", cfg.model);
  // Leave language unset by default so Whisper can pick RU/KZ/EN.
  if (process.env.WHISPER_LANGUAGE) {
    form.append("language", process.env.WHISPER_LANGUAGE);
  }
  // Light domain hint (not forced language).
  form.append(
    "prompt",
    "Nice Almaty student housing, Алматы, университеты, комнаты, цены в тенге."
  );

  let res;
  try {
    res = await fetch(cfg.baseUrl + "/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.apiKey },
      body: form,
    });
  } catch (e) {
    return { ok: false, reason: "stt_network", detail: (e && e.message) || String(e) };
  }

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { /* plain text response */ }

  if (!res.ok) {
    const errMsg = (data && (data.error && data.error.message || data.error || data.message)) || raw.slice(0, 200);
    console.error("transcribe: stt failed", JSON.stringify({
      provider: cfg.provider,
      status: res.status,
      err: String(errMsg).slice(0, 300),
    }));
    return { ok: false, reason: "stt_http_" + res.status, detail: String(errMsg).slice(0, 300) };
  }

  const text = typeof data === "string"
    ? data
    : (data && typeof data.text === "string" ? data.text : (typeof raw === "string" ? raw : ""));
  const cleaned = String(text || "").trim();
  if (!cleaned) return { ok: false, reason: "empty_transcript" };
  return { ok: true, text: cleaned, provider: cfg.provider, model: cfg.model };
}

async function transcribeFromUri(contentUri) {
  const dl = await downloadAudio(contentUri);
  if (!dl.ok) {
    console.error("transcribe: download failed", JSON.stringify({ reason: dl.reason, detail: dl.detail || null }));
    return dl;
  }
  return transcribeBuffer(dl.buffer, dl.mime, dl.filename);
}

/** Turn one Wazzup message into plain text (transcribe audio if needed). */
async function resolveMessageText(m) {
  const existing = (
    (typeof m.text === "string" && m.text) ||
    (typeof m.body === "string" && m.body) ||
    ""
  ).trim();

  if (!isAudioType(m)) {
    return { text: existing, source: "text" };
  }

  // Caption + audio is rare; prefer STT of the audio itself.
  const uri = extractContentUri(m);
  if (!uri) {
    if (existing) return { text: existing, source: "text" };
    return { text: "", source: "audio", error: "no_uri" };
  }
  if (!isConfigured()) {
    return { text: "", source: "audio", error: "no_stt_key" };
  }
  const r = await transcribeFromUri(uri);
  if (r.ok && r.text) return { text: r.text, source: "audio", provider: r.provider };
  return { text: existing || "", source: "audio", error: r.reason || "fail" };
}

module.exports = {
  isConfigured,
  isAudioType,
  extractContentUri,
  resolveMessageText,
  transcribeFromUri,
  // for tests
  _internals: { sttConfig, guessExt, downloadAudio, transcribeBuffer },
};
