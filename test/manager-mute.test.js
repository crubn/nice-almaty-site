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

ok("human echo is human outbound", mute.isHumanOutbound({ isEcho: true, chatId: "7701" }));
ok("wazzup UI is human outbound", mute.isHumanOutbound({ sentFromApp: true, chatId: "7701" }));
ok("fromMe is human outbound", mute.isHumanOutbound({ fromMe: true, chatId: "7701" }));
ok("authorName is human outbound", mute.isHumanOutbound({ authorName: "Ассоль", chatId: "7701" }));
ok("plain inbound is not human outbound", !mute.isHumanOutbound({ isEcho: false, text: "hi" }));
ok("bot-like outbound without echo is not human", !mute.isHumanOutbound({ direction: "outbound", text: "hi" }));
ok("our bot crmMessageId is never human",
  !mute.isHumanOutbound({ isEcho: true, crmMessageId: "nice-bot-7701-abc", text: "bot" }));
ok("isBotCrmMessage detects prefix", mute.isBotCrmMessage({ crmMessageId: "nice-bot-x" }));
ok("isBotCrmMessage rejects others", !mute.isBotCrmMessage({ crmMessageId: "crm-1" }));

mute.muteChat("87771112233", "test", normalize, 60_000);
ok("muted after muteChat", mute.isMuted("77771112233", normalize));
ok("muted with +7 format", mute.isMuted("+7 777 111 22 33", normalize));

mute.noteManagerActivity(
  [{ isEcho: true, chatId: "77009998877" }],
  { extractChatId: (m) => m.chatId, normalizePhone: normalize, isGroup: () => false }
);
ok("muted after human echo activity", mute.isMuted("77009998877", normalize));

mute.noteManagerActivity(
  [{ authorName: "Manager", chatId: "77005554433" }],
  { extractChatId: (m) => m.chatId, normalizePhone: normalize, isGroup: () => false }
);
ok("muted after authorName activity", mute.isMuted("77005554433", normalize));

mute.setSheetMutes([{ phone: "77001234567", until: "2099-01-01" }], normalize);
ok("muted from sheet tab", mute.isMuted("77001234567", normalize));

const dmy = mute.parseUntil("31.12.2099", Date.now());
ok("parseUntil DD.MM.YYYY", dmy > Date.now() && new Date(dmy).getFullYear() === 2099);

ok("API-like outbound without echo is NOT human",
  !mute.isHumanOutbound({ direction: "outbound", isEcho: false, sentFromApp: false, text: "бот" }));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
