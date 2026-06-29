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
  promoted: number;
  catalog_url: string | null;
  catalog_file_id: string | null;
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
    return { success: false, error: "Apps Script returned a non-JSON response (check the /exec URL).", raw: text.slice(0, 500) };
  }
}

const NOW_LOCAL = "STRFTIME('%Y-%m-%d %H:%M:%S','NOW','localtime')";

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

// POST /api/upload
//   { check: true, fileHash }                                  -> cheap lookup; says if this content is already promoted.
//   { isCatalogItem: true, fileName, ... }                     -> manual Master-Catalog lookup (forwarded to GAS).
//   { fileName, tokenNumber, fileBase64, mimeType, fileHash }  -> real upload with dedup/auto-promotion.
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    let payload: any;
    try {
      payload = await context.request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const db = context.env.DB;
    const fileHash = typeof payload.fileHash === "string" && payload.fileHash.length > 0 ? payload.fileHash : null;

    // ---- Mode 1: cheap promotion check (no file bytes uploaded) ----
    if (payload.check === true) {
      if (!fileHash) return json({ success: true, promoted: false, hit_count: 0 });
      const row = await db
        .prepare("SELECT promoted, catalog_url, hit_count FROM catalog WHERE file_hash = ?")
        .bind(fileHash)
        .first<CatalogRow>();
      if (row && row.promoted === 1 && row.catalog_url) {
        return json({ success: true, promoted: true, webViewLink: row.catalog_url, hit_count: row.hit_count });
      }
      return json({ success: true, promoted: false, hit_count: row ? row.hit_count : 0 });
    }

    // ---- Mode 2: manual Master-Catalog lookup (existing feature, untouched) ----
    if (payload.isCatalogItem === true) {
      const data = await callGas(payload);
      return json(data, data && data.success ? 200 : 502);
    }

    // ---- Mode 3: real upload ----

    // No usable hash -> dedup disabled; plain upload to Daily Pending (legacy behavior).
    if (!fileHash) {
      const data = await callGas({
        fileName: payload.fileName,
        tokenNumber: payload.tokenNumber,
        fileBase64: payload.fileBase64,
        isCatalogItem: false,
        mimeType: payload.mimeType,
        target: "pending",
      });
      if (!data || data.success !== true || !data.webViewLink) {
        return json({ success: false, error: data && data.error ? data.error : "Drive upload failed." }, 502);
      }
      return json({ success: true, webViewLink: data.webViewLink, fileId: data.fileId, fileName: data.fileName, promoted: false, fromCatalog: false });
    }

    // Atomically bump the counter (single statement), then read the row.
    // Two statements instead of RETURNING for maximum D1 compatibility.
    await db
      .prepare(
        `INSERT INTO catalog (file_hash, file_name, hit_count, updated_at)
         VALUES (?, ?, 1, ${NOW_LOCAL})
         ON CONFLICT(file_hash) DO UPDATE SET
           hit_count = hit_count + 1,
           file_name = excluded.file_name,
           updated_at = excluded.updated_at`
      )
      .bind(fileHash, payload.fileName || "")
      .run();

    const state = await db
      .prepare("SELECT hit_count, promoted, catalog_url, catalog_file_id FROM catalog WHERE file_hash = ?")
      .bind(fileHash)
      .first<CatalogRow>();

    // Already promoted -> serve the permanent copy instantly, no upload at all.
    if (state && state.promoted === 1 && state.catalog_url) {
      return json({
        success: true,
        webViewLink: state.catalog_url,
        fileId: state.catalog_file_id,
        fileName: payload.fileName,
        promoted: true,
        fromCatalog: true,
        cached: true,
      });
    }

    const hitCount = state ? state.hit_count : 1;

    // Claim promotion atomically so only ONE concurrent uploader creates the
    // permanent copy: "WHERE promoted = 0" makes the winner unique.
    let promoteThis = false;
    if (hitCount >= PROMOTE_THRESHOLD) {
      const claim = await db
        .prepare(`UPDATE catalog SET promoted = 1, updated_at = ${NOW_LOCAL} WHERE file_hash = ? AND promoted = 0`)
        .bind(fileHash)
        .run();
      promoteThis = (claim.meta?.changes ?? 0) === 1;
    }

    // Upload to the chosen Drive folder.
    const data = await callGas({
      fileName: payload.fileName,
      tokenNumber: payload.tokenNumber,
      fileBase64: payload.fileBase64,
      isCatalogItem: false,
      mimeType: payload.mimeType,
      target: promoteThis ? "catalog" : "pending",
      fileHash: fileHash,
    });

    if (!data || data.success !== true || !data.webViewLink) {
      // Release a promotion claim we could not fulfil, so a later upload can retry.
      if (promoteThis) {
        await db.prepare(`UPDATE catalog SET promoted = 0 WHERE file_hash = ?`).bind(fileHash).run();
      }
      return json({ success: false, error: data && data.error ? data.error : "Drive upload failed." }, 502);
    }

    // Persist the permanent link if this upload won the promotion.
    if (promoteThis) {
      await db
        .prepare(`UPDATE catalog SET catalog_url = ?, catalog_file_id = ?, updated_at = ${NOW_LOCAL} WHERE file_hash = ?`)
        .bind(data.webViewLink, data.fileId || null, fileHash)
        .run();
    }

    return json({
      success: true,
      webViewLink: data.webViewLink,
      fileId: data.fileId,
      fileName: data.fileName,
      promoted: promoteThis,
      fromCatalog: promoteThis,
    });
  } catch (err) {
    return json({ success: false, error: String(err) }, 502);
  }
};
