require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

// ---- In-memory call log (swap for a real DB in production) ----
const callLog = [];

function maskName(name) {
  if (!name) return name;
  const parts = name.split(' ');
  return parts
    .map((p, i) => (i === 0 ? p : p[0] + '*'.repeat(Math.max(p.length - 1, 1))))
    .join(' ');
}

// ---- Main Webhook Endpoint for Vapi ----
app.post('/webhook', (req, res) => {
  const { message } = req.body;

  if (message && message.type === 'tool-calls') {
    const toolCall = message.toolCalls[0];
    const { name, arguments: args } = toolCall.function;
    const callId = toolCall.id;

    console.log(`[Tool Call Received]: ${name}`, {
      ...args,
      verification_code: args.verification_code ? '****' : undefined, // never log raw PII
    });

    let result = {};

    switch (name) {
      case 'verify_customer': {
        // Mock verification: valid codes are '1234' (PAN suffix) or '1995' (birth year)
        const isValid = args.verification_code === '1234' || args.verification_code === '1995';
        result = isValid
          ? { verified: true, message: 'Identity verified successfully.', customer_name: maskName('Rahul Sharma') }
          : { verified: false, message: 'Verification failed. Incorrect code.' };
        break;
      }

      case 'log_promise_to_pay': {
        result = {
          success: true,
          ptp_id: `PTP-${Math.floor(1000 + Math.random() * 9000)}`,
          confirmed_date: args.ptp_date,
          amount: args.amount,
        };
        callLog.push({ type: 'PTP', account_id: args.account_id, ...result, timestamp: new Date().toISOString() });
        break;
      }

      case 'send_payment_link': {
        result = {
          success: true,
          message: `Payment link sent successfully via ${args.channel} to the registered mobile number.`,
        };
        break;
      }

      case 'escalate_to_agent': {
        result = {
          success: true,
          ticket_id: `ESC-${Math.floor(1000 + Math.random() * 9000)}`,
          message: `Escalated to human agent. Reason: ${args.reason}`,
        };
        callLog.push({ type: 'ESCALATION', account_id: args.account_id, ...result, timestamp: new Date().toISOString() });
        break;
      }

      case 'mark_disposition': {
        result = {
          success: true,
          disposition_logged: args.status,
          timestamp: new Date().toISOString(),
        };
        callLog.push({
          type: 'DISPOSITION',
          account_id: args.account_id,
          status: args.status,
          notes: args.notes || '',
          timestamp: result.timestamp,
        });
        break;
      }

      default:
        result = { success: false, message: 'Unknown function call' };
    }

    // Response format required by Vapi tool-call responses
    return res.status(200).json({
      results: [
        {
          toolCallId: callId,
          result: JSON.stringify(result),
        },
      ],
    });
  }

  // Fallback for other Vapi event notifications (status-update, end-of-call-report, etc.)
  return res.status(200).json({ status: 'acknowledged' });
});

// ---- Simple dashboard endpoint to eyeball logged dispositions (observability, Section 8 of HLD) ----
app.get('/dispositions', (req, res) => {
  res.json(callLog);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Kapture Mock Collections Webhook Server running on port ${PORT}`);
  console.log(`Webhook:      http://localhost:${PORT}/webhook`);
  console.log(`Dispositions: http://localhost:${PORT}/dispositions`);
});
