/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
}

interface OrderRow {
  token_id: number;
  student_id: string;
  drive_viewer_url: string;
  print_specifications: string;
  calculated_price: number;
  is_printed: number;
  created_at: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function isValidToken(value: unknown): value is number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 && n <= 999;
}

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
};

// POST /api/orders : finalize the reserved row via UPSERT.
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    let payload: any;
    try {
      payload = await context.request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const { token_id, student_id, drive_viewer_url, print_specifications, calculated_price } = payload ?? {};

    if (!isValidToken(token_id)) {
      return json({ success: false, error: "token_id must be an integer between 100 and 999" }, 400);
    }
    if (typeof student_id !== "string" || student_id.length === 0) {
      return json({ success: false, error: "student_id is required" }, 400);
    }
    if (typeof drive_viewer_url !== "string" || drive_viewer_url.length === 0) {
      return json({ success: false, error: "drive_viewer_url is required" }, 400);
    }
    if (print_specifications === undefined || print_specifications === null) {
      return json({ success: false, error: "print_specifications is required" }, 400);
    }

    const price = Number(calculated_price);
    if (!Number.isFinite(price)) {
      return json({ success: false, error: "calculated_price must be a number" }, 400);
    }

    // Always store print_specifications as a JSON STRING.
    const specsString =
      typeof print_specifications === "string"
        ? print_specifications
        : JSON.stringify(print_specifications);

    const tokenId = Number(token_id);

    await context.env.DB.prepare(
      `INSERT INTO xerox_queue (token_id, student_id, drive_viewer_url, print_specifications, calculated_price)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token_id) DO UPDATE SET
         student_id = excluded.student_id,
         drive_viewer_url = excluded.drive_viewer_url,
         print_specifications = excluded.print_specifications,
         calculated_price = excluded.calculated_price`
    )
      .bind(tokenId, student_id, drive_viewer_url, specsString, price)
      .run();

    return json({ success: true, token_id: tokenId });
  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};

function toOrder(row: OrderRow) {
  let parsedSpecs: unknown;
  try {
    parsedSpecs = JSON.parse(row.print_specifications);
  } catch {
    parsedSpecs = {};
  }
  return {
    token_id: row.token_id,
    student_id: row.student_id,
    drive_viewer_url: row.drive_viewer_url,
    calculated_price: row.calculated_price,
    is_printed: row.is_printed,
    created_at: row.created_at,
    print_specifications: parsedSpecs,
  };
}

// GET /api/orders
//   ?list=1                      -> every order, newest first (shopkeeper dashboard list).
//   ?token_id=NNN                -> single active order (404 if printed / not ready).
//   ?token_id=NNN&all=1          -> single order INCLUDING already-printed ones.
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const url = new URL(context.request.url);

    // ----- List mode -----
    if (url.searchParams.get("list") === "1") {
      const { results } = await context.env.DB.prepare(
        `SELECT token_id, student_id, drive_viewer_url, print_specifications, calculated_price, is_printed, created_at
         FROM xerox_queue ORDER BY created_at DESC`
      ).all<OrderRow>();
      const orders = (results ?? []).map(toOrder);
      return json({ success: true, count: orders.length, orders });
    }

    // ----- Single lookup -----
    const rawToken = url.searchParams.get("token_id");
    const includePrinted = url.searchParams.get("all") === "1";

    if (!isValidToken(rawToken)) {
      return json({ success: false, error: "token_id must be an integer between 100 and 999" }, 400);
    }

    const tokenId = Number(rawToken);

    const row = await context.env.DB.prepare(
      `SELECT token_id, student_id, drive_viewer_url, print_specifications, calculated_price, is_printed, created_at
       FROM xerox_queue WHERE token_id = ?`
    )
      .bind(tokenId)
      .first<OrderRow>();

    if (!row) {
      return json({ success: false, error: `No active order for token ${tokenId}` }, 404);
    }

    if (row.drive_viewer_url === "PENDING") {
      return json({ success: false, error: `Token ${tokenId} not ready yet` }, 404);
    }

    if (row.is_printed === 1 && !includePrinted) {
      return json({ success: false, error: `Token ${tokenId} was already printed / archived` }, 404);
    }

    return json({ success: true, order: toOrder(row) });
  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};

// PATCH /api/orders : update a token row.
//   { token_id }                          -> mark printed (legacy "Unlock & Print").
//   { token_id, calculated_price: N }     -> set/override the price (does NOT mark printed).
//   { token_id, mark_printed: true, ... } -> explicitly mark printed (can combine with a price).
export const onRequestPatch: PagesFunction<Env> = async (context) => {
  try {
    let payload: any;
    try {
      payload = await context.request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const tokenId = payload?.token_id;

    if (!isValidToken(tokenId)) {
      return json({ success: false, error: "token_id must be an integer between 100 and 999" }, 400);
    }

    const numericToken = Number(tokenId);

    const sets: string[] = [];
    const binds: unknown[] = [];

    const hasPrice = payload.calculated_price !== undefined && payload.calculated_price !== null;
    if (hasPrice) {
      const price = Number(payload.calculated_price);
      if (!Number.isFinite(price) || price < 0) {
        return json({ success: false, error: "calculated_price must be a non-negative number" }, 400);
      }
      sets.push("calculated_price = ?");
      binds.push(price);
    }

    // Mark printed when explicitly requested, or (legacy) when no price update was sent.
    const markPrinted = payload.mark_printed === true || payload.is_printed === 1 || !hasPrice;
    if (markPrinted) {
      sets.push("is_printed = 1");
    }

    if (sets.length === 0) {
      return json({ success: false, error: "Nothing to update" }, 400);
    }

    binds.push(numericToken);

    // Only fixed column-assignment fragments are interpolated; all values are bound.
    const result = await context.env.DB.prepare(
      `UPDATE xerox_queue SET ${sets.join(", ")} WHERE token_id = ?`
    )
      .bind(...binds)
      .run();

    const changes = result.meta?.changes ?? 0;

    if (changes === 0) {
      return json({ success: false, error: `No order found for token ${numericToken}` }, 404);
    }

    return json({
      success: true,
      token_id: numericToken,
      marked_printed: markPrinted,
      price_updated: hasPrice,
    });
  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};
