const assert = require("assert");
const mute = require("../lib/manager-mute.js");

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("✅", name); }
  else { fail++; console.log("❌", name); }
}

const norm = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") return "7" + d.slice(1);
  if (d.length === 10) return "7" + d;
  return d;
};

ok("human echo is human outbound", mute.isHumanOutbound({ isEcho: true, chatId: "7701" }));
ok("wazzup UI is human outbound", mute.isHumanOutbound({ sentFromApp: true, chatId: "7701" }));
ok("plain inbound is not human outbound", !mute.isHumanOutbound({ isEcho: false, text: "hi" }));
ok("bot-like outbound without echo is not human", !mute.isHumanOutbound({ direction: "outbound", text: "hi" }));

mute.muteChat("87771112233", "test", norm, 60_000);
ok("muted after muteChat", mute.isMuted("77771112233", norm));
ok("muted with +7 format", mute.isMuted("+7 777 111 22 33", norm));

mute.noteManagerActivity(
  [{ isEcho: true, chatId: "77009998877" }],
  { extractChatId: (m) => m.chatId, normalizePhone: norm, isGroup: () => false }
);
ok("muted after human echo activity", mute.isMuted("77009998877", norm));

mute.setSheetMutes([{ phone: "77001234567", until: "2099-01-01" }], norm);
ok("muted from sheet tab", mute.isMuted("77001234567", norm));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
