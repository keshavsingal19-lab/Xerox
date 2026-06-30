/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
}

// The deployed Google Apps Script Web App /exec URL.
// IMPORTANT: use the plain /macros/s/<id>/exec form — do NOT include a /u/<n>/
// account segment, or student browsers get redirected into a Google login.
const GAS_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbz0IxcKOyFLD-o-WPKbq-qvLAmgJJSB1aFgVJf159icd9-NyFPjkSDnhk2ntsPm7Zdu/exec";

// Identical uploads needed before a file is promoted to the permanent Master Catalog.
const PROMOTE_THRESHOLD = 3;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8", ...CORS_HEADERS },
  });
}

interface CatalogRow {
  file_hash: string;
  file_name: string;
  hit_count: number;
  drive_url: string | null;
  drive_file_id: string | null;
  tier: string;
}

// Forward a payload to Apps Script server-to-server (no browser CORS) and parse its JSON.
async function callGas(bodyObj: unknown): Promise<any> {
  const upstream = await fetch(GAS_WEB_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(bodyObj),
    redirect: "follow",
  });
  const text = await upstream.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      success: false,
      error: "Apps Script returned a non-JSON response (check the /exec URL).",
      raw: text.slice(0, 500),
    };
  }
}

// Local-time "now" and the two retention windows, expressed as SQLite STRFTIME.
const NOW_LOCAL = "STRFTIME('%Y-%m-%d %H:%M:%S','NOW','localtime')";
const PLUS_2_HOURS = "STRFTIME('%Y-%m-%d %H:%M:%S','NOW','+2 hours','localtime')";
const PLUS_3_DAYS = "STRFTIME('%Y-%m-%d %H:%M:%S','NOW','+3 days','localtime')";

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

// POST /api/upload
//   (1) RESOLVE  { check: true, fileHash }
//       Look up a NON-EXPIRED catalog row that already has a Drive link.
//       Found  -> bump hit_count + last_seen; if hit_count>=3 and tier='pending'
//                 PROMOTE (GAS copies into the Master Catalog, 3-day retention)
//                 and serve the catalog copy. Returns { reuse:true, webViewLink, promoted }.
//       Missing-> { reuse:false } (no counter change).
//   (2) UPLOAD   { fileName, tokenNumber, fileBase64, mimeType, fileHash }
//       Store the bytes in Daily Pending via GAS, then UPSERT the catalog row
//       (hit_count 1 on insert / +1 on conflict), refresh the link, last_seen=now,
//       expires_at = now + 2 hours, tier stays 'pending'. Returns { webViewLink, reuse:false }.
//   (3) MANUAL   { isCatalogItem: true, ... }  -> forwarded to GAS unchanged.
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    let payload: any;
    try {
      payload = await context.request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const db = context.env.DB;
    const fileHash =
      typeof payload.fileHash === "string" && payload.fileHash.length > 0 ? payload.fileHash : null;

    // ---- Mode 1: RESOLVE (cheap reuse lookup, no file bytes) ----
    if (payload.check === true) {
      if (!fileHash) return json({ success: true, reuse: false });

      // Only a non-expired row that already carries a Drive link is reusable.
      const row = await db
        .prepare(
          `SELECT file_hash, file_name, hit_count, drive_url, drive_file_id, tier
             FROM catalog
            WHERE file_hash = ?
              AND drive_url IS NOT NULL
              AND expires_at IS NOT NULL
              AND expires_at > ${NOW_LOCAL}`
        )
        .bind(fileHash)
        .first<CatalogRow>();

      if (!row) {
        // No valid reusable copy — do NOT touch the counter.
        return json({ success: true, reuse: false });
      }

      // A valid reusable hit: count it and refresh recency.
      await db
        .prepare(
          `UPDATE catalog SET hit_count = hit_count + 1, last_seen = ${NOW_LOCAL} WHERE file_hash = ?`
        )
        .bind(fileHash)
        .run();

      const newHitCount = row.hit_count + 1;

      // The 3rd hit while still 'pending' promotes this content into the Master
      // Catalog (3-day retention). GAS copies the existing pending file.
      if (newHitCount >= PROMOTE_THRESHOLD && row.tier === "pending" && row.drive_file_id) {
        const promo = await callGas({ action: "promote", fileId: row.drive_file_id });
        if (promo && promo.success === true && promo.webViewLink) {
          await db
            .prepare(
              `UPDATE catalog
                  SET tier = 'promoted',
                      drive_url = ?,
                      drive_file_id = ?,
                      expires_at = ${PLUS_3_DAYS},
                      last_seen = ${NOW_LOCAL}
                WHERE file_hash = ?`
            )
            .bind(promo.webViewLink, promo.fileId || row.drive_file_id, fileHash)
            .run();

          return json({ success: true, reuse: true, webViewLink: promo.webViewLink, promoted: true });
        }
        // Promotion failed: still serve the existing valid pending copy instantly.
        return json({ success: true, reuse: true, webViewLink: row.drive_url, promoted: false });
      }

      // Valid reusable copy, no promotion this time.
      return json({ success: true, reuse: true, webViewLink: row.drive_url, promoted: false });
    }

    // ---- Mode 3: manual Master-Catalog lookup (forwarded to GAS unchanged) ----
    if (payload.isCatalogItem === true) {
      const data = await callGas(payload);
      return json(data, data && data.success ? 200 : 502);
    }

    // ---- Mode 2: real UPLOAD (store bytes in Daily Pending, then UPSERT catalog) ----
    const data = await callGas({
      fileName: payload.fileName,
      tokenNumber: payload.tokenNumber,
      fileBase64: payload.fileBase64,
      isCatalogItem: false,
      mimeType: payload.mimeType,
      target: "pending",
      fileHash: fileHash,
    });

    if (!data || data.success !== true || !data.webViewLink) {
      return json(
        { success: false, error: data && data.error ? data.error : "Drive upload failed." },
        502
      );
    }

    // Record / refresh the reusable master for the next 2 hours.
    if (fileHash) {
      await db
        .prepare(
          `INSERT INTO catalog
             (file_hash, file_name, hit_count, drive_url, drive_file_id, tier, first_seen, last_seen, expires_at)
           VALUES (?, ?, 1, ?, ?, 'pending', ${NOW_LOCAL}, ${NOW_LOCAL}, ${PLUS_2_HOURS})
           ON CONFLICT(file_hash) DO UPDATE SET
             hit_count = hit_count + 1,
             file_name = excluded.file_name,
             drive_url = excluded.drive_url,
             drive_file_id = excluded.drive_file_id,
             tier = 'pending',
             last_seen = excluded.last_seen,
             expires_at = excluded.expires_at`
        )
        .bind(fileHash, payload.fileName || "", data.webViewLink, data.fileId || null)
        .run();
    }

    return json({
      success: true,
      webViewLink: data.webViewLink,
      fileId: data.fileId,
      fileName: data.fileName,
      reuse: false,
    });
  } catch (err) {
    return json({ success: false, error: String(err) }, 502);
  }
};
