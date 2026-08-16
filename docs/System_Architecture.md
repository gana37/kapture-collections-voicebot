# System Architecture Diagrams

Both diagrams below are Mermaid source. To view them rendered:
- **In VS Code:** install the "Markdown Preview Mermaid Support" extension, then open this file and use `Ctrl+Shift+V` (Preview).
- **Online:** paste the code blocks into [mermaid.live](https://mermaid.live) and export as PNG for `System_Architecture.png` if you need a static image for submission.

---

## 1. Pipeline Overview

```mermaid
flowchart LR
    A[Customer Phone] -->|PSTN/SIP| B[Vapi Telephony Layer]
    B --> C[Deepgram Nova-2 STT]
    C -->|Transcript| D[GPT-4o Orchestrator]
    D -->|Tool Call| E[Mock Webhook Server]
    E -->|Tool Result| D
    D -->|Response Text| F[ElevenLabs / Cartesia TTS]
    F -->|Audio| B
    B -->|PSTN/SIP| A

    subgraph Tools
    E
    end

    style D fill:#e6f2ff
    style E fill:#fff0e6
```

---

## 2. Full Call Sequence (Auth + Negotiation Phases)

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    participant Telephony as Telephony / SIP
    participant Vapi as Vapi Engine
    participant STT as Deepgram STT
    participant LLM as GPT-4o (Orchestrator)
    participant Server as Mock Webhook API
    participant TTS as ElevenLabs TTS

    Customer->>Telephony: Answers Call
    Telephony->>Vapi: Stream Audio
    Vapi->>STT: Real-time Audio Stream
    STT-->>Vapi: Transcribed Text Stream

    rect rgb(240, 240, 240)
        note over Vapi, LLM: Auth Phase (No Debt Disclosed)
        Vapi->>LLM: Send Conversation State + Transcript
        LLM-->>Vapi: Request Verification ("Provide last 4 digits of PAN")
        Vapi->>TTS: Synthesize Speech
        TTS-->>Customer: Play Audio
        Customer->>Vapi: Speaks ("1-2-3-4")
        Vapi->>LLM: Transcript ("1234")
        LLM->>Server: Tool Call: verify_customer(account_id, "1234")
        Server-->>LLM: Response: { verified: true, customer_name: "Rahul Sharma" }
    end

    rect rgb(220, 245, 220)
        note over Vapi, LLM: Collections & Negotiation Phase
        LLM-->>Vapi: Disclose Debt & Ask PTP
        Vapi->>TTS: Audio Output ("₹8,499 overdue by 12 days...")
        TTS-->>Customer: Play Audio
        Customer->>Vapi: "I will pay this Friday."
        LLM->>Server: Tool Call: log_promise_to_pay(date: "2026-08-14", amount: 8499)
        Server-->>LLM: Response: { status: "SUCCESS", ptp_id: "PTP-9921" }
        LLM->>Server: Tool Call: send_payment_link(channel: "SMS")
        Server-->>LLM: Response: { link_sent: true }
    end

    LLM-->>Vapi: Final Polite Goodbye
    Vapi->>Customer: End Call
```

---

## 3. State Machine

```mermaid
stateDiagram-v2
    [*] --> INIT
    INIT --> AUTH_PENDING: customer confirms identity
    INIT --> CALL_ENDED: wrong person
    AUTH_PENDING --> AUTHENTICATED: verify_customer succeeds
    AUTH_PENDING --> CALL_ENDED: verify_customer fails x2
    AUTHENTICATED --> NEGOTIATION: auto
    NEGOTIATION --> PTP_COLLECTED: will pay
    NEGOTIATION --> CALL_ENDED: already paid
    NEGOTIATION --> ESCALATED: hardship / dispute
    PTP_COLLECTED --> CALL_ENDED
    ESCALATED --> CALL_ENDED
    CALL_ENDED --> [*]

    note right of AUTH_PENDING
        DNC / abuse / silence
        can force CALL_ENDED
        from ANY state
    end note
```
