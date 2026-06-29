/// <reference types="@cloudflare/workers-types" />

interface Env {
  SHOPKEEPER_USERNAME?: string;
  SHOPKEEPER_PASSWORD?: string;
  SESSION_SECRET?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

// Session lifetime: 12 hours.
const COOKIE_NAME = "xshop";
const MAX_AGE_SECONDS = 43200;
const MAX_AGE_MS = MAX_AGE_SECONDS * 1000;

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

function buildSessionCookie(value: string): string {
  return (
    `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; ` +
    `Max-Age=${MAX_AGE_SECONDS}`
  );
}

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const authed = await verify(request, env);
  return json({ authed });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const username = env.SHOPKEEPER_USERNAME;
  const password = env.SHOPKEEPER_PASSWORD;

  // Login is only available if the operator configured both credentials.
  if (!username || !password) {
    return json(
      { success: false, error: "Login is not configured" },
      503
    );
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { username?: unknown; password?: unknown };
  } catch (_e) {
    return json({ success: false, error: "Invalid credentials" }, 401);
  }

  const inUser = typeof body.username === "string" ? body.username : "";
  const inPass = typeof body.password === "string" ? body.password : "";

  if (inUser !== username || inPass !== password) {
    return json({ success: false, error: "Invalid credentials" }, 401);
  }

  const secret = resolveSecret(env);
  if (!secret) {
    return json(
      { success: false, error: "Login is not configured" },
      503
    );
  }

  const expiryMs = Date.now() + MAX_AGE_MS;
  const sigHex = await sign(secret, expiryMs);
  const cookieValue = `${expiryMs}.${sigHex}`;

  return json(
    { success: true },
    200,
    { "Set-Cookie": buildSessionCookie(cookieValue) }
  );
};
