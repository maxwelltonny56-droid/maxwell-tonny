const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Test that the server is running
app.get("/", (req, res) => {
  res.json({
    message: "SmartBiz M-PESA backend is running 🚀"
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK"
  });
});

// Get Daraja access token
async function getAccessToken() {
  const credentials = Buffer.from(
    `${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`
  ).toString("base64");

  const response = await fetch(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${credentials}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description || "Could not get Daraja access token"
    );
  }

  return data.access_token;
}

// M-PESA STK Push
app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    let { phone, amount } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({
        success: false,
        message: "Phone number and amount are required."
      });
    }

    phone = String(phone).replace(/\D/g, "");
    amount = Number(amount);

    // Convert 07XXXXXXXX / 01XXXXXXXX to 254XXXXXXXXX
    if (phone.startsWith("0")) {
      phone = "254" + phone.substring(1);
    }

    if (!/^254[17]\d{8}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Kenyan phone number."
      });
    }

    if (!Number.isInteger(amount) || amount < 1) {
      return res.status(400).json({
        success: false,
        message: "Amount must be a whole number greater than 0."
      });
    }

    const accessToken = await getAccessToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/\D/g, "")
      .substring(0, 14);

    const password = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString("base64");

    const callbackUrl =
      `${process.env.PUBLIC_BASE_URL}/api/mpesa/callback`;

    const stkRequest = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: "SmartBiz",
      TransactionDesc: "SmartBiz Order"
    };

    const response = await fetch(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(stkRequest)
      }
    );

    const data = await response.json();

    console.log("Daraja response:", data);

    res.status(response.ok ? 200 : 400).json(data);

  } catch (error) {
    console.error("STK Push error:", error);

    res.status(500).json({
      success: false,
      message: "M-PESA request failed.",
      error: error.message
    });
  }
});

// Daraja callback
app.post("/api/mpesa/callback", (req, res) => {
  console.log("M-PESA CALLBACK:");
  console.log(JSON.stringify(req.body, null, 2));

  res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SmartBiz backend running on port ${PORT}`);
});
