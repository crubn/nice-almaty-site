const contacts = require("../lib/wazzup-contacts.js");

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("✅", name); }
  else { fail++; console.log("❌", name); }
}

ok("START_ID is 400", contacts.START_ID === 400);

(async () => {
  // Unit-level: empty state bookkeeping without hitting live Wazzup
  // (no WAZZUP_API_KEY / no blob → ensureContact returns null safely)
  delete process.env.WAZZUP_API_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const r = await contacts.ensureContact("77001112233", { name: "Test" });
  ok("without API key returns null", r === null);

  // Simulate allocated ids in memory via internals
  const { saveState, loadState, getCache } = contacts._internals;
  await saveState(402, new Map([["77001112233", "400"], ["77002223344", "401"]]));
  const state = await loadState(true);
  ok("nextId preserved", state.nextId === 402);
  ok("phone map has 400", state.byPhone.get("77001112233") === "400");
  ok("cache nextId", getCache().nextId === 402);

  // Second ensure with API key mocked would create 402 — skip live call.
  // Re-ensure existing phone short-circuits when map has it — still needs API key check first.
  // With map hit we still enter withLock and return skipped without POST if key set...
  // Without key, ensureContact returns null before lock. That's fine.

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
