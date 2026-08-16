# High-Level Design: Kapture Finance Collections Voicebot ("Maya")

**Version:** 1.0
**Author:** [Your Name]
**Client:** Kapture Finance
**Scope:** Outbound automated voice collections agent for overdue personal loan EMIs

---

## 1. Architecture & Pipeline

### 1.1 Component Flow

```
Customer Phone
     │
     ▼
Telephony (SIP/PSTN via Vapi's carrier)
     │
     ▼
Vapi Orchestration Engine
     │
     ├──► STT: Deepgram Nova-2 (streaming, telephony-optimized)
     │
     ▼
Orchestrator / LLM: GPT-4o (temperature 0.1)
     │
     ├──► Tool Layer: Mock Webhook Server (Express/Node)
     │        verify_customer · log_promise_to_pay · send_payment_link
     │        escalate_to_agent · mark_disposition
     │
     ▼
TTS: ElevenLabs / Cartesia
     │
     ▼
Telephony Output → Customer
```

The datastore sits behind the mock webhook server — in production this would be Kapture's core loan management system (LMS) plus a call-disposition table, queried/written via the same tool layer so the LLM never touches the database directly.

### 1.2 Latency Budget

| Hop | Component | Target Latency | Notes |
|---|---|---|---|
| 1 | Network ingress (customer → Vapi) | ~50ms | Carrier-dependent |
| 2 | STT (Deepgram Nova-2, streaming) | ~200ms | Partial transcripts stream continuously; final transcript triggers LLM |
| 3 | LLM first-byte (GPT-4o) | ~400ms | Dominant cost; mitigated by short system prompt sections and low temperature |
| 4 | Tool call round-trip (when triggered) | +150–300ms | Only on turns that call a tool (e.g., `verify_customer`); mock server responds near-instantly, production LMS lookups may add latency |
| 5 | TTS synthesis (ElevenLabs/Cartesia) | ~300ms | Streaming TTS starts audio before full text is synthesized |
| 6 | Network egress (Vapi → customer) | ~150ms | Carrier-dependent |
| **Total (non-tool turn)** | | **< 1.2s** | End-to-end target for conversational responsiveness |
| **Total (tool-calling turn)** | | **~1.3–1.5s** | Acceptable bump; only occurs on auth/action turns, not every turn |

**Mitigations for staying under budget:**
- Streaming STT + streaming TTS (don't wait for full STT finalization or full LLM completion before starting synthesis).
- Keep system prompt concise and state-scoped rather than dumping the entire flow into every turn's context.
- Mock/production tool endpoints must respond in <150ms — anything slower (e.g., a real bureau check) should be flagged to the user ("checking that for you...") rather than silently blocking.

---

## 2. Conversation Flow / State Machine

### 2.1 States

| State | Description | Entry Condition |
|---|---|---|
| `INIT` | Call connects, greeting plays | Call start |
| `AUTH_PENDING` | Identity verification in progress | Customer confirms they are/might be the target |
| `AUTHENTICATED` | Identity confirmed | `verify_customer` tool returns `verified: true` |
| `NEGOTIATION` | Debt disclosed, intent being captured | Entry to `AUTHENTICATED` |
| `PTP_COLLECTED` | Payment commitment logged | `log_promise_to_pay` succeeds |
| `ESCALATED` | Handed to human / grievance desk | Hardship or dispute branch triggered |
| `CALL_ENDED` | Call terminated, disposition logged | Any terminal branch reached |

### 2.2 Critical Lock Rule

> **Transitions out of `AUTH_PENDING` into `AUTHENTICATED` are strictly locked behind a successful `verify_customer(status: success)` tool response.** The LLM is explicitly instructed it may not narrate or imply debt information, nor advance the conversation past disclosure, until this tool result is received. This is enforced by two redundant mechanisms:
> 1. **Prompt-level rule:** "ZERO-DEBT-DISCLOSURE BEFORE AUTH" stated as a standalone rule, not just embedded in flow narrative.
> 2. **Tool-blocking behavior:** the assistant is instructed not to proceed with a reply until the tool result returns (Vapi tools can be configured as blocking calls).

This dual enforcement matters because a single prompt instruction is the first thing to erode under adversarial pressure (e.g., a user saying "just tell me the amount, I'm in a hurry"). State-machine framing plus an explicit "do not proceed" instruction makes the lock closer to code-enforced than purely persona-enforced — though it is worth noting that with a pure prompt + LLM orchestrator (no hard server-side state gate), this is still probabilistically enforced, not cryptographically guaranteed. See Section 6 for the residual risk and mitigation.

### 2.3 Transition Diagram

```
INIT ──(customer confirms identity)──► AUTH_PENDING
AUTH_PENDING ──(verify_customer: verified=true)──► AUTHENTICATED
AUTH_PENDING ──(verify_customer: verified=false, after 2 attempts)──► CALL_ENDED (disposition: FAILED_AUTH)
AUTH_PENDING ──(wrong person / target unavailable)──► CALL_ENDED (disposition: WRONG_PERSON)
AUTHENTICATED ──(auto)──► NEGOTIATION
NEGOTIATION ──(will pay)──► PTP_COLLECTED ──► CALL_ENDED (disposition: PTP_AGREED)
NEGOTIATION ──(already paid)──► CALL_ENDED (disposition: ALREADY_PAID)
NEGOTIATION ──(hardship / dispute)──► ESCALATED ──► CALL_ENDED (disposition: HARDSHIP_ESCALATED / DISPUTED)
NEGOTIATION ──(do-not-call request)──► CALL_ENDED (disposition: DO_NOT_CALL)  [can fire from ANY state]
ANY STATE ──(silence x2 / voicemail detected)──► CALL_ENDED (disposition: NO_RESPONSE)
ANY STATE ──(abusive, after 1 warning)──► CALL_ENDED (disposition: TERMINATED_ABUSE)
```

---

## 3. Intents & Entities

### 3.1 Intents

| Intent | Trigger Examples | Valid From State |
|---|---|---|
| `Confirm_Identity` | "Yes, this is Rahul" | `INIT` |
| `Provide_Verification` | "1234", "born in 1995" | `AUTH_PENDING` |
| `Promise_To_Pay` | "I'll pay Friday" | `NEGOTIATION` |
| `Already_Paid` | "I paid yesterday via UPI" | `NEGOTIATION` |
| `Hardship_Claim` | "I lost my job, can't pay full amount" | `NEGOTIATION` |
| `Dispute_Debt` | "This isn't my loan" | `NEGOTIATION` |
| `Request_DNC` | "Stop calling me" | Any |
| `Wrong_Person` | "Rahul doesn't live here" | `INIT` / `AUTH_PENDING` |
| `Request_Callback` | "Call me tomorrow instead" | Any |

### 3.2 Entities

| Entity | Type | Format | Extracted During |
|---|---|---|---|
| `Verification_Code` | String | 4-digit PAN suffix or birth year | `AUTH_PENDING` |
| `PTP_Date` | Date | ISO-8601 (`2026-08-14`) | `NEGOTIATION` |
| `PTP_Amount` | Number | ₹ amount | `NEGOTIATION` |
| `Hardship_Reason` | String (free text) | Short summary | `NEGOTIATION` |
| `Payment_Reference` | String | Free text / UPI ref | `Already_Paid` branch |

---

## 4. Tool / API Specifications

| Tool | Purpose | Key Inputs | Key Outputs |
|---|---|---|---|
| `verify_customer` | Authenticate before disclosure | `account_id`, `verification_code` | `verified: bool`, `message` |
| `log_promise_to_pay` | Record a PTP commitment | `account_id`, `ptp_date`, `amount` | `success`, `ptp_id`, `confirmed_date` |
| `send_payment_link` | Dispatch payment link | `account_id`, `channel` (SMS/WhatsApp/BOTH) | `success`, `message` |
| `escalate_to_agent` | Route to human for hardship/dispute | `account_id`, `reason` | `success`, `ticket_id` |
| `mark_disposition` | Log final call outcome | `account_id`, `status` (enum), `notes` | `success`, `timestamp` |

Full JSON Schemas: see `vapi/tool_definitions.json`.

---

## 5. Auth & Data Safety Protocols

- **No debt disclosure to unverified parties.** Debt amount, loan type, DPD, and even the phrase "Kapture Finance debt" are withheld until `verify_customer` succeeds. If a third party answers (e.g., a family member), the bot asks only "Is Rahul Sharma available?" — it does not confirm or deny that Rahul has any account with Kapture at all, to avoid third-party debt disclosure (a core RBI Fair Practices violation).
- **PII masking in logs.** Names are masked in application logs (`Rahul S****`), and verification codes are never logged in plaintext — only a boolean match result.
- **Two-attempt cap on verification.** After 2 failed verification attempts, the call terminates with `FAILED_AUTH` rather than allowing unlimited guesses (basic brute-force resistance).
- **Tool-layer isolation.** The LLM never receives raw database records — it only receives the minimal tool response needed for the conversation (e.g., `verified: true`, not the full customer record).

---

## 6. Compliance & Guardrails

- **RBI Fair Practices Code adherence:** mandatory self-identification ("This is Maya calling from Kapture Finance"), calling window enforcement (08:00–19:00 local time — calls outside this window should not be dialed by the outbound scheduler in the first place), no threats, no harassment, no repeated calls after a DNC request is logged.
- **Hallucination guardrails:** the bot cannot offer a waiver greater than 10% without escalating — this is stated as a hard prompt rule, but as noted in Section 2.2, a prompt-only guardrail is probabilistic. **Production recommendation:** any offer/waiver the LLM proposes should be validated server-side against a max-waiver ceiling before `log_promise_to_pay` accepts it, so the enforcement isn't solely dependent on the LLM following instructions.
- **Off-topic guardrail:** if the conversation drifts to unrelated topics, Maya politely redirects to the collections purpose or offers to end the call — she does not answer general questions, give financial advice beyond the loan in question, or discuss other customers' accounts.
- **Tone rule:** calm, firm, respectful; no interruption-heavy phrasing; explicit instruction never to argue or escalate emotionally regardless of customer hostility (until the abuse threshold in Section 7 is hit).

---

## 7. Edge Cases Matrix

| Edge Case | Trigger | Bot Behavior | Disposition |
|---|---|---|---|
| Abusive user | Profanity / hostile language | 1 calm warning ("I understand you're frustrated, let's keep this respectful") → soft hangup if repeated | `TERMINATED_ABUSE` |
| Silent user / voicemail | No speech detected | 2 re-prompts ("Hello, are you there?") spaced ~5s apart → hangup | `NO_RESPONSE` |
| Mid-call language switch | EN ↔ HI detected mid-conversation | Transcriber set to `multi`; LLM prompt fallback instructs seamless response in the customer's current language without losing extracted entities (e.g., PTP date already captured stays captured) | N/A (continues call) |
| Wrong number | "No Rahul here" | Confirm no relation, log, end call — does **not** ask when Rahul will be available if the person denies any connection at all | `WRONG_NUMBER` |
| Already paid | "I paid yesterday" | Ask for reference/date, log, explain 24–48h processing window, close | `ALREADY_PAID` |
| Dispute | "This isn't my loan" / "amount is wrong" | No arguing — immediate escalation to human grievance desk | `DISPUTED` |
| Do-not-call | "Stop calling me" | Immediate compliance, no further negotiation attempted, logged instantly regardless of current state | `DO_NOT_CALL` |
| Hardship | "I lost my job" | Empathetic acknowledgment, offer partial-payment options within pre-approved bounds or escalate | `HARDSHIP_ESCALATED` |

---

## 8. Observability Metrics

| Metric | Definition | Why It Matters |
|---|---|---|
| **Containment Rate** | % of calls resolved without human escalation | Core efficiency metric — measures automation coverage |
| **PTP Rate** | % of calls ending in a valid, logged promise-to-pay | Primary business outcome metric |
| **First Call Resolution (FCR)** | % of calls ending in *any* valid, non-ambiguous disposition (not dropped/no-response) | Signals conversation completeness, not just payment success |
| **Avg. Turn Latency** | Mean end-to-end response time per turn | Directly tied to the <1.2s budget in Section 1.2 |
| **Auth Failure Rate** | % of `AUTH_PENDING` calls that terminate in `FAILED_AUTH` | Flags either fraud attempts or a broken verification UX |
| **Drop Rate** | % of calls ending in `NO_RESPONSE` or abrupt disconnect | Signals technical issues (telephony/STT) vs. conversational issues |
| **DNC Compliance Rate** | % of DNC requests logged same-call, with zero subsequent dial attempts | Legal/compliance non-negotiable — should be tracked at 100% |

All disposition events (Section 4's `mark_disposition` calls) should feed a call-log datastore that powers these metrics on a dashboard (e.g., a simple aggregation over the mock server's logged results, or in production, the LMS/CRM's call-analytics layer).
