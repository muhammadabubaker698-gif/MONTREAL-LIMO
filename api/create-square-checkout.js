// Montreal Limo Services — instant Square checkout endpoint (Vercel serverless function).
// The static site (montreallimoservice.ca, GitHub Pages) calls this on the Vercel origin.
// Creates a Square-hosted checkout page (Payment Links API, quick_pay) for the exact
// trip total computed by the site's booking engine, then the browser redirects to it.
//
// Required environment variables (Vercel project settings — never commit secrets):
//   SQUARE_ACCESS_TOKEN  Production access token from the Square Developer Dashboard
//   SQUARE_LOCATION_ID   Square location ID for Montreal Limo Services INC
// Optional:
//   SQUARE_ENV           "sandbox" to use the sandbox API, anything else = production

const ALLOWED_ORIGINS = [
  "https://montreallimoservice.ca",
  "https://www.montreallimoservice.ca",
  "https://montreal-limo.vercel.app",
];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const token = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!token || !locationId) {
    return res.status(503).json({ ok: false, error: "Square checkout is not configured yet." });
  }

  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const amount = Math.round(Number(b.amount_cents));
    const currency = b.currency === "USD" ? "USD" : "CAD";
    if (!Number.isFinite(amount) || amount < 500 || amount > 3000000) {
      return res.status(400).json({ ok: false, error: "Invalid amount." });
    }

    const name = String(b.name || "").trim().slice(0, 120);
    const email = String(b.email || "").trim().slice(0, 200);
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "Name and a valid email are required." });
    }

    const vehicle = String(b.vehicle || "Limo trip").slice(0, 80);
    const lang = String(b.lang || "").toLowerCase().startsWith("fr") ? "fr" : "en";
    const date = String(b.date || "").slice(0, 10);
    const time = String(b.time || "").slice(0, 5);
    const title = ("Limo trip - " + vehicle + (date ? " - " + date : "") + (time ? " " + time : "")).slice(0, 120);

    const note = [
      "Customer: " + name,
      b.phone ? "Phone: " + String(b.phone).slice(0, 40) : "",
      b.pickup ? "Pickup: " + String(b.pickup).slice(0, 160) : "",
      b.dropoff ? "Drop-off: " + String(b.dropoff).slice(0, 160) : "",
      b.triptype ? "Trip type: " + String(b.triptype).slice(0, 40) : "",
      b.estimate_text ? "Estimate: " + String(b.estimate_text).slice(0, 220) : "",
      b.notes ? "Notes: " + String(b.notes).slice(0, 200) : "",
    ].filter(Boolean).join("\n").slice(0, 480);

    const base = process.env.SQUARE_ENV === "sandbox"
      ? "https://connect.squareupsandbox.com"
      : "https://connect.squareup.com";

    const payload = {
      idempotency_key: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12),
      description: ("Montreal Limo Services booking - " + vehicle + " - " + date + " " + time).slice(0, 200),
      quick_pay: {
        name: title,
        price_money: { amount: amount, currency: currency },
        location_id: locationId,
      },
      checkout_options: {
        redirect_url: lang === "fr" ? "https://montreallimoservice.ca/fr/booking-success.html" : "https://montreallimoservice.ca/booking-success.html",
        ask_for_shipping_address: false,
        merchant_support_email: "info@montreallimoservice.ca",
        // Tipping on the Square checkout page: Square presents 15% / 20% / 25%
        // options (percentages are Square's payment-link tip settings, enabled
        // per link here). Customers can change or remove the tip.
        allow_tipping: true,
      },
      pre_populated_data: { buyer_email: email },
      payment_note: note,
    };

    const r = await fetch(base + "/v2/online-checkout/payment-links", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Square-Version": "2024-06-04",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    const url = data && data.payment_link && data.payment_link.url;
    if (!r.ok || !url) {
      console.error("Square create payment link failed:", JSON.stringify(data).slice(0, 600));
      return res.status(502).json({ ok: false, error: "Square could not create the checkout." });
    }

    return res.status(200).json({ ok: true, url: url, id: data.payment_link.id });
  } catch (err) {
    console.error("Checkout endpoint error:", err);
    return res.status(500).json({ ok: false, error: "Checkout error." });
  }
};
