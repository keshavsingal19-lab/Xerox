/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8", ...CORS_HEADERS },
  });
}

/**
 * Pricing model (volume tiers). The per-page rate falls as the TOTAL number of
 * printout units (sum of pages*copies across ALL documents in the order) rises.
 * For each tier, four rates cover B&W/Color x Single/Double-sided, per page.
 *
 * Cost of one document = rate(doc.color, doc.layout, selectedTier) * doc.pages * doc.copies.
 * The selected tier = the tier with the largest minPages <= total units.
 */
const RATE_KEYS = ["bw_single", "bw_double", "color_single", "color_double"] as const;

const DEFAULT_PRICING = {
  currency: "₹",
  tiers: [
    { minPages: 1, rates: { bw_single: 3, bw_double: 3, color_single: 10, color_double: 10 } },
    { minPages: 5, rates: { bw_single: 2, bw_double: 2, color_single: 8, color_double: 8 } },
    { minPages: 20, rates: { bw_single: 1.5, bw_double: 1.5, color_single: 6, color_double: 6 } },
  ],
};

function validatePricing(p: any): { ok: true; value: any } | { ok: false; error: string } {
  if (!p || typeof p !== "object") return { ok: false, error: "pricing must be an object" };
  if (!Array.isArray(p.tiers) || p.tiers.length === 0) return { ok: false, error: "at least one tier is required" };

  const cleanTiers: any[] = [];
  for (const t of p.tiers) {
    const minPages = Number(t?.minPages);
    if (!Number.isFinite(minPages) || minPages < 1) return { ok: false, error: "each tier needs minPages >= 1" };
    const rates: Record<string, number> = {};
    for (const k of RATE_KEYS) {
      const v = Number(t?.rates?.[k]);
      if (!Number.isFinite(v) || v < 0) return { ok: false, error: `tier (minPages ${minPages}) is missing a valid ${k} rate` };
      rates[k] = v;
    }
    cleanTiers.push({ minPages: Math.floor(minPages), rates });
  }

  // Sort ascending by minPages; ensure a base tier starting at 1.
  cleanTiers.sort((a, b) => a.minPages - b.minPages);
  if (cleanTiers[0].minPages !== 1) return { ok: false, error: "the first tier must start at minPages = 1" };

  const currency = typeof p.currency === "string" && p.currency.length <= 4 ? p.currency : "₹";
  return { ok: true, value: { currency, tiers: cleanTiers } };
}

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

// GET /api/pricing -> the current pricing model (or the built-in default). Public.
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const row = await context.env.DB.prepare("SELECT value FROM settings WHERE key = 'pricing'").first<{ value: string }>();
    if (row && row.value) {
      try {
        const parsed = JSON.parse(row.value);
        const v = validatePricing(parsed);
        return json({ success: true, pricing: v.ok ? v.value : DEFAULT_PRICING });
      } catch {
        return json({ success: true, pricing: DEFAULT_PRICING });
      }
    }
    return json({ success: true, pricing: DEFAULT_PRICING });
  } catch (err) {
    return json({ success: false, error: String(err), pricing: DEFAULT_PRICING }, 500);
  }
};

// POST /api/pricing { pricing } -> save the model. Auth-gated by _middleware.
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    let body: any;
    try {
      body = await context.request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const incoming = body && body.pricing ? body.pricing : body;
    const v = validatePricing(incoming);
    if (!v.ok) return json({ success: false, error: v.error }, 400);

    await context.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('pricing', ?, STRFTIME('%Y-%m-%d %H:%M:%S','NOW','localtime'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
      .bind(JSON.stringify(v.value))
      .run();

    return json({ success: true, pricing: v.value });
  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};
