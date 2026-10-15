# HisabBani AI backend MVP

WhatsApp-first digital ledger API for a small, consented Bangladesh pilot. It accepts owner text/audio messages, transcribes voice notes, extracts proposed ledger entries, posts high-confidence entries, asks for button confirmation when extraction is uncertain, and can send Bangla text-plus-audio acknowledgements.

The 0-1000 score here is an experimental internal indicator, not a Bangladesh Bank/CIB score, loan offer, or automated lending decision. Do not share lender leads or send customer reminders without explicit consent and legal/partner review.

## 1. Prerequisites and setup

- Node.js 20.11+, npm, PostgreSQL, and Redis
- A Meta WhatsApp Business Platform app/registered phone number and an OpenAI API key
- A host platform that supports the bundled `ffmpeg-static` binary

```powershell
cd muddi-fintech-backend
npm install
Copy-Item .env.example .env
```

Fill in `.env`; do not commit it or expose credentials in browser code. Use a random `META_VERIFY_TOKEN` of at least 24 characters. Set `WHATSAPP_API_VERSION` to a Graph API version currently supported by your Meta app. Set `ENABLE_VOICE_REPLIES=false` for text-only acknowledgements; test generated Bangla pronunciation with shopkeepers before enabling voice replies broadly.

Configure the Meta callback as `https://<your-host>/webhooks/whatsapp`, subscribe to `messages`, and use the same verify token. The reminder template must be approved in WhatsApp Manager, use the `bn` locale, and have exactly three body parameters: customer name, shop name, and amount.

## 2. Initialize and onboard a shop

```powershell
npm run db:migrate -- --name init
npm run onboard:shop -- --owner-name "Rahim Uddin" --owner-phone "+8801XXXXXXXXX" --shop-name "Rahim Store" --phone-number-id "META_PHONE_NUMBER_ID"
```

Owner phone uses international format and must match the WhatsApp sender. Use the same WhatsApp business phone-number ID for each shop connected to this shared bot. This MVP supports one shop per owner and accepts messages from the registered owner only; implement an audited shop-user membership model before enabling staff phones.

## 3. Run API, worker, and reminders

Use separate terminals:

```powershell
npm run dev
npm run dev:worker
```

Check `http://localhost:3000/health`. For local webhook testing, expose the API through a trusted HTTPS tunnel and configure that URL in Meta. Schedule the daily reminders once:

```powershell
npm run reminders:schedule
```

Reminders require customer `remindersOptIn=true`, a phone number, an overdue credit sale, positive calculated balance, and an approved configured template. Collect and record customer consent before enabling the field.

## 4. Processing flow

1. `GET /webhooks/whatsapp` verifies the Meta callback. `POST` verifies `X-Hub-Signature-256`, enqueues messages, and returns quickly.
2. BullMQ downloads audio, converts it to mono 16 kHz MP3 with ffmpeg, transcribes Bangla, and extracts a strict JSON object.
3. High-confidence validated entries post transactionally. Uncertain entries remain pending until the registered owner confirms via WhatsApp buttons.
4. Unique WhatsApp message/source IDs prevent duplicate ledger posts on webhook retries. Successful owner acknowledgements can include generated audio; speech-generation or media-upload failure does not undo the text response or ledger entry. Corrections should be implemented as reversal entries, never silent historical edits.

## Parse transcript API

`POST /api/parse-transcript` accepts `{ "transcript": "..." }` and returns validated structured JSON. It requires `Authorization: Bearer <PARSER_API_KEY>` and is limited to 10 requests per minute per IP. The response uses a `transactions` array so one utterance can contain multiple events, plus a separate `payment_promises` array; promises are never treated as completed collections. The endpoint creates drafts only and does not write the ledger or send reminders.

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/parse-transcript -Headers @{ Authorization = "Bearer $env:PARSER_API_KEY" } -ContentType "application/json" -Body '{"transcript":"রহিম ভাই ৫০০ টাকার চাল বাকি নিল আর কালকে বাকির ৩০০ টাকা ফেরত দেবে বলল।"}'
```

Types distinguish customer credit sales, shop debt, cash sales, expenses, customer collections, and supplier payments. This prevents the common ambiguity of treating every "baki" transaction as the same cashflow direction.

## 5. Pilot and release checks

- Test invalid signatures, duplicate webhooks, unsupported message types, media download/transcription failures, retries, expired confirmations, and rejected entries.
- Verify tenant isolation and sender authorization; review all automated entries against the shopkeeper's khata.
- Manually label at least 100 consented Bangla/Banglish messages before enabling auto-post. Set the confidence threshold from observed errors.
- Test reminder opt-in and approved template delivery with a Meta test number first.
- Run `npm run typecheck` and `npm run build`, then apply migrations to staging before production.

The scaffold does not yet include customer opt-in capture, lender APIs/PDF rendering, payment processing, or an admin dashboard. Review Bangladesh regulatory obligations, data retention, cross-border processing, WhatsApp policies, and lender contracts with local counsel and the licensed partner before production.