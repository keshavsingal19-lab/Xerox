/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

const MIN_TOKEN = 100;
const MAX_TOKEN = 999;
const MAX_RANDOM_TRIES = 40;

function randomToken(): number {
  return Math.floor(Math.random() * (MAX_TOKEN - MIN_TOKEN + 1)) + MIN_TOKEN;
}

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { env } = context;

  try {
    // (1) First-run cleanup: purge orders older than 2 hours (local time).
    await env.DB.prepare(
      "DELETE FROM xerox_queue WHERE created_at < STRFTIME('%Y-%m-%d %H:%M:%S','NOW','-2 hours','localtime')"
    ).run();

    // (2) Race-safely reserve a free token by attempting to INSERT a PLACEHOLDER row.
    // The PRIMARY KEY on token_id makes each INSERT atomic; a UNIQUE/constraint
    // failure means that number is taken, so we pick another and retry.
    const insert = env.DB.prepare(
      "INSERT INTO xerox_queue (token_id, student_id, drive_viewer_url, print_specifications, calculated_price) VALUES (?, '', 'PENDING', '{}', 0)"
    );

    for (let attempt = 0; attempt < MAX_RANDOM_TRIES; attempt++) {
      const candidate = randomToken();
      try {
        await insert.bind(candidate).run();
        // Reservation succeeded.
        return json({ success: true, token_id: candidate }, 201);
      } catch (_e) {
        // Most likely a UNIQUE constraint violation (token already reserved).
        // Pick another number and retry.
        continue;
      }
    }

    // Random attempts exhausted: deterministically scan the full range for any
    // free slot before giving up.
    for (let candidate = MIN_TOKEN; candidate <= MAX_TOKEN; candidate++) {
      try {
        await insert.bind(candidate).run();
        return json({ success: true, token_id: candidate }, 201);
      } catch (_e) {
        continue;
      }
    }

    // Truly exhausted: every token 100..999 is currently reserved/active.
    return json(
      {
        success: false,
        error:
          "All tokens (100-999) are currently in use. Please try again shortly.",
      },
      503
    );
  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};
