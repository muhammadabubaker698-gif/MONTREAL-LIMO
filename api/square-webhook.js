// Montreal Limo Services — Square payment webhook (Vercel serverless function).
// Square calls this whenever a payment is created/updated. When a payment is
// COMPLETED, the full booking details (everything the customer entered in the
// website booking form, carried in the payment note) are emailed to the
// business inbox via Resend — the same email setup as the Tremblant site.
//
// Safety: the notification payload is never trusted. The payment is re-fetched
// from Square's API with our access token and must be COMPLETED before any
// email is sent, so a forged notification cannot produce a fake booking email.
// Duplicates: the order is flagged (metadata booking_email_sent) after a
// successful send, so Square's multiple events for one payment email once.
//
// Required environment variables (Vercel project settings — never commit secrets):
//   SQUARE_ACCESS_TOKEN  Production access token from the Square Developer Dashboard
//   SQUARE_LOCATION_ID   Square location ID for Montreal Limo Services INC
//   RESEND_API_KEY       API key from the Resend account (emails the notification)
// Optional:
//   BOOKING_NOTIFY_EMAIL  Where booking emails go (default info@montreallimoservice.ca)
//   RESEND_FROM           Sender (default uses the Resend-verified Tremblant domain)
//   SQUARE_ENV            "sandbox" to use the sandbox API, anything else = production

// Env values are trimmed: a pasted secret can carry stray spaces or return
// characters (Vercel warns about them in the dashboard), which would
// otherwise silently break API authentication.
function env(name) {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : v;
}

const NOTIFY_TO = env("BOOKING_NOTIFY_EMAIL") || "info@montreallimoservice.ca";
const EMAIL_FROM = env("RESEND_FROM") || "Montreal Limo Bookings <bookings@monttremblantlimoservices.com>";

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(m) {
  if (!m || typeof m.amount !== "number") return "-";
  return "$" + (m.amount / 100).toFixed(2) + " " + (m.currency || "CAD");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const token = env("SQUARE_ACCESS_TOKEN");
  if (!token) return res.status(503).json({ ok: false, error: "Square is not configured." });

  const base = env("SQUARE_ENV") === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
  const headers = {
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json",
    "Square-Version": "2024-06-04",
  };

  try {
    const evt = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (evt.type !== "payment.created" && evt.type !== "payment.updated") {
      return res.status(200).json({ ok: true, ignored: "event type" });
    }
    const paymentId =
      (evt.data && evt.data.object && evt.data.object.payment && evt.data.object.payment.id) ||
      (evt.data && evt.data.id) || null;
    if (!paymentId) return res.status(200).json({ ok: true, ignored: "no payment id" });

    // Re-fetch the payment from Square — never trust the payload.
    const pr = await fetch(base + "/v2/payments/" + encodeURIComponent(paymentId), { headers });
    if (pr.status === 404) return res.status(200).json({ ok: true, ignored: "payment not found" });
    const pdata = await pr.json().catch(() => ({}));
    const payment = pdata.payment;
    if (!pr.ok || !payment) return res.status(200).json({ ok: true, ignored: "payment unreadable" });
    if (payment.status !== "COMPLETED") {
      return res.status(200).json({ ok: true, ignored: "status " + payment.status });
    }
    // Only payments from our payment links carry an order with our note.
    if (!payment.order_id) return res.status(200).json({ ok: true, ignored: "no order" });

    const or = await fetch(base + "/v2/orders/" + encodeURIComponent(payment.order_id), { headers });
    const odata = await or.json().catch(() => ({}));
    const order = odata.order || {};
    if (order.metadata && order.metadata.booking_email_sent === "1") {
      return res.status(200).json({ ok: true, ignored: "already emailed" });
    }

    const resendKey = env("RESEND_API_KEY");
    if (!resendKey) {
      // 503 so Square retries later — if the key is added within Square's
      // retry window, the retried delivery will send the booking email.
      console.error("RESEND_API_KEY missing — cannot email booking " + payment.id);
      return res.status(503).json({ ok: false, error: "Email is not configured yet." });
    }

    const note = String(payment.note || "").trim();
    const noteRows = note
      ? note.split("\n").filter(Boolean).map((line) => {
          const i = line.indexOf(":");
          if (i > 0) return "<p><b>" + esc(line.slice(0, i + 1)) + "</b> " + esc(line.slice(i + 1).trim()) + "</p>";
          return "<p>" + esc(line) + "</p>";
        }).join("\n")
      : "<p>(no booking note attached)</p>";

    const title = (order.line_items && order.line_items[0] && order.line_items[0].name) || "Limo trip";
    const when = payment.created_at
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" }).format(new Date(payment.created_at))
      : "-";
    const card = payment.card_details && payment.card_details.card
      ? (payment.card_details.card.card_brand || "Card") + " •••• " + (payment.card_details.card.last_4 || "")
      : "-";

    const subject = "New PAID booking — " + title + " — " + money(payment.amount_money);
    const html =
      '<div style="font-family:Arial,sans-serif;line-height:1.55;color:#111827">' +
      "<h2>New paid booking 🔔</h2>" +
      "<p><b>Total paid:</b> " + esc(money(payment.amount_money)) +
      (payment.tip_money && payment.tip_money.amount ? " (includes tip " + esc(money(payment.tip_money)) + ")" : "") + "</p>" +
      "<p><b>Paid at:</b> " + esc(when) + " (Montreal time)</p>" +
      "<p><b>Card:</b> " + esc(card) + "</p>" +
      "<p><b>Customer email (Square):</b> " + esc(payment.buyer_email_address || "-") + "</p>" +
      "<hr/>" + noteRows + "<hr/>" +
      (payment.receipt_url ? '<p><a href="' + esc(payment.receipt_url) + '">Square receipt</a> · Payment ID: ' + esc(payment.id) + "</p>" : "<p>Payment ID: " + esc(payment.id) + "</p>") +
      "</div>";
    const text =
      "New paid booking\nTotal paid: " + money(payment.amount_money) +
      (payment.tip_money && payment.tip_money.amount ? " (includes tip " + money(payment.tip_money) + ")" : "") +
      "\nPaid at: " + when + " (Montreal time)\nCard: " + card +
      "\nCustomer email (Square): " + (payment.buyer_email_address || "-") +
      "\n\n" + (note || "(no booking note attached)") +
      "\n\nPayment ID: " + payment.id + (payment.receipt_url ? "\nReceipt: " + payment.receipt_url : "");

    const er = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + resendKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [NOTIFY_TO],
        reply_to: "info@montreallimoservice.ca",
        subject: subject,
        html: html,
        text: text,
      }),
    });
    const edata = await er.json().catch(() => ({}));
    if (!er.ok || !edata.id) {
      console.error("Resend send failed:", JSON.stringify(edata).slice(0, 400));
      return res.status(502).json({ ok: false, error: "Email send failed." });
    }

    // Flag the order so duplicate payment events don't email twice.
    try {
      await fetch(base + "/v2/orders/" + encodeURIComponent(payment.order_id), {
        method: "PUT",
        headers,
        body: JSON.stringify({
          order: {
            version: order.version,
            metadata: Object.assign({}, order.metadata || {}, { booking_email_sent: "1" }),
          },
        }),
      });
    } catch (e) {
      console.error("Order flag failed (email was sent):", e);
    }

    return res.status(200).json({ ok: true, emailed: NOTIFY_TO, email_id: edata.id });
  } catch (err) {
    console.error("Square webhook error:", err);
    return res.status(500).json({ ok: false, error: "Webhook error." });
  }
};
