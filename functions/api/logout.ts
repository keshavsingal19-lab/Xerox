/// <reference types="@cloudflare/workers-types" />

interface Env {
  SHOPKEEPER_USERNAME?: string;
  SHOPKEEPER_PASSWORD?: string;
  SESSION_SECRET?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

const COOKIE_NAME = "xshop";

// Clear the session cookie by re-issuing it with Max-Age=0.
function clearedCookie(): string {
  return (
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
  );
}

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const onRequestPost: PagesFunction<Env> = async () => {
  return json(
    { success: true },
    200,
    { "Set-Cookie": clearedCookie() }
  );
};
