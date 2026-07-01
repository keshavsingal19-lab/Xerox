/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  DRIVE_PENDING_FOLDER_ID?: string;
  DRIVE_CATALOG_FOLDER_ID?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8", ...CORS_HEADERS },
  });
}

// Sanitize a filename for safe use inside a quoted Content-Disposition header.
function safeFilename(name: string): string {
  return (name || "file").replace(/[\r\n"\\]/g, "_");
}

// ---------------------------------------------------------------------------
// Google OAuth access-token cache (module scope; self-contained on purpose —
// duplicated across Functions so each endpoint is independent).
// ---------------------------------------------------------------------------
let cachedAccessToken: string | null = null;
let cachedAccessTokenExpiry = 0; // epoch ms; token is valid while now < expiry

function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

async function getAccessToken(env: Env, forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && cachedAccessToken && now < cachedAccessTokenExpiry) {
    return cachedAccessToken;
  }

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID as string,
    client_secret: env.GOOGLE_CLIENT_SECRET as string,
    refresh_token: env.GOOGLE_REFRESH_TOKEN as string,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("Token exchange failed (" + res.status + "): " + text);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Token exchange returned no access_token");
  }

  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  return cachedAccessToken;
}

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
};

// GET /api/file?id=<driveFileId>
// Streams the raw Drive file bytes for the shopkeeper's direct-print flow using
// the operator OAuth token (no Apps Script in the byte path). Access to this
// endpoint is already enforced by _middleware.
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return json({ success: false, error: "Missing file id" }, 400);
  }

  if (!googleConfigured(env)) {
    return json({ success: false, error: "Upload not configured" }, 503);
  }

  const metaUrl =
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(id) +
    "?fields=name,mimeType";
  const mediaUrl =
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(id) +
    "?alt=media";

  try {
    // ---- Fetch metadata (name + mimeType), with a single 401 refresh+retry.
    let token = await getAccessToken(env);

    let metaRes = await fetch(metaUrl, {
      headers: { Authorization: "Bearer " + token },
    });
    if (metaRes.status === 401) {
      token = await getAccessToken(env, true);
      metaRes = await fetch(metaUrl, {
        headers: { Authorization: "Bearer " + token },
      });
    }
    if (!metaRes.ok) {
      return json(
        { success: false, error: "Metadata fetch failed (" + metaRes.status + ")" },
        502,
      );
    }
    const meta = (await metaRes.json()) as { name?: string; mimeType?: string };

    // ---- Fetch the file bytes, with a single 401 refresh+retry.
    let mediaRes = await fetch(mediaUrl, {
      headers: { Authorization: "Bearer " + token },
    });
    if (mediaRes.status === 401) {
      token = await getAccessToken(env, true);
      mediaRes = await fetch(mediaUrl, {
        headers: { Authorization: "Bearer " + token },
      });
    }
    if (!mediaRes.ok || !mediaRes.body) {
      return json(
        { success: false, error: "File download failed (" + mediaRes.status + ")" },
        502,
      );
    }

    const mimeType = meta.mimeType || "application/octet-stream";
    const name = safeFilename(meta.name || "file");

    // Stream the bytes straight through to the caller.
    return new Response(mediaRes.body, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": 'inline; filename="' + name + '"',
        "Cache-Control": "private, no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return json(
      {
        success: false,
        error: "Failed to fetch file: " + (err instanceof Error ? err.message : String(err)),
      },
      502,
    );
  }
};
