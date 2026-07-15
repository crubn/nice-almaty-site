// Oracle tests for polite greeting enforcement in lib/bot.js
// Run: node test/tone.test.js

const bot = require("../lib/bot.js");

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log("✅ " + name); }
  else { fail++; console.log("❌ " + name + "\n   got:  " + JSON.stringify(got) + "\n   want: " + JSON.stringify(want)); }
}
function has(name, s, re) {
  if (re.test(s)) { pass++; console.log("✅ " + name); }
  else { fail++; console.log("❌ " + name + "\n   got: " + JSON.stringify(s)); }
}
function lacks(name, s, re) {
  if (!re.test(s)) { pass++; console.log("✅ " + name); }
  else { fail++; console.log("❌ " + name + " still matched\n   got: " + JSON.stringify(s)); }
}
function ok(name, cond) {
  if (cond) { pass++; console.log("✅ " + name); }
  else { fail++; console.log("❌ " + name); }
}

eq("Сәлем → Сәлеметсіз бе",
  bot.enforcePoliteGreeting("Сәлем! Жақын үй керек пе?"),
  "Сәлеметсіз бе! Жақын үй керек пе?");

eq("Салем latin-cyrillic mix → formal",
  bot.enforcePoliteGreeting("Салем! Қалайсыз?"),
  "Сәлеметсіз бе! Қалайсыз?");

eq("Сәлеметсіз бе left intact (no етсіз бе)",
  bot.enforcePoliteGreeting("Сәлеметсіз бе! МУИТке жақын үй бар."),
  "Сәлеметсіз бе! МУИТке жақын үй бар.");

eq("Саламатсыз ба → Сәлеметсіз бе",
  bot.enforcePoliteGreeting("Саламатсыз ба! Үй керек."),
  "Сәлеметсіз бе! Үй керек.");

eq("Привет → Здравствуйте",
  bot.enforcePoliteGreeting("Привет! Есть места?"),
  "Здравствуйте! Есть места?");

lacks("formal Сәлеметсіз бе kept (no bare Сәлем left)",
  bot.enforcePoliteGreeting("Сәлеметсіз бе! МУИТке жақын үй бар."),
  /(^|[^еЕ])Сәлем(?!ет)/u);

has("prompt forbids Сәлем",
  bot.buildSystemPrompt({ lang: "kz", channel: "whatsapp", booking: true }),
  /NEVER write «Сәлем»/);

has("prompt requires Сәлеметсіз бе",
  bot.buildSystemPrompt({ lang: "kz", channel: "whatsapp", booking: true }),
  /Сәлеметсіз бе/);

has("kz fallback is formal", bot.FALLBACK.kz, /^Сәлеметсіз бе/);
lacks("kz fallback has no bare Сәлем", bot.FALLBACK.kz, /(^|[^еЕ])Сәлем(?!ет)/u);

eq("strip Здравствуйте",
  bot.stripLeadingGreeting("Здравствуйте. После 23:00 тишина."),
  "После 23:00 тишина.");

eq("strip Сәлеметсіз бе",
  bot.stripLeadingGreeting("Сәлеметсіз бе! МУИТке жақын үй бар."),
  "МУИТке жақын үй бар.");

ok("detects formal greeting", bot.startsWithFormalGreeting("Здравствуйте! Есть места?"));
ok("skipGreeting in prompt when set",
  /Do NOT greet in this reply/.test(bot.buildSystemPrompt({ skipGreeting: true, channel: "whatsapp", booking: true })));

ok("whatsApp prompt forbids wa.me redirect",
  /NEVER send wa\.me links/.test(bot.buildSystemPrompt({ channel: "whatsapp", booking: true, skipGreeting: true })));

ok("web prompt may still mention wa.me",
  /wa\.me\/77770739990/.test(bot.buildSystemPrompt({ channel: "web", booking: false, skipGreeting: true })));

eq("strip wa.me from whatsapp replies",
  bot.stripWhatsAppRedirects("Менеджер подтвердит. https://wa.me/77770739990 Спасибо!"),
  "Менеджер подтвердит. Спасибо!");

ok("question is not a user greeting", !bot.userLooksLikeGreeting("Есть свободные места?"));
ok("salem is a user greeting", bot.userLooksLikeGreeting("Сәлеметсіз бе"));

ok("prompt forbids meta AI talk",
  /NEVER talk about yourself as an AI/.test(bot.buildSystemPrompt({ channel: "whatsapp", booking: true, skipGreeting: true })));
ok("prompt forbids tech stack answers",
  /стек технологий/.test(bot.buildSystemPrompt({ channel: "whatsapp", booking: true, skipGreeting: true })));

ok("meta: tech stack blocked", bot.isMetaQuestion("на каком стеке технологий вы сделаны"));
ok("meta: cheap model blocked", bot.isMetaQuestion("у вас дешевая модель? Долго обрабатывает"));
ok("meta: housing question allowed", !bot.isMetaQuestion("Есть ли свободные места в доме 2?"));

{
  const handoff = bot.stripManagerMarker("Передам менеджеру.\n[МЕНЕДЖЕР]");
  ok("strip [МЕНЕДЖЕР] marker text", handoff.text === "Передам менеджеру.");
  ok("strip [МЕНЕДЖЕР] marker flag", handoff.needsManager === true);
}

ok("handoff phrase flags manager",
  bot.stripManagerMarker("Я передам ваш вопрос менеджеру Nice Almaty, и он свяжется с вами в этом же чате.").needsManager);

ok("normal reply no manager flag",
  !bot.stripManagerMarker("В Доме 2 есть 1 свободное место за 55 000.").needsManager);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
