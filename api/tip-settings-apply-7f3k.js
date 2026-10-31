// TEMPORARY one-time admin endpoint — sets the Square payment-link tip
// settings for the Montreal Limo location: percentage tips 15/20/25 with
// 20% preselected (owner's choice, 2026-10-31). The Square Dashboard for
// this account does not render the Tipping section, so the change is made
// through Square's Checkout API location-settings endpoints instead.
// Guards: requires a one-time key, self-disables after the deadline below,
// and this file is deleted immediately after a successful run.

const DEADLINE = Date.parse("2026-11-01T00:00:00Z"); // 2026-10-31 20:00 EDT
const ONE_TIME_KEY = "b7f3k9-apply-once";

module.exports = async function handler(req, res) {
  if (Date.now() > DEADLINE) return res.status(410).json({ ok: false, error: "Expired." });
  if (!req.query || req.query.key !== ONE_TIME_KEY) return res.status(404).json({ ok: false, error: "Not found." });

  const token = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!token || !locationId) {
    return res.status(503).json({ ok: false, error: "Square is not configured." });
  }

  const base = process.env.SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
  const url = base + "/v2/online-checkout/location-settings/" + encodeURIComponent(locationId);
  const headers = {
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json",
    "Square-Version": "2024-06-04",
  };

  async function getSettings() {
    const r = await fetch(url, { method: "GET", headers });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("GET settings failed: " + JSON.stringify(data.errors || data).slice(0, 300));
    return data.location_settings || {};
  }

  try {
    const before = (await getSettings()).tipping || null;

    const put = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        location_settings: {
          tipping: {
            percentages: [15, 20, 25],
            smart_tipping_enabled: false,
            default_percent: 20,
          },
        },
      }),
    });
    const putData = await put.json().catch(() => ({}));
    if (!put.ok) {
      console.error("Square tip settings update failed:", JSON.stringify(putData).slice(0, 600));
      return res.status(502).json({ ok: false, error: "Square rejected the update.", detail: putData.errors || putData });
    }

    const after = (await getSettings()).tipping || null;
    return res.status(200).json({ ok: true, before: before, after: after });
  } catch (err) {
    console.error("Tip settings endpoint error:", err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err).slice(0, 300) });
  }
};
