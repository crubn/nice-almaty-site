const mute = require("../lib/manager-mute.js");

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("✅", name); }
  else { fail++; console.log("❌", name); }
}

const normalize = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") return "7" + d.slice(1);
  if (d.length === 10) return "7" + d;
  return d;
};

ok("default mute is 5 minutes", mute.DEFAULT_MUTE_MS === 5 * 60 * 1000);

ok("human echo is human outbound", mute.isHumanOutbound({ isEcho: true, chatId: "7701" }));
ok("phone isPhoneOutbound on isEcho", mute.isPhoneOutbound({ isEcho: true, chatId: "7701" }));
ok("wazzup UI is human but NOT phone", mute.isHumanOutbound({ sentFromApp: true, chatId: "7701" })
  && !mute.isPhoneOutbound({ sentFromApp: true, chatId: "7701" }));
ok("fromMe alone is NOT phone (ambiguous)", !mute.isPhoneOutbound({ fromMe: true, chatId: "7701" }));
ok("authorName alone is NOT phone without isEcho", !mute.isPhoneOutbound({ authorName: "Ассоль", chatId: "7701" }));
ok("plain inbound is not human outbound", !mute.isHumanOutbound({ isEcho: false, text: "hi" }));
ok("bot-like outbound without echo is not human", !mute.isHumanOutbound({ direction: "outbound", text: "hi" }));
ok("our bot crmMessageId is never phone/human",
  !mute.isPhoneOutbound({ isEcho: true, crmMessageId: "nice-bot-7701-abc", text: "bot" })
  && !mute.isHumanOutbound({ isEcho: true, crmMessageId: "nice-bot-7701-abc", text: "bot" }));
ok("isBotCrmMessage detects prefix", mute.isBotCrmMessage({ crmMessageId: "nice-bot-x" }));
ok("isBotCrmMessage rejects others", !mute.isBotCrmMessage({ crmMessageId: "crm-1" }));
ok("classify phone", mute.classifyOutbound({ isEcho: true, chatId: "1" }) === "phone");
ok("classify wazzup_ui", mute.classifyOutbound({ sentFromApp: true, chatId: "1" }) === "wazzup_ui");
ok("classify admin_api by crm id", mute.classifyOutbound({ crmMessageId: "nice-bot-1", direction: "outbound" }) === "admin_api");
ok("classify admin_api bare outbound", mute.classifyOutbound({ direction: "outbound", isEcho: false, text: "hi" }) === "admin_api");
ok("admin api outbound helper", mute.isAdminApiOutbound({ direction: "outbound", isEcho: false }));
ok("phone is not admin api", !mute.isAdminApiOutbound({ isEcho: true, text: "from phone" }));

mute.muteChat("87771112233", "test", normalize, 60_000);
ok("muted after muteChat", mute.isMuted("77771112233", normalize));
ok("muted with +7 format", mute.isMuted("+7 777 111 22 33", normalize));

mute.noteManagerActivity(
  [{ isEcho: true, chatId: "77009998877" }],
  { extractChatId: (m) => m.chatId, normalizePhone: normalize, isGroup: () => false }
);
ok("muted after Phone activity", mute.isMuted("77009998877", normalize));

mute.noteManagerActivity(
  [{ sentFromApp: true, chatId: "77005554433" }],
  { extractChatId: (m) => m.chatId, normalizePhone: normalize, isGroup: () => false }
);
ok("muted after wazzup UI activity", mute.isMuted("77005554433", normalize));

mute.noteManagerActivity(
  [{ direction: "outbound", isEcho: false, chatId: "77004443322", crmMessageId: "nice-bot-x", text: "бот" }],
  { extractChatId: (m) => m.chatId, normalizePhone: normalize, isGroup: () => false }
);
ok("admin api does not mute", !mute.isMuted("77004443322", normalize));

mute.setSheetMutes([{ phone: "77001234567", until: "2099-01-01" }], normalize);
ok("muted from sheet tab", mute.isMuted("77001234567", normalize));

const dmy = mute.parseUntil("31.12.2099", Date.now());
ok("parseUntil DD.MM.YYYY", dmy > Date.now() && new Date(dmy).getFullYear() === 2099);

ok("API-like outbound without echo is NOT human",
  !mute.isHumanOutbound({ direction: "outbound", isEcho: false, sentFromApp: false, text: "бот" }));

// Short mute expires → bot may answer again
mute.muteChat("77003334455", "phone", normalize, 30);
ok("short mute active", mute.isMuted("77003334455", normalize));
setTimeout(() => {
  ok("short mute expired → bot can answer", !mute.isMuted("77003334455", normalize));
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}, 50);
