// Live data source for the Nice Almaty bot — reads a PUBLISHED Google Sheet
// (CSV via the gviz endpoint) so admins can edit availability + houses online,
// with no python, no commit and no redeploy.
//
// PRIVACY: the sheet is shared by public link, so it must contain NO personal
// data (no resident ФИО, no phones, no staff names, no street addresses — only
// district). The bot's grounding rules already forbid addresses on output.
//
// REFRESH: fetched on demand and cached in memory for SHEETS_TTL_MS (default
// 5 min). A warm serverless instance reuses the cache; after the TTL the next
// request refetches — effectively a sync every few minutes, no cron needed.
//
// RESILIENCE: getData() never throws. On any failure it returns the last good
// cache if present, else { ok:false } so the caller (lib/bot.js) falls back to
// the committed data/*.json + data/houses/dom-*.md baked into the deploy.
//
// Env:
//   SHEETS_ID          (required to enable) — the spreadsheet id from its URL
//   SHEETS_TTL_MS      (optional) cache lifetime, default 300000
//   SHEETS_TAB_ROOMS   (optional) default "Свободные места"
//   SHEETS_TAB_HOUSES  (optional) default "Дома"
//   SHEETS_TAB_ROUTES  (optional) default "Маршруты"

const { driveDirect } = require("./photos.js");

const SHEETS_ID = process.env.SHEETS_ID || "";
const TTL_MS = Number(process.env.SHEETS_TTL_MS || 5 * 60 * 1000);
const FETCH_TIMEOUT_MS = 8000;

const TABS = {
  rooms: process.env.SHEETS_TAB_ROOMS || "Свободные места",
  houses: process.env.SHEETS_TAB_HOUSES || "Дома",
  routes: process.env.SHEETS_TAB_ROUTES || "Маршруты",
  photos: process.env.SHEETS_TAB_PHOTOS || "Фото",
  universities: process.env.SHEETS_TAB_UNIS || "Университеты",
  faq: process.env.SHEETS_TAB_FAQ || "База знаний",
};

let cache = { data: null, at: 0 };

function gvizUrl(tab) {
  return `https://docs.google.com/spreadsheets/d/${SHEETS_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

// ── CSV parsing (RFC4180-ish: quotes, embedded commas/newlines, "" escapes) ──
function parseCSV(text) {
  const s = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows = [];
  let row = [], field = "", inQ = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Rows → array of objects keyed by the (trimmed) header cells. Blank rows dropped.
function toObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ""))
    .map((r) => {
      const o = {};
      header.forEach((h, idx) => { o[h] = r[idx] !== undefined ? String(r[idx]).trim() : ""; });
      return o;
    });
}

// ── field helpers ─────────────────────────────────────────────────────────────
// Look up a value by any of several accepted header spellings (case-insensitive).
// Also tolerates decorated headers like "ВУЗ\колледж", "Автобусы (номера)" or
// "Цена, тг" by comparing the part before the first separator (\ / ( ,).
function field(o, names) {
  const wanted = names.map((n) => n.toLowerCase().trim());
  const keys = Object.keys(o);
  for (const key of keys) if (wanted.includes(key.toLowerCase().trim())) return o[key];
  for (const key of keys) {
    const base = key.toLowerCase().trim().split(/[\\/(,]/)[0].trim();
    if (base && wanted.includes(base)) return o[key];
  }
  return "";
}

function num(v) {
  const s = String(v).replace(/[\s ₸]/g, "").replace(",", ".");
  if (s === "") return null;
  const f = Number(s);
  return Number.isFinite(f) ? f : null;
}

function yes(v) {
  return ["да", "yes", "true", "1", "+", "✓", "есть"].includes(String(v).trim().toLowerCase());
}

// A closed/repair house legitimately has no bus routes — it should still publish
// live (to reflect the status), not defer to the committed baseline.
function isClosed(status) {
  return /ремонт|закрыт|недоступ|не заселя/i.test(String(status || ""));
}

// 65000 → "65 000" (thin-space grouping) for nicer grounding text.
function fmtPrice(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// Defense-in-depth PII scrub for free-text sheet fields before they reach the
// model. The sheet is admin-edited and (by policy) must contain NO personal
// data, but an admin could slip up — so we mechanically strip the two things we
// can detect with high precision: phone numbers and marker-prefixed street
// addresses. NOTE: this is NOT applied to bus lists (those are digits by design)
// and it cannot catch a bare unmarked name — that stays a process rule (see
// SHEETS_SETUP.md). Districts are additionally stripped of address-like numbers.
function scrubPII(s) {
  if (!s) return s;
  let t = String(s);
  // KZ phone numbers (+7XXXXXXXXXX / 8XXXXXXXXXX, with optional separators).
  t = t.replace(/(?:\+7|\b8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-()]*\d{2}[\s\-()]*\d{2}\b/g, "[скрыто]");
  t = t.replace(/(?:\+7|\b8)\d{10}\b/g, "[скрыто]");
  // Explicit street addresses (marker word + the text right after it). NB: \b is
  // unreliable before Cyrillic (у/п aren't \w), so anchor with a letter lookbehind.
  // NB: only true STREET markers — NOT "мкр"/"микрорайон" (those name districts
  // we want to keep, e.g. "микрорайон Аксай-3").
  t = t.replace(
    /(?<![а-яёa-z])(?:ул\.?|улица|проспект|пр-?т|шоссе|переулок|пер\.|бульвар|street|str\.?|ave\.?|avenue)\s+[^\n,;.]{1,40}/giu,
    "(адрес — у менеджера)"
  );
  return t;
}

// District: only phone/marker-address scrub. We deliberately DON'T strip bare
// numbers — many real Almaty districts carry them (Самал-2, Орбита-1, 8 мкр),
// so blanket digit removal corrupted legitimate names. A bare "Street 10" typed
// into Район стays a process rule (SHEETS_SETUP.md), not a code guarantee.
function scrubDistrict(s) {
  return scrubPII(String(s || "")).replace(/\s{2,}/g, " ").trim();
}

// Split a multi-item cell (advantages) on newlines, ";" or "|". Strips a leading
// bullet char (* • -) admins often type, so it doesn't leak into the text.
function splitLines(v) {
  return String(v)
    .split(/[\n;|]+/)
    .map((s) => s.trim().replace(/^[*•\-]\s*/, "").trim())
    .filter(Boolean);
}

// Split a comma/semicolon/newline list (keywords, recommended houses).
function splitList(v) {
  return String(v)
    .split(/[,;\n|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Drop empty/blank fields from an object.
function prune(o) {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== "" && v != null && !(Array.isArray(v) && !v.length))
  );
}

// "1" → "Дом 1"; "Дом 2" → "Дом 2" (so rooms/routes/houses match by the same key).
function houseName(v) {
  const s = String(v).trim();
  if (!s) return "";
  return /^\d+$/.test(s) ? `Дом ${s}` : s;
}

// ── row mappers ───────────────────────────────────────────────────────────────
function mapRooms(objs) {
  const out = [];
  for (const o of objs) {
    const house = houseName(field(o, ["Дом", "House", "Дом №"]));
    if (!house) continue;
    const row = {
      house,
      gender: field(o, ["Пол", "Gender"]),
      roomType: field(o, ["Тип комнаты", "Тип", "roomType", "Комната"]),
      floor: field(o, ["Этаж", "Floor"]),
      totalPlaces: num(field(o, ["Всего мест", "Всего", "totalPlaces"])),
      free: num(field(o, ["Свободно", "Свободных", "free"])),
      price: num(field(o, ["Цена", "price"])),
      status: field(o, ["Статус", "status"]),
      note: scrubPII(field(o, ["Заметка", "Примечание", "note"])),
    };
    out.push(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== "" && v !== null)));
  }
  return out;
}

function mapHouses(objs) {
  const out = [];
  for (const o of objs) {
    const name = houseName(field(o, ["Дом", "House", "Дом №", "№"]));
    if (!name) continue;
    out.push({
      name,
      district: scrubDistrict(field(o, ["Район", "District"])),
      gender: field(o, ["Пол", "Gender"]),
      status: field(o, ["Статус", "Status"]),
      wifi: yes(field(o, ["Wi-Fi", "WiFi", "Вайфай", "Интернет"])),
      kitchen: yes(field(o, ["Кухня", "Kitchen"])),
      laundry: yes(field(o, ["Стиралка", "Стиральная машина", "Laundry"])),
      amenitiesExtra: scrubPII(field(o, ["Доп.удобства", "Доп удобства", "Ещё удобства", "Extra"])),
      description: scrubPII(field(o, ["Описание", "Description"])),
      advantages: splitLines(field(o, ["Преимущества", "Плюсы", "Advantages"])).map(scrubPII),
      priceFrom: num(field(o, ["Цена от", "Цена От", "priceFrom"])),
      priceTo: num(field(o, ["Цена до", "Цена До", "priceTo"])),
    });
  }
  return out;
}

function mapUniversities(objs) {
  const out = [];
  for (const o of objs) {
    const name = field(o, ["ВУЗ", "Вуз", "Университет", "University", "Name"]);
    if (!name) continue;
    out.push(prune({
      name,
      type: field(o, ["Тип", "Type"]),
      keywords: splitList(field(o, ["Ключевые слова", "Keywords", "Ключевые"])),
      recommendedHouses: splitList(field(o, ["Рекомендуемые дома", "Дома", "Recommended"])),
      travelTime: field(o, ["Время в пути", "Время", "TravelTime"]),
      comment: scrubPII(field(o, ["Комментарий", "Comment"])),
    }));
  }
  return out;
}

function mapFaq(objs) {
  const out = [];
  for (const o of objs) {
    const question = field(o, ["Вопрос", "Question"]);
    if (!question) continue;
    out.push(prune({
      category: field(o, ["Категория", "Category"]),
      question: scrubPII(question),
      answer: scrubPII(field(o, ["Ответ", "Answer"])),
      keywords: splitList(field(o, ["Ключевые слова", "Keywords"])),
    }));
  }
  return out;
}

function mapPhotos(objs) {
  const out = [];
  for (const o of objs) {
    const house = houseName(field(o, ["Дом", "House"]));
    const url = field(o, ["URL", "Ссылка", "Фото", "Link", "Image"]);
    if (!house || !url) continue;
    const direct = driveDirect(url);
    // Security: only http(s) image URLs may reach the widget/WhatsApp — blocks
    // javascript:/data: etc. that an admin could paste into the sheet.
    if (!/^https?:\/\//i.test(direct.webUrl) || !/^https?:\/\//i.test(direct.mediaUrl)) continue;
    out.push({
      house,
      webUrl: direct.webUrl,
      mediaUrl: direct.mediaUrl,
      caption: scrubPII(field(o, ["Подпись", "Caption", "Описание", "Название"])),
    });
  }
  return out;
}

function mapRoutes(objs) {
  const out = [];
  for (const o of objs) {
    const house = houseName(field(o, ["Дом", "House"]));
    const uni = field(o, ["ВУЗ", "Вуз", "Университет", "University"]);
    if (!house || !uni) continue;
    out.push({
      house,
      uni,
      buses: field(o, ["Автобусы", "Автобус", "Buses", "Транспорт"]),
      minutes: field(o, ["~минуты", "Минуты", "Время", "Minutes", "мин"]),
    });
  }
  return out;
}

// Render one house block in the SAME shape as data/houses/dom-*.md so the model
// gets identical grounding whether the source is the sheet or the .md fallback.
function buildHouseText(h, routes) {
  const lines = [`# ${h.name}`, ""];
  if (h.district) lines.push(`- Район: ${h.district}`);
  if (h.gender) lines.push(`- Пол: ${h.gender}`);
  if (h.status) lines.push(`- Статус: ${h.status}`);

  const am = [];
  if (h.wifi) am.push("Wi-Fi");
  if (h.kitchen) am.push("кухня");
  if (h.laundry) am.push("стиральная машина");
  if (h.amenitiesExtra) am.push(h.amenitiesExtra);
  if (am.length) lines.push(`- Удобства: ${am.join(", ")}`);

  if (h.description) lines.push("", "## Описание", h.description);

  if (h.advantages && h.advantages.length) {
    lines.push("", "## Преимущества");
    for (const a of h.advantages) lines.push(`- ${a}`);
  }

  lines.push("", "## Комнаты и цены");
  if (h.priceFrom && h.priceTo) lines.push(`- Диапазон: ${fmtPrice(h.priceFrom)} – ${fmtPrice(h.priceTo)} ₸ / место в месяц`);
  else if (h.priceFrom) lines.push(`- От ${fmtPrice(h.priceFrom)} ₸ / место в месяц`);
  lines.push("- Точное наличие мест смотри в блоке «свободные места» — если комнаты там нет, наличие зависит от даты заезда (спроси дату).");

  const rr = routes.filter((r) => r.house === h.name);
  if (rr.length) {
    lines.push("", "## Вузы и автобусы (реальные маршруты)");
    for (const r of rr) {
      const rawMin = String(r.minutes).replace(/\s*(мин[а-я]*|min[a-z]*)\.?$/i, "").trim();
      const mins = rawMin ? ` — ~${rawMin} мин` : "";
      lines.push(`- ${r.uni} — ${r.buses}${mins}`);
    }
  }

  lines.push("", "## Нельзя сообщать", "- Точный адрес / улицу / номер дома — только район. Адрес и просмотр — через менеджера.");
  return lines.join("\n").trim();
}

// ── fetching ──────────────────────────────────────────────────────────────────
async function fetchCsvSafe(tab) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let text;
    try {
      const r = await fetch(gvizUrl(tab), { signal: controller.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      text = await r.text();
    } finally { clearTimeout(t); }
    // Distinguish a genuine EMPTY tab ("") from a FAILURE (null). A missing/
    // forbidden tab returns an HTML error page — that's a failure, not "no rows".
    if (text && text.trim().startsWith("<")) return null;
    return text || "";
  } catch (e) {
    console.error(`sheets: tab "${tab}" fetch failed —`, (e && e.message) || e);
    return null;
  }
}

// Public API. Returns { ok, generatedAt, rooms:[], houseTexts:[] }.
// Per-field emptiness is the caller's cue to fall back — an empty tab does not
// wipe data, it just defers that field to the committed baseline.
async function getData() {
  if (!SHEETS_ID) return { ok: false, reason: "no_sheet_id" };

  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) return cache.data;

  try {
    const [roomsCsv, housesCsv, routesCsv, photosCsv, unisCsv, faqCsv] = await Promise.all([
      fetchCsvSafe(TABS.rooms),
      fetchCsvSafe(TABS.houses),
      fetchCsvSafe(TABS.routes),
      fetchCsvSafe(TABS.photos),
      fetchCsvSafe(TABS.universities),
      fetchCsvSafe(TABS.faq),
    ]);

    const rooms = mapRooms(toObjects(parseCSV(roomsCsv || "")));
    const photos = mapPhotos(toObjects(parseCSV(photosCsv || "")));
    const universities = mapUniversities(toObjects(parseCSV(unisCsv || "")));
    const faq = mapFaq(toObjects(parseCSV(faqCsv || "")));

    // Live houses require BOTH the Дома AND Маршруты tabs to have loaded. If the
    // routes tab failed (null), emitting route-less house blocks would override
    // committed dom-*.md that DO have routes — so defer houses to the baseline.
    let houseTexts = [];
    if (housesCsv !== null && routesCsv !== null) {
      const routes = mapRoutes(toObjects(parseCSV(routesCsv || "")));
      const houseRows = mapHouses(toObjects(parseCSV(housesCsv || "")));
      const routed = new Set(routes.map((r) => r.house));
      // Publish a live block PER HOUSE only if THAT house has >=1 route OR it is
      // closed/under repair (those legitimately have no routes). A house whose
      // routes are just missing (accident / not yet filled) is deferred to its
      // committed dom-*.md, so we never override a house and drop its route
      // grounding. Empty Маршруты tab ⇒ all open houses deferred.
      const keep = (h) => routed.has(h.name) || isClosed(h.status);
      const skipped = houseRows.filter((h) => !keep(h)).map((h) => h.name);
      if (skipped.length) console.warn("sheets: no routes for " + skipped.join(", ") + " — deferred to committed baseline");
      houseTexts = houseRows.filter(keep).map((h) => buildHouseText(h, routes));
    } else if (housesCsv !== null) {
      console.warn("sheets: Маршруты tab unavailable — houses deferred to committed baseline");
    }

    if (!rooms.length && !houseTexts.length && !photos.length) {
      // Nothing usable came back — keep any prior good cache, else signal fallback.
      return cache.data || { ok: false, reason: "empty" };
    }

    const data = {
      ok: true,
      generatedAt: new Date().toISOString().slice(0, 10),
      rooms,
      houseTexts,
      photos,
      universities,
      faq,
    };
    cache = { data, at: now };
    return data;
  } catch (e) {
    console.error("sheets: getData failed —", (e && e.message) || e);
    return cache.data || { ok: false, reason: "exception" };
  }
}

module.exports = {
  getData,
  // exported for unit tests
  _internals: { parseCSV, toObjects, mapRooms, mapHouses, mapRoutes, buildHouseText, houseName },
};
