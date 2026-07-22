const mute = require("../lib/manager-mute.js");
const botSends = require("../lib/bot-sends.js");

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

ok("phone isPhoneOutbound on isEcho", mute.isPhoneOutbound({ isEcho: true, chatId: "7701" }));
ok("isOurSend callback blocks phone",
  !mute.isPhoneOutbound({ isEcho: true, text: "hi" }, null, { isOurSend: () => true }));
ok("wazzup UI is NOT phone", !mute.isPhoneOutbound({ sentFromApp: true, chatId: "7701" }));
ok("plain inbound is not human", !mute.isHumanOutbound({ isEcho: false, text: "hi" }));
ok("nice-bot crm is never phone",
  !mute.isPhoneOutbound({ isEcho: true, crmMessageId: "nice-bot-x", text: "bot" }));
ok("classify phone", mute.classifyOutbound({ isEcho: true, chatId: "1" }) === "phone");
ok("classify our send as admin_api",
  mute.classifyOutbound({ isEcho: true, text: "x" }, null, { isOurSend: () => true }) === "admin_api");
ok("classify admin_api by crm", mute.classifyOutbound({ crmMessageId: "nice-bot-1", direction: "outbound" }) === "admin_api");

mute.muteChat("87771112233", "test", normalize, 60_000);
ok("muted after muteChat", mute.isMuted("77771112233", normalize));

mute.noteManagerActivity(
  [{ isEcho: true, chatId: "77009998877", text: "менеджер" }],
  { extractChatId: (m) => m.chatId, normalizePhone: normalize, isGroup: () => false }
);
ok("muted after real Phone", mute.isMuted("77009998877", normalize));

mute.noteManagerActivity(
  [{ isEcho: true, chatId: "77004443322", crmMessageId: "nice-bot-abc", text: "бот" }],
  { extractChatId: (m) => m.chatId, normalizePhone: normalize, isGroup: () => false }
);
ok("nice-bot echo does not mute", !mute.isMuted("77004443322", normalize));

(async () => {
  const key = "77001112233";
  await botSends.recordSend(key, {
    messageId: "msg-aaa",
    crmMessageId: "nice-bot-77001112233-1",
    text: "Свободные места: Дом 2 — 3 места",
  });
  ok("isOurSend by messageId",
    botSends.isOurSend({ messageId: "msg-aaa", isEcho: true, text: "other" }, key));
  ok("isOurSend by text fingerprint",
    botSends.isOurSend({
      isEcho: true,
      text: "Свободные места: Дом 2 — 3 места",
    }, key));
  ok("different text is not our send",
    !botSends.isOurSend({ isEcho: true, text: "совершенно другой текст менеджера" }, key));

  mute.noteManagerActivity(
    [{ isEcho: true, chatId: key, text: "Свободные места: Дом 2 — 3 места" }],
    {
      extractChatId: (m) => m.chatId,
      normalizePhone: normalize,
      isGroup: () => false,
      isOurSend: (m, k) => botSends.isOurSend(m, k),
    }
  );
  ok("registered bot text echo does not mute", !mute.isMuted(key, normalize));

  mute.noteManagerActivity(
    [{ isEcho: true, chatId: key, text: "Ок, сейчас подскажу по Satbayev" }],
    {
      extractChatId: (m) => m.chatId,
      normalizePhone: normalize,
      isGroup: () => false,
      isOurSend: (m, k) => botSends.isOurSend(m, k),
    }
  );
  ok("real manager text still mutes", mute.isMuted(key, normalize));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
