require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const callLog = [];

function maskName(name) {
  if (!name) return name;
  const parts = name.split(' ');
  return parts
    .map((p, i) => (i === 0 ? p : p[0] + '*'.repeat(Math.max(p.length - 1, 1))))
    .join(' ');
}

function logToolCall(name, args) {
  console.log(`[Tool Call Received]: ${name}`, {
    ...args,
    verification_code: args.verification_code ? '****' : undefined,
  });
}

app.post('/webhook/verify-customer', (req, res) => {
  const args = req.body;
  logToolCall('verify_customer', args);
  const isValid = args.verification_code === '1234' || args.verification_code === '1995';
  const result = isValid
    ? { verified: true, message: 'Identity verified successfully.', customer_name: maskName('Rahul Sharma') }
    : { verified: false, message: 'Verification failed. Incorrect code.' };
  return res.status(200).json(result);
});

app.post('/webhook/log-promise-to-pay', (req, res) => {
  const args = req.body;
  logToolCall('log_promise_to_pay', args);
  const result = {
    success: true,
    ptp_id: `PTP-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmed_date: args.ptp_date,
    amount: args.amount,
  };
  callLog.push({ type: 'PTP', account_id: args.account_id, ...result, timestamp: new Date().toISOString() });
  return res.status(200).json(result);
});

app.post('/webhook/send-payment-link', (req, res) => {
  const args = req.body;
  logToolCall('send_payment_link', args);
  const result = {
    success: true,
    message: `Payment link sent successfully via ${args.channel} to the registered mobile number.`,
  };
  return res.status(200).json(result);
});

app.post('/webhook/escalate-to-agent', (req, res) => {
  const args = req.body;
  logToolCall('escalate_to_agent', args);
  const result = {
    success: true,
    ticket_id: `ESC-${Math.floor(1000 + Math.random() * 9000)}`,
    message: `Escalated to human agent. Reason: ${args.reason}`,
  };
  callLog.push({ type: 'ESCALATION', account_id: args.account_id, ...result, timestamp: new Date().toISOString() });
  return res.status(200).json(result);
});

app.post('/webhook/mark-disposition', (req, res) => {
  const args = req.body;
  logToolCall('mark_disposition', args);
  const result = {
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
  return res.status(200).json(result);
});

app.get('/dispositions', (req, res) => {
  res.json(callLog);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Kapture Mock Collections Webhook Server running on port ${PORT}`);
  console.log(`Tool endpoints:`);
  console.log(`  POST /webhook/verify-customer`);
  console.log(`  POST /webhook/log-promise-to-pay`);
  console.log(`  POST /webhook/send-payment-link`);
  console.log(`  POST /webhook/escalate-to-agent`);
  console.log(`  POST /webhook/mark-disposition`);
  console.log(`Dispositions: http://localhost:${PORT}/dispositions`);
});
