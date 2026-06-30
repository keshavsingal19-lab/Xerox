/// <reference types="@cloudflare/workers-types" />

interface Env {
  SHOPKEEPER_USERNAME?: string;
  SHOPKEEPER_PASSWORD?: string;
  SESSION_SECRET?: string;
}

const COOKIE_NAME = "xshop";

function jsonUnauthorized(): Response {
  return new Response(
    JSON.stringify({ success: false, error: "Unauthorized" }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// Resolve the HMAC secret: prefer SESSION_SECRET, else fall back to the password.
function resolveSecret(env: Env): string | null {
  const secret = env.SESSION_SECRET || env.SHOPKEEPER_PASSWORD;
  return secret || null;
}

// HMAC-SHA256(secret, "shopkeeper|"+expiryMs) -> lowercase hex.
async function sign(secret: string, expiryMs: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode("shopkeeper|" + expiryMs)
  );
  const bytes = new Uint8Array(sigBuf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// Constant-time comparison of two hex strings.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      return part.slice(idx + 1).trim();
    }
  }
  return null;
}

// Verify the xshop cookie: "<expiryMs>.<sigHex>". Returns true if signature
// matches and the token has not expired.
async function verify(request: Request, env: Env): Promise<boolean> {
  const secret = resolveSecret(env);
  if (!secret) return false;

  const raw = readCookie(request, COOKIE_NAME);
  if (!raw) return false;

  const dot = raw.indexOf(".");
  if (dot === -1) return false;

  const expiryStr = raw.slice(0, dot);
  const sigHex = raw.slice(dot + 1);
  if (!expiryStr || !sigHex) return false;

  const expiryMs = Number(expiryStr);
  if (!Number.isFinite(expiryMs)) return false;
  if (Date.now() >= expiryMs) return false;

  const expected = await sign(secret, expiryMs);
  return timingSafeEqual(expected, sigHex);
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  const authed = await verify(request, env);

  // (a) Protected pages: redirect unauthenticated users to the login screen.
  if (
    pathname === "/shopkeeper.html" ||
    pathname === "/shopkeeper" ||
    pathname === "/print.html"
  ) {
    if (!authed) {
      return Response.redirect(new URL("/?login=1", request.url).toString(), 302);
    }
    return context.next();
  }

  // (b) Shopkeeper-only order operations: mark printed / set price (PATCH) and
  // the full order list (GET ?list=1).
  if (pathname === "/api/orders") {
    const isProtected =
      method === "PATCH" ||
      (method === "GET" && url.searchParams.get("list") === "1");
    if (isProtected && !authed) {
      return jsonUnauthorized();
    }
    return context.next();
  }

  // (c) Direct-print file proxy is shopkeeper-only.
  if (pathname === "/api/file") {
    if (!authed) {
      return jsonUnauthorized();
    }
    return context.next();
  }

  // (c2) Saving the pricing model is shopkeeper-only; reading it (GET) is public.
  if (pathname === "/api/pricing") {
    if (method === "POST" && !authed) {
      return jsonUnauthorized();
    }
    return context.next();
  }

  // (d) Everything else (login/logout, tokens, upload, POST /api/orders,
  // GET /api/orders?token_id, static assets, "/") passes through untouched.
  return context.next();
};
