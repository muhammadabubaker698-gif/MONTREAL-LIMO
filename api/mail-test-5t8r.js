// TEMPORARY one-time test — sends ONE clearly-labeled test email through
// Resend using the project's RESEND_API_KEY, proving the booking-alert email
// path (key + sender domain + delivery to the business inbox) works before
// the first real customer payment. Keyed, time-boxed, deleted after use.

const DEADLINE = Date.parse("2026-11-01T06:00:00Z"); // 2026-11-01 02:00 EDT
const ONE_TIME_KEY = "m5t8r2-test-once";

module.exports = async function handler(req, res) {
  if (Date.now() > DEADLINE) return res.status(410).json({ ok: false, error: "Expired." });
  if (!req.query || req.query.key !== ONE_TIME_KEY) return res.status(404).json({ ok: false, error: "Not found." });

  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ ok: false, error: "RESEND_API_KEY is not visible to this deployment yet." });
  }

  // Shape-only diagnostics (never the value): identifies WHAT was pasted —
  // a real Resend key is "re_" + ~33 chars, no spaces, no dashes.
  const _k = process.env.RESEND_API_KEY;
  const shape = {
    len: _k.length,
    starts_re: _k.startsWith("re_"),
    has_space: /\s/.test(_k),
    has_dash: _k.includes("-"),
  };

  const from = process.env.RESEND_FROM || "Montreal Limo Bookings <bookings@monttremblantlimoservices.com>";
  const to = process.env.BOOKING_NOTIFY_EMAIL || "info@montreallimoservice.ca";

  try {
    const er = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: from,
        to: [to],
        reply_to: "info@montreallimoservice.ca",
        subject: "Test — Montreal Limo booking alerts are working ✅",
        html: '<div style="font-family:Arial,sans-serif;line-height:1.55;color:#111827"><h2>Booking alerts are live 🔔</h2><p>This is a one-time test email from the Montreal Limo Services website setup.</p><p>From now on, whenever a customer pays for a booking on montreallimoservice.ca, a second email like this one will arrive here with <b>all</b> the booking details: customer name, phone, pickup, drop-off, date and time, vehicle, price estimate, amount paid, tip, and the Square receipt link.</p><p>No action is needed — you can delete this test.</p></div>',
        text: "Booking alerts are live. This is a one-time test email from the Montreal Limo Services website setup. From now on, whenever a customer pays for a booking on montreallimoservice.ca, an email will arrive here with all the booking details. No action is needed — you can delete this test.",
      }),
    });
    const data = await er.json().catch(() => ({}));
    if (!er.ok || !data.id) {
      console.error("Test email failed:", JSON.stringify(data).slice(0, 400));
      return res.status(502).json({ ok: false, error: "Resend rejected the test email.", detail: data, shape: shape });
    }
    return res.status(200).json({ ok: true, email_id: data.id, to: to, from: from, shape: shape });
  } catch (err) {
    console.error("Mail test error:", err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err).slice(0, 300) });
  }
};
