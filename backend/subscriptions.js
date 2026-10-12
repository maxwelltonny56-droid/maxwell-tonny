const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PRICE = 1000;
const DAYS = 30;
const DARAJA = process.env.DARAJA_BASE_URL || 'https://sandbox.safaricom.co.ke';

async function getToken() {
  const auth = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString('base64');
  const r = await fetch(`${DARAJA}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  return (await r.json()).access_token;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

function normalizePhone(p) {
  p = String(p || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}

// 1. Start payment
router.post('/', async (req, res) => {
  try {
    const jwt = (req.headers.authorization || '').replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(jwt);
    if (error || !user) return res.status(401).json({ error: 'Please log in again.' });

    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid Safaricom number.' });

    const ts = timestamp();
    const password = Buffer.from(
      process.env.DARAJA_SHORTCODE + process.env.DARAJA_PASSKEY + ts
    ).toString('base64');

    const r = await fetch(`${DARAJA}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: process.env.DARAJA_SHORTCODE,
        Password: password,
        Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: PRICE,
        PartyA: phone,
        PartyB: process.env.DARAJA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: `${process.env.PUBLIC_URL}/api/subscribe/callback`,
        AccountReference: 'AttachmentFinder',
        TransactionDesc: 'Premium 30 days',
      }),
    });
    const data = await r.json();
    if (data.ResponseCode !== '0')
      return res.status(502).json({ error: data.errorMessage || 'Could not start payment.' });

    await supabase.from('subscriptions').insert({
      org_id: user.id,
      amount: PRICE,
      phone,
      status: 'pending',
      checkout_request_id: data.CheckoutRequestID,
    });

    res.json({ message: 'Check your phone and enter your M-PESA PIN.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// 2. Safaricom callback
router.post('/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return;

    const { data: sub } = await supabase
      .from('subscriptions').select('*')
      .eq('checkout_request_id', cb.CheckoutRequestID)
      .eq('status', 'pending').maybeSingle();
    if (!sub) return;

    const items = cb.CallbackMetadata?.Item || [];
    const get = (n) => items.find((i) => i.Name === n)?.Value;

    if (cb.ResultCode !== 0 || Number(get('Amount')) < PRICE) {
      await supabase.from('subscriptions').update({ status: 'failed' }).eq('id', sub.id);
      return;
    }

    // If already premium, the new 30 days start when the current ones end
    const { data: cur } = await supabase
      .from('org_premium').select('premium_until').eq('org_id', sub.org_id).maybeSingle();
    const start = cur?.premium_until && new Date(cur.premium_until) > new Date()
      ? new Date(cur.premium_until) : new Date();
    const end = new Date(start.getTime() + DAYS * 86400000);

    await supabase.from('subscriptions').update({
      status: 'active',
      starts_at: start.toISOString(),
      expires_at: end.toISOString(),
      mpesa_receipt: get('MpesaReceiptNumber'),
    }).eq('id', sub.id);
  } catch (e) {
    console.error(e);
  }
});

module.exports = router;
