/// <reference types="@cloudflare/workers-types" />

// The deployed Google Apps Script Web App /exec URL.
// IMPORTANT: use the plain /macros/s/<id>/exec form — do NOT include a /u/<n>/
// account segment, or student browsers get redirected into a Google login.
const GAS_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbz0IxcKOyFLD-o-WPKbq-qvLAmgJJSB1aFgVJf159icd9-NyFPjkSDnhk2ntsPm7Zdu/exec";

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

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

// POST /api/upload : forward the JSON body to Apps Script server-to-server (no
// browser CORS), then relay Apps Script's JSON response back to the page.
export const onRequestPost: PagesFunction = async (context) => {
  try {
    const bodyText = await context.request.text();

    const upstream = await fetch(GAS_WEB_APP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: bodyText,
      redirect: "follow",
    });

    const text = await upstream.text();

    try {
      return json(JSON.parse(text), 200);
    } catch {
      return json(
        {
          success: false,
          error: "Apps Script returned a non-JSON response (check the /exec URL and deployment).",
          raw: text.slice(0, 500),
        },
        502
      );
    }
  } catch (err) {
    return json({ success: false, error: String(err) }, 502);
  }
};
