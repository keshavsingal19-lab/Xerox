/// <reference types="@cloudflare/workers-types" />

// =============================================================================
// /api/upload  —  raw bytes -> Google Drive via OAuth (NO Apps Script in the
// byte path), plus content-hash dedup / reuse / promote against the D1 catalog.
//
// One endpoint, two ops, distinguished by the request header "x-op":
//   * x-op: "resolve"  -> JSON { fileHash }.  Cheap reuse lookup (+ promote).
//   * otherwise         -> the request BODY is the RAW file bytes. Metadata is
//                          carried in x-file-name / x-file-hash / x-token /
//                          x-mime / x-file-size headers. Buffered upload to the
//                          PENDING Drive folder, permission, catalog UPSERT (2h).
//
// Apps Script survives ONLY as the scheduled janitor (storageCleanup); it must
// stay the same Google account that owns GOOGLE_REFRESH_TOKEN so it can delete.
// =============================================================================

interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  DRIVE_PENDING_FOLDER_ID?: string;
  DRIVE_CATALOG_FOLDER_ID?: string;
}

// Identical uploads needed before a file is promoted to the permanent Master Catalog.
const PROMOTE_THRESHOLD = 3;

// Files are <=25MB; buffering the whole body is fine and lets us retry safely.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, x-op, x-file-name, x-file-hash, x-token, x-mime, x-file-size",
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

// Local-time "now" and the two retention windows, expressed as SQLite STRFTIME.
const NOW_LOCAL = "STRFTIME('%Y-%m-%d %H:%M:%S','NOW','localtime')";
const PLUS_2_HOURS = "STRFTIME('%Y-%m-%d %H:%M:%S','NOW','+2 hours','localtime')";
const PLUS_3_DAYS = "STRFTIME('%Y-%m-%d %H:%M:%S','NOW','+3 days','localtime')";

// -----------------------------------------------------------------------------
// Google OAuth: refresh-token grant, cached in a module-scope variable.
// -----------------------------------------------------------------------------
let cachedAccessToken: string | null = null;
let cachedTokenExpiry = 0; // epoch ms; token is valid while Date.now() < this.

function driveConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

/**
 * Exchange the refresh token for a short-lived access token, caching it in a
 * module-scope variable until ~60s before it expires. Pass force=true to bypass
 * the cache (used once on a 401 from a Drive call).
 */
async function getAccessToken(env: Env, force = false): Promise<string> {
  if (!force && cachedAccessToken && Date.now() < cachedTokenExpiry) {
    return cachedAccessToken;
  }

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID as string,
    client_secret: env.GOOGLE_CLIENT_SECRET as string,
    refresh_token: env.GOOGLE_REFRESH_TOKEN as string,
    grant_type: "refresh_token",
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`OAuth token exchange failed (${resp.status}): ${detail.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("OAuth token exchange returned no access_token");
  }

  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  cachedAccessToken = data.access_token;
  cachedTokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  return cachedAccessToken;
}

// -----------------------------------------------------------------------------
// Retry helpers: 429 / >=500 get a jittered exponential backoff, up to ~4 tries.
// A failed resumable session creates NO file, so re-initiate + re-PUT from the
// same buffer is duplicate-free.
// -----------------------------------------------------------------------------
const MAX_RETRIES = 4;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffDelay(attempt: number): number {
  // 2^n * 400ms + up to 400ms jitter.
  return Math.pow(2, attempt) * 400 + Math.floor(Math.random() * 400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DriveFile {
  id: string;
  webViewLink: string;
}

/**
 * Upload raw bytes to a Drive folder using a RESUMABLE session, buffered so it is
 * safely retryable. Returns { id, webViewLink }. Throws on non-retryable failure
 * or after exhausting retries. Retries the WHOLE session (initiate + PUT) so a
 * dead session never leaves a partial/duplicate file.
 */
async function driveResumableUpload(
  env: Env,
  bytes: ArrayBuffer,
  meta: { name: string; parents: string[]; mimeType: string }
): Promise<DriveFile> {
  let token = await getAccessToken(env);
  let triedRefresh = false;
  let lastError = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt - 1));

    // (1) INITIATE the resumable session.
    const initResp = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({
          name: meta.name,
          parents: meta.parents,
          mimeType: meta.mimeType,
        }),
      }
    );

    if (initResp.status === 401 && !triedRefresh) {
      // Force one refresh + retry from the top.
      triedRefresh = true;
      token = await getAccessToken(env, true);
      attempt--; // this iteration did not count against the backoff schedule.
      continue;
    }

    if (!initResp.ok) {
      lastError = `initiate ${initResp.status}: ${(await initResp.text().catch(() => "")).slice(0, 300)}`;
      if (isRetryable(initResp.status)) continue;
      throw new Error(`Drive resumable initiate failed — ${lastError}`);
    }

    const sessionUrl = initResp.headers.get("Location");
    if (!sessionUrl) {
      lastError = "initiate returned no Location header";
      continue;
    }

    // (2) PUT the bytes into the session URL.
    const putResp = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Length": String(bytes.byteLength) },
      body: bytes,
    });

    if (putResp.status === 401 && !triedRefresh) {
      triedRefresh = true;
      token = await getAccessToken(env, true);
      attempt--;
      continue;
    }

    if (putResp.status === 200 || putResp.status === 201) {
      const file = (await putResp.json()) as Partial<DriveFile>;
      if (!file.id) {
        lastError = "PUT succeeded but returned no file id";
        continue;
      }
      return { id: file.id, webViewLink: file.webViewLink ?? "" };
    }

    lastError = `PUT ${putResp.status}: ${(await putResp.text().catch(() => "")).slice(0, 300)}`;
    if (isRetryable(putResp.status)) continue;
    throw new Error(`Drive resumable PUT failed — ${lastError}`);
  }

  throw new Error(`Drive resumable upload exhausted retries — ${lastError}`);
}

/**
 * Make a Drive file openable by the (unauthenticated) shopkeeper browser link:
 * grant an anyone/reader permission. Retries on 429/5xx; refreshes once on 401.
 */
async function driveSetAnyoneReader(env: Env, fileId: string): Promise<void> {
  let token = await getAccessToken(env);
  let triedRefresh = false;
  let lastError = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt - 1));

    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ role: "reader", type: "anyone" }),
      }
    );

    if (resp.status === 401 && !triedRefresh) {
      triedRefresh = true;
      token = await getAccessToken(env, true);
      attempt--;
      continue;
    }

    if (resp.ok) return;

    lastError = `${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`;
    if (isRetryable(resp.status)) continue;
    throw new Error(`Drive set-permission failed — ${lastError}`);
  }

  throw new Error(`Drive set-permission exhausted retries — ${lastError}`);
}

/**
 * PROMOTE: copy a pending Drive file into the Master Catalog folder (3-day tier).
 * Returns the NEW copy's { id, webViewLink }. The caller sets anyone/reader on it.
 */
async function driveCopy(
  env: Env,
  fileId: string,
  meta: { name: string; parents: string[] }
): Promise<DriveFile> {
  let token = await getAccessToken(env);
  let triedRefresh = false;
  let lastError = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt - 1));

    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/copy?fields=id,webViewLink`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ name: meta.name, parents: meta.parents }),
      }
    );

    if (resp.status === 401 && !triedRefresh) {
      triedRefresh = true;
      token = await getAccessToken(env, true);
      attempt--;
      continue;
    }

    if (resp.ok) {
      const file = (await resp.json()) as Partial<DriveFile>;
      if (!file.id) {
        lastError = "copy succeeded but returned no file id";
        continue;
      }
      return { id: file.id, webViewLink: file.webViewLink ?? "" };
    }

    lastError = `${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`;
    if (isRetryable(resp.status)) continue;
    throw new Error(`Drive copy (promote) failed — ${lastError}`);
  }

  throw new Error(`Drive copy (promote) exhausted retries — ${lastError}`);
}

// -----------------------------------------------------------------------------
// App-owned Drive folders. Under the drive.file scope (which needs NO Google
// verification) the app may only place files in folders IT created — never a
// folder made by hand in the Drive UI. So we find-or-create our own folders by
// name and cache the ids per isolate. The Apps Script janitor locates the same
// folders by these EXACT names, so keep them in sync with Code.gs.
// (env.DRIVE_*_FOLDER_ID stay as optional overrides but are normally unset.)
// -----------------------------------------------------------------------------
const PENDING_FOLDER_NAME = "CampusXerox_DailyPending";
const CATALOG_FOLDER_NAME = "CampusXerox_MasterCatalog";
let cachedPendingFolderId: string | null = null;
let cachedCatalogFolderId: string | null = null;

async function ensureFolder(env: Env, name: string): Promise<string> {
  let token = await getAccessToken(env);
  const listUrl =
    "https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1&fields=files(id)&q=" +
    encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`);

  let listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (listResp.status === 401) {
    token = await getAccessToken(env, true);
    listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (listResp.ok) {
    const data = (await listResp.json()) as { files?: Array<{ id?: string }> };
    if (data.files && data.files.length && data.files[0].id) return data.files[0].id;
  }

  // Not found -> create it (owned by, and therefore in-scope for, this app).
  const createBody = JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" });
  const createOnce = (t: string) =>
    fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json; charset=UTF-8" },
      body: createBody,
    });

  let createResp = await createOnce(token);
  if (createResp.status === 401) {
    token = await getAccessToken(env, true);
    createResp = await createOnce(token);
  }
  if (!createResp.ok) {
    throw new Error(`create folder "${name}" failed (${createResp.status})`);
  }
  const created = (await createResp.json()) as { id?: string };
  if (!created.id) throw new Error(`create folder "${name}" returned no id`);
  return created.id;
}

async function getPendingFolderId(env: Env): Promise<string> {
  if (env.DRIVE_PENDING_FOLDER_ID) return env.DRIVE_PENDING_FOLDER_ID;
  if (cachedPendingFolderId) return cachedPendingFolderId;
  cachedPendingFolderId = await ensureFolder(env, PENDING_FOLDER_NAME);
  return cachedPendingFolderId;
}

async function getCatalogFolderId(env: Env): Promise<string> {
  if (env.DRIVE_CATALOG_FOLDER_ID) return env.DRIVE_CATALOG_FOLDER_ID;
  if (cachedCatalogFolderId) return cachedCatalogFolderId;
  cachedCatalogFolderId = await ensureFolder(env, CATALOG_FOLDER_NAME);
  return cachedCatalogFolderId;
}

// -----------------------------------------------------------------------------
export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

// -----------------------------------------------------------------------------
// POST /api/upload — branches on the x-op header.
// -----------------------------------------------------------------------------
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const db = env.DB;
  const op = (request.headers.get("x-op") || "").toLowerCase();

  // ===========================================================================
  // OP 1: RESOLVE — cheap reuse lookup (+ promote-via-Drive-copy). JSON body.
  // ===========================================================================
  if (op === "resolve") {
    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const fileHash =
      typeof payload?.fileHash === "string" && payload.fileHash.length > 0
        ? payload.fileHash
        : null;

    if (!fileHash) return json({ success: true, reuse: false });

    try {
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

      // No valid reusable copy — do NOT touch the counter.
      if (!row) return json({ success: true, reuse: false });

      // A valid reusable hit: count it and refresh recency.
      await db
        .prepare(
          `UPDATE catalog SET hit_count = hit_count + 1, last_seen = ${NOW_LOCAL} WHERE file_hash = ?`
        )
        .bind(fileHash)
        .run();

      const newHitCount = row.hit_count + 1;

      // The 3rd hit while still 'pending' promotes this content into the Master
      // Catalog (3-day retention) via a Drive files.copy into the catalog folder.
      if (
        newHitCount >= PROMOTE_THRESHOLD &&
        row.tier === "pending" &&
        row.drive_file_id &&
        driveConfigured(env)
      ) {
        try {
          const parents = [await getCatalogFolderId(env)];
          const copy = await driveCopy(env, row.drive_file_id, {
            name: row.file_name || "XEROX_CATALOG",
            parents,
          });
          // Set anyone/reader on the NEW copy too.
          await driveSetAnyoneReader(env, copy.id);

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
            .bind(copy.webViewLink, copy.id, fileHash)
            .run();

          return json({
            success: true,
            reuse: true,
            webViewLink: copy.webViewLink,
            promoted: true,
          });
        } catch {
          // Promotion failed: still serve the existing valid pending copy instantly.
          return json({ success: true, reuse: true, webViewLink: row.drive_url, promoted: false });
        }
      }

      // Valid reusable copy, no promotion this time.
      return json({ success: true, reuse: true, webViewLink: row.drive_url, promoted: false });
    } catch (err) {
      return json({ success: false, error: String(err) }, 500);
    }
  }

  // ===========================================================================
  // OP 2: RAW UPLOAD — the request BODY is the raw file bytes; metadata in headers.
  // ===========================================================================

  // Drive must be configured before we accept any bytes.
  if (!driveConfigured(env)) {
    return json({ success: false, error: "Upload not configured" }, 503);
  }

  // ---- Metadata from headers ----
  let fileName = "";
  const rawName = request.headers.get("x-file-name") || "";
  try {
    fileName = decodeURIComponent(rawName);
  } catch {
    fileName = rawName;
  }

  const fileHashHeader = request.headers.get("x-file-hash") || "";
  const fileHash = fileHashHeader.length > 0 ? fileHashHeader : null;

  const token = (request.headers.get("x-token") || "").trim();
  const mimeType = request.headers.get("x-mime") || "application/octet-stream";

  // byteLength: prefer explicit x-file-size, else content-length.
  const sizeHeader =
    request.headers.get("x-file-size") || request.headers.get("content-length") || "";
  const declaredSize = Number(sizeHeader);

  if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES) {
    return json({ success: false, error: "File too large (max 25MB)" }, 400);
  }

  // ---- Buffer the raw body (retryable). ----
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    return json({ success: false, error: "Could not read request body" }, 400);
  }

  if (!bytes || bytes.byteLength === 0) {
    return json({ success: false, error: "Empty file body" }, 400);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return json({ success: false, error: "File too large (max 25MB)" }, 400);
  }

  // Drive display name for the pending copy.
  const displayName = `XEROX_TOKEN_${token || "NA"}_${fileName || "upload"}`;
  let parents: string[];
  try {
    parents = [await getPendingFolderId(env)];
  } catch (err) {
    return json({ success: false, error: `Drive folder setup failed: ${String(err)}` }, 502);
  }

  // ---- Upload -> permission. CONFIRMATION IS HONEST: only success after 200/201. ----
  let uploaded: DriveFile;
  try {
    uploaded = await driveResumableUpload(env, bytes, {
      name: displayName,
      parents,
      mimeType,
    });
    await driveSetAnyoneReader(env, uploaded.id);
  } catch (err) {
    return json({ success: false, error: `Drive upload failed: ${String(err)}` }, 502);
  }

  // ---- UPSERT the reusable catalog row (2h pending). tier reset to 'pending' on conflict. ----
  if (fileHash) {
    try {
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
        .bind(fileHash, fileName || displayName, uploaded.webViewLink, uploaded.id)
        .run();
    } catch (err) {
      // The bytes are safely in Drive; catalog bookkeeping failed. Still succeed
      // (the file is usable) but surface the DB error for observability.
      return json({
        success: true,
        webViewLink: uploaded.webViewLink,
        fileId: uploaded.id,
        reuse: false,
        catalogWarning: String(err),
      });
    }
  }

  return json({
    success: true,
    webViewLink: uploaded.webViewLink,
    fileId: uploaded.id,
    reuse: false,
  });
};
