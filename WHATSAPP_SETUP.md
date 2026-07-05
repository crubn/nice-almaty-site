# WhatsApp AI bot via Wazzup24 — setup, test, and kill switch

The website chat and the WhatsApp bot share the same brain ([lib/bot.js](lib/bot.js))
and the same data ([data/availability.json](data/availability.json) +
[data/site-facts.json](data/site-facts.json)). No residents' names (ФИО) are ever sent.

> **This bot talks to real customers on your WhatsApp.** Read the "Kill switch" and
> "Safety notes" sections before you register the webhook.

---

## 1. Connect WhatsApp Business to Wazzup

1. Create an account at **wazzup24.com** and open the dashboard.
2. **Add channel → WhatsApp.** Wazzup shows a QR code.
3. On the phone with your **WhatsApp Business** app: **Settings → Linked devices →
   Link a device →** scan the QR. (Keep that phone online — this connects the app,
   not the official WhatsApp Business API.)
4. Once the channel shows **connected**, note its **channelId** (step 3 below prints it).

## 2. Get your Wazzup API key

In the Wazzup dashboard: **Settings → API / Integrations → create an API key**
(a "developer"/API integration). Copy the key.

## 3. Set environment variables on Vercel

Project → **Settings → Environment Variables** (or `vercel env add`):

| Variable | Required | Purpose |
|----------|:---:|---------|
| `DEEPSEEK_API_KEY` | yes | DeepSeek model key (same one the web chat uses) |
| `DEEPSEEK_MODEL` | no | Exact "V4 Flash" model id (default `deepseek-chat`) |
| `WAZZUP_API_KEY` | yes | Wazzup API key from step 2 |
| `WAZZUP_CHANNEL_ID` | yes | Your WhatsApp channel id (find it: `channels` below) |
| `WAZZUP_WEBHOOK_SECRET` | strongly rec. | Random string; added to the webhook URL so only Wazzup can trigger it |
| `WA_BOT_ENABLED` | no | Set to `false` to mute the bot (backup kill switch; needs redeploy) |
| `EDGE_CONFIG` | no | Enables the **instant** kill switch (see below) |

Find your channel id after deploying:

```bash
WAZZUP_API_KEY=xxx node scripts/wazzup.js channels
```

## 4. Register the webhook

Deploy first (so the URL exists), then point Wazzup at it — include your secret:

```bash
WAZZUP_API_KEY=xxx node scripts/wazzup.js set-webhook \
  "https://YOUR-APP.vercel.app/api/wazzup-webhook?secret=YOUR_WEBHOOK_SECRET"
```

Wazzup sends a `{test:true}` ping; the endpoint replies `200`. Verify with:

```bash
WAZZUP_API_KEY=xxx node scripts/wazzup.js get-webhook
```

## 5. Test

- Send a WhatsApp message to your business number from another phone:
  *"есть свободные места?"* → the bot should reply from the live table.
- Or send a message **as** the bot to a test number:
  `WAZZUP_API_KEY=xxx WAZZUP_CHANNEL_ID=xxx node scripts/wazzup.js send 77770739990 "тест"`
- Watch logs: `vercel logs YOUR-APP.vercel.app` — every inbound/outbound line is logged
  (`wazzup: inbound …` / `wazzup: replied …`). The **first real inbound** confirms the
  exact Wazzup payload field names; the webhook parses them defensively, but check the
  log once and tell me if `chatId`/`text` land somewhere unexpected.

---

## Kill switch — turn it off immediately

**Fastest (no code, non-technical):**
- Wazzup dashboard → **disable the channel** or remove the webhook. The bot stops
  receiving anything. This is the hard off.
- Or run: `WAZZUP_API_KEY=xxx node scripts/wazzup.js disable-webhook`

**Instant soft-mute (keep the channel, silence the AI), no redeploy:**
- Set up a **Vercel Edge Config** store, add key `waBotEnabled` = `false`, and set the
  project's `EDGE_CONFIG` connection string. The webhook reads it on every message and
  goes silent within ~1s of you flipping the value. Flip back to `true` to resume.

**Backup (needs a redeploy):**
- Set `WA_BOT_ENABLED=false` in Vercel env and redeploy.

## Safety notes

- **Secret guard:** without `?secret=` matching `WAZZUP_WEBHOOK_SECRET`, the webhook
  returns 401 — random traffic can't run up DeepSeek cost or send WhatsApp messages.
- **Filtered:** the bot ignores group chats, non-text messages, and its own/outbound
  messages (no reply loops).
- **Booking:** the bot guides booking and collects details, but is told it **cannot
  finalize a reservation** — it hands final confirmation to a human manager. It never
  claims a specific bed is locked.
- **Privacy:** residents' names never leave the table; only availability counts, room
  statuses, and booking dates are in the data the model sees.
- **Idempotency:** v1 does not de-duplicate Wazzup retries. We ack fast (`200`) to avoid
  them; if you see rare double replies, that's the next thing to add.

## Update availability

Same as the website — re-run after editing the table, then redeploy:

```bash
python3 scripts/sync_availability.py
```
