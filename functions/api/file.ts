/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
}

// The deployed Google Apps Script Web App /exec URL.
// IMPORTANT: use the plain /macros/s/<id>/exec form — do NOT include a /u/<n>/
// account segment, or student browsers get redirected into a Google login.
const GAS_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbz0IxcKOyFLD-o-WPKbq-qvLAmgJJSB1aFgVJf159icd9-NyFPjkSDnhk2ntsPm7Zdu/exec";

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

// Decode a standard base64 string into raw bytes.
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Sanitize a filename for safe use inside a quoted Content-Disposition header.
function safeFilename(name: string): string {
  return (name || "file").replace(/[\r\n"\\]/g, "_");
}

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return json({ success: false, error: "Missing file id" }, 400);
  }

  let gas: { base64?: string; mimeType?: string; name?: string; success?: boolean; error?: string };
  try {
    const gasUrl =
      GAS_WEB_APP_URL + "?action=download&id=" + encodeURIComponent(id);
    const res = await fetch(gasUrl, { redirect: "follow" });
    if (!res.ok) {
      return json({ success: false, error: "Upstream fetch failed (" + res.status + ")" }, 502);
    }
    gas = await res.json();
  } catch (err) {
    return json(
      { success: false, error: "Failed to reach file source: " + (err instanceof Error ? err.message : String(err)) },
      502,
    );
  }

  if (!gas || gas.success === false || typeof gas.base64 !== "string") {
    return json({ success: false, error: gas?.error || "File not available" }, 502);
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(gas.base64);
  } catch {
    return json({ success: false, error: "Corrupt file data" }, 502);
  }

  const mimeType = gas.mimeType || "application/octet-stream";
  const name = safeFilename(gas.name || "file");

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": 'inline; filename="' + name + '"',
      "Cache-Control": "private, no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
