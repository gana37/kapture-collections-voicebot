# Kapture Finance Collections Voicebot — "Maya"

An outbound Voice AI collections agent built on [Vapi](https://vapi.ai), designed for Kapture Finance to run compliant, state-enforced EMI collection calls without a human agent on routine cases.

**Demo customer context:** Rahul Sharma · Personal Loan · ₹8,499 overdue · 12 days past due (DPD).

---

## 1. What's in this repo

```
kapture-collections-voicebot/
├── README.md                    ← you are here
├── docs/
│   ├── HLD_Document.md          # Full high-level design (8 sections)
│   └── System_Architecture.md   # Mermaid sequence diagram + pipeline diagram
├── vapi/
│   ├── system_prompt.txt        # Production system prompt for the Vapi assistant
│   └── tool_definitions.json    # Tool/function JSON schemas registered in Vapi
├── mock-server/
│   ├── package.json
│   ├── server.js                # Express webhook implementing all 5 tools
│   └── .env.example
└── tests/
    └── test_cases.json          # Evaluation matrix for scale testing
```

## 2. Quick setup (local, ~10 minutes)

### Step A — Run the mock webhook server

```bash
cd mock-server
npm install
cp .env.example .env
npm start
# Server running on http://localhost:3000
```

### Step B — Expose it publicly (Vapi needs an HTTPS URL)

```bash
npx ngrok http 3000
# Copy the https://xxxx.ngrok-free.app URL
```

### Step C — Configure the Vapi Assistant

1. Log in to [dashboard.vapi.ai](https://dashboard.vapi.ai) → **Assistants → Create Assistant → Blank Template**.
2. **Transcriber:** Deepgram, model `nova-2`, language `multi` (supports EN/HI code-switching for the bonus).
3. **Model:** OpenAI `gpt-4o` (or `gpt-4o-mini` for cost), **Temperature: 0.1** — low temperature is deliberate here: this is a compliance-critical flow where the LLM must reliably follow the state machine, not improvise phrasing.
4. **Voice:** ElevenLabs — "Sarah" or "Rachel" (calm, professional, unhurried; avoids sounding pushy in a debt-collection context, which matters for RBI Fair Practices tone requirements).
5. **First Message:** `"Hello, this is Maya calling from Kapture Finance. Am I speaking with Mr. Rahul Sharma?"`
6. Paste `vapi/system_prompt.txt` into the System Prompt field.
7. Under **Tools**, import `vapi/tool_definitions.json` and point every tool's **Server URL** to `https://xxxx.ngrok-free.app/webhook`.
8. Save, then test via **Vapi Web Call** (browser mic) before trying a real PSTN number.

### Step D — Run the two demo scenarios

**Scenario A — Happy Path (PTP):**
> "Hello, this is Maya calling from Kapture Finance. Am I speaking with Mr. Rahul Sharma?"
> "Yes, speaking."
> "For security, can you confirm the last 4 digits of your PAN or your birth year?"
> "1234"
> *(bot discloses ₹8,499 overdue, 12 days)*
> "I'll pay this Friday."
> *(bot logs PTP, sends payment link, closes call)*

**Scenario B — Edge Case (Already Paid):**
> Same auth flow → "I already paid yesterday via UPI!"
> *(bot asks for reference/date, calls `mark_disposition(ALREADY_PAID)`, explains 24–48h processing, closes politely)*

Record both with Loom/OBS as a single 2–4 min clip.

---

## 3. Design choices & why

- **Auth is state-enforced, not prompt-discretionary.** The system prompt explicitly forbids uttering "overdue," "EMI," "loan amount," or the company name in a debt context until the `verify_customer` tool call returns `verified: true`. This is reinforced twice — once as a hard rule, once inline in the state description — because single-instance rules are the ones LLMs drift from first under user pressure ("just tell me how much I owe!").
- **Temperature 0.1.** Collections calls are a compliance surface, not a creativity surface. Low temperature trades away conversational flair for consistent adherence to the disclosure gate and tool-call sequencing.
- **`multi`-language transcriber setting.** Chosen over hard-coding `en-US` so a mid-call Hindi/Hinglish switch (bonus requirement) doesn't produce garbled transcripts that then confuse the LLM's intent extraction.
- **Every branch ends in a `mark_disposition` or `log_promise_to_pay` call.** No conversational dead ends — every call, however it goes, produces a queryable outcome. This is what makes containment-rate and PTP-rate metrics possible later.
- **Mock server returns synchronous, deterministic responses** (e.g., verification succeeds only on `1234` or `1995`) so the demo is reproducible and testable, matching `tests/test_cases.json`.

## 4. What broke / debugging notes

*(Fill this in as you actually build — interviewers want to see real friction, not a clean narrative. Typical issues you'll likely hit and can document here:)*

- Vapi's tool-call webhook payload shape (`message.type === 'tool-calls'`, `toolCalls[0].function`) differs from raw OpenAI function-calling format — the mock server here already matches Vapi's expected shape, but if you're debugging locally, log `req.body` raw first before assuming the schema.
- If the assistant discloses debt before verification, it's almost always because the tool call is being *initiated* but the LLM continues talking before waiting for the `result`. Fix: explicitly instruct "DO NOT proceed until tool response is received" (already in the prompt) and consider setting the tool as `async: false` / blocking in Vapi's tool config.
- ngrok free-tier URLs rotate on restart — remember to update the Server URL in Vapi's Tools config each time you restart ngrok, or use a fixed subdomain / deploy to Render/Vercel instead for the actual demo recording.

## 5. What I'd improve with more time

- Move disposition logging to a real datastore (Postgres/Airtable) instead of console.log, so containment/PTP-rate metrics in the HLD's observability section are actually queryable.
- Add a real hardship-offer calculator with a hard-coded max waiver ceiling (10%) enforced server-side, not just prompt-side — right now the "no unauthorized waivers >10%" rule lives only in the system prompt, which is a soft guardrail.
- Add retry/backoff and idempotency keys on `log_promise_to_pay` / `send_payment_link` so a flaky webhook doesn't double-send a payment link.
- Wire real SMS/WhatsApp sending (Twilio) behind `send_payment_link` for the bonus requirement instead of a mocked success response.

## 6. Evaluation framework (bonus)

See `tests/test_cases.json` for the test matrix. At scale, I'd run these as automated conversation replays against the Vapi assistant (Vapi supports scripted test calls / or replaying transcripts through the same LLM+prompt via the Anthropic/OpenAI API directly) and grade each on: (a) zero-debt-disclosure-before-auth, (b) correct tool call fired with correct arguments, (c) correct disposition logged. This turns compliance from "sounds right" into a scored, regression-testable property of the prompt.
