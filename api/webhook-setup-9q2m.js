// TEMPORARY one-time setup endpoint — creates the Square webhook subscription
// that points payment events at /api/square-webhook (booking email alerts).
// Keyed, time-boxed, lists existing subscriptions first to avoid duplicates,
// and never returns the subscription signature key. Deleted after use.

const DEADLINE = Date.parse("2026-11-01T06:00:00Z"); // 2026-11-01 02:00 EDT
const ONE_TIME_KEY = "w9q2m7-setup-once";
const NOTIFICATION_URL = "https://montreal-limo.vercel.app/api/square-webhook";

module.exports = async function handler(req, res) {
  if (Date.now() > DEADLINE) return res.status(410).json({ ok: false, error: "Expired." });
  if (!req.query || req.query.key !== ONE_TIME_KEY) return res.status(404).json({ ok: false, error: "Not found." });

  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ ok: false, error: "Square is not configured." });

  const base = process.env.SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
  const headers = {
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json",
    "Square-Version": "2024-06-04",
  };

  try {
    const lr = await fetch(base + "/v2/webhooks/subscriptions", { headers });
    const ldata = await lr.json().catch(() => ({}));
    const existing = (ldata.subscriptions || []).filter((s) => s.notification_url === NOTIFICATION_URL);
    if (existing.length) {
      return res.status(200).json({
        ok: true,
        already: true,
        subscriptions: existing.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled, event_types: s.event_types })),
      });
    }

    const cr = await fetch(base + "/v2/webhooks/subscriptions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotency_key: "montreal-limo-webhook-" + Date.now().toString(36),
        subscription: {
          name: "Montreal Limo booking email alerts",
          event_types: ["payment.created", "payment.updated"],
          notification_url: NOTIFICATION_URL,
          api_version: "2024-06-04",
          enabled: true,
        },
      }),
    });
    const cdata = await cr.json().catch(() => ({}));
    if (!cr.ok || !cdata.subscription) {
      console.error("Webhook subscription create failed:", JSON.stringify(cdata).slice(0, 600));
      return res.status(502).json({ ok: false, error: "Create failed.", detail: cdata.errors || cdata });
    }
    const s = cdata.subscription;
    return res.status(200).json({
      ok: true,
      created: { id: s.id, name: s.name, enabled: s.enabled, event_types: s.event_types, notification_url: s.notification_url },
    });
  } catch (err) {
    console.error("Webhook setup error:", err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err).slice(0, 300) });
  }
};
