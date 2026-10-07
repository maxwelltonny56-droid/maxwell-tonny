// SmartBiz M-PESA backend (Safaricom Daraja STK Push). Needs Node 18+.
const express = require("express");
const cors = require("cors");

const {
  DARAJA_ENV = "sandbox",          // "sandbox" or "production"
  CONSUMER_KEY, CONSUMER_SECRET,
  SHORTCODE, PASSKEY,
  CALLBACK_URL,                    // https://YOUR-BACKEND/mpesa/callback
  ALLOWED_ORIGIN = "https://maxwelltonny56-droid.github.io",
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ CONSUMER_KEY, CONSUMER_SECRET, SHORTCODE, PASSKEY, CALLBACK_URL })) {
  if (!v) { console.error(`Missing environment variable: ${k}`); process.exit(1); }
}

const BASE = DARAJA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

// Prices live on the server so a customer cannot change the amount from the browser.
// Keep these in sync with the PRODUCTS list in index.html.
const PRICES = {
  "Smartphone": 20000, "Phone Accessory": 800, "Wireless Earbuds": 2000, "Smart Watch": 2500,
  "Bluetooth Speaker": 1500, "Power Bank": 1800, "T-Shirt": 1000, "Casual Outfit": 2500,
  "Sneakers": 3500, "Backpack": 1500, "Water Bottle": 600, "LED Light": 300, "Notebook": 150,
  "Scientific Calculator": 1200, "Football": 1500, "Basketball": 2000, "Laptop Stand": 1500,
  "Laptop Accessories": 2500,
};

// In-memory order store. Fine for starting out; it resets when the server restarts.
// Move to a database (Supabase, MongoDB, etc.) once you have real traffic.
const orders = new Map();

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use("/pay", cors({ origin: ALLOWED_ORIGIN }));
app.use("/status", cors({ origin: ALLOWED_ORIGIN }));

async function getToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) throw new Error("Could not get Daraja access token");
  return (await r.json()).access_token;
}

const timestamp = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14); // YYYYMMDDHHmmss

function cleanPhone(v) {
  let p = String(v || "").replace(/\D/g, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  if (/^[71]\d{8}$/.test(p)) p = "254" + p;
  return /^254[71]\d{8}$/.test(p) ? p : null;
}

app.get("/", (_req, res) => res.send("SmartBiz payments server is running."));

// 1. The website calls this to start a payment.
app.post("/pay", async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: "Invalid phone number" });

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    let amount = 0;
    for (const it of items) {
      const price = PRICES[it.name];
      const qty = Math.floor(Number(it.qty));
      if (!price || !(qty > 0) || qty > 50) return res.status(400).json({ error: "Invalid cart item" });
      amount += price * qty;
    }
    if (amount < 1) return res.status(400).json({ error: "Cart is empty" });

    const ts = timestamp();
    const password = Buffer.from(SHORTCODE + PASSKEY + ts).toString("base64");
    const token = await getToken();

    const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline", // use "CustomerBuyGoodsOnline" for a Till number
        Amount: amount,
        PartyA: phone,
        PartyB: SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: CALLBACK_URL,
        AccountReference: "SmartBiz",
        TransactionDesc: "SmartBiz order",
      }),
    });
    const d = await r.json();
    if (d.ResponseCode !== "0") {
      console.error("STK push rejected:", d);
      return res.status(502).json({ error: d.errorMessage || d.ResponseDescription || "Payment request failed" });
    }

    orders.set(d.CheckoutRequestID, {
      status: "pending", amount, phone, items,
      name: String(req.body.name || "").slice(0, 80),
      location: String(req.body.location || "").slice(0, 120),
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true, checkoutRequestId: d.CheckoutRequestID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error, please try again" });
  }
});

// 2. Safaricom calls this after the customer pays or cancels.
app.post("/mpesa/callback", (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  if (cb) {
    const order = orders.get(cb.CheckoutRequestID);
    if (order) {
      if (cb.ResultCode === 0) {
        const meta = Object.fromEntries((cb.CallbackMetadata?.Item || []).map(i => [i.Name, i.Value]));
        order.status = "paid";
        order.receipt = meta.MpesaReceiptNumber;
        console.log(`PAID ${order.amount} by ${order.phone} receipt ${order.receipt} | ${order.name} | ${order.location}`);
      } else {
        order.status = "failed";
        order.reason = cb.ResultDesc;
        console.log(`NOT PAID (${cb.ResultCode}): ${cb.ResultDesc}`);
      }
    }
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// 3. Optional: lets the website check whether a payment went through.
app.get("/status/:id", (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: "Not found" });
  res.json({ status: o.status, receipt: o.receipt, reason: o.reason });
});

app.listen(PORT, () => console.log(`SmartBiz payments server on port ${PORT} (${DARAJA_ENV})`));
