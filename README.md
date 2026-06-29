# Campus Xerox — Token & Print System

A 100% free, cardless, zero-maintenance campus photocopy/print queue.

A student uploads their file(s), picks print options, and gets a **3-digit
token number**. The file is parked in a Google Drive folder; the order metadata
lives in a Cloudflare D1 database. The shopkeeper types the token into a simple
switchboard, opens the file, prints it, and marks it done. Files self-destruct
nightly and order rows auto-expire after 2 hours, so the whole thing runs
forever inside free tiers with no cards, no payments, and no manual cleanup.

---

## Architecture

```
Student browser ──upload base64──▶ Google Apps Script Web App ──▶ Google Drive
       │                                  (returns webViewLink)        (file warehouse)
       │
       ├──POST /api/tokens──▶ Cloudflare Pages Function ──▶ D1 (reserve token)
       └──POST /api/orders──▶ Cloudflare Pages Function ──▶ D1 (finalize order)

Shopkeeper browser ──GET /api/orders?token_id──▶ Pages Function ──▶ D1 (read order)
                   ──PATCH /api/orders──────────▶ Pages Function ──▶ D1 (mark printed)
```

- **Cloudflare Pages (static)** — serves `index.html` (student) and `shopkeeper.html`.
- **Cloudflare Pages Functions** — the `/api/*` JSON endpoints (same origin as the HTML).
- **Cloudflare D1 (SQLite)** — the `xerox_queue` order table.
- **Google Apps Script Web App** — receives file uploads, stores them in Drive,
  shares them, and runs the nightly storage cleanup.

---

## Project file tree

```
xerox/
├── index.html              # Student view (upload + options + token)
├── shopkeeper.html         # Shopkeeper switchboard (lookup / view / mark printed)
├── schema.sql              # D1 table DDL (run via npm run db:init)
├── wrangler.toml           # Cloudflare Pages + D1 binding config
├── package.json            # dev / deploy / db:init scripts
├── tsconfig.json           # TypeScript config for the Functions
├── .gitignore
├── README.md               # this file
├── apps-script/
│   └── Code.gs             # Google Apps Script Web App (paste into Apps Script)
└── functions/
    └── api/
        ├── tokens.ts       # POST /api/tokens   (reserve a free token)
        └── orders.ts       # POST/GET/PATCH /api/orders
```

---

## One-time deploy guide

### Prerequisites

- A free [Cloudflare](https://dash.cloudflare.com) account.
- A Google account (for Drive + Apps Script).
- [Node.js](https://nodejs.org) installed locally.

Install the tooling once:

```sh
npm install
```

This installs `wrangler` and `@cloudflare/workers-types` locally (see
`package.json`). All `npm run …` commands below use this local wrangler.

---

### Step 1 — Create the D1 database

```sh
npx wrangler login          # opens a browser to authorize wrangler
npx wrangler d1 create xerox_db
```

The output prints a `database_id`. Copy it.

### Step 2 — Paste the database_id into wrangler.toml

Open `wrangler.toml` and replace `PASTE_D1_DATABASE_ID`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "xerox_db"
database_id = "the-uuid-you-just-copied"
```

The binding name **must stay `DB`** — the Functions read `context.env.DB`.

### Step 3 — Create the table

```sh
npm run db:init
```

This runs `schema.sql` against `xerox_db` (drops and recreates `xerox_queue`
with the CHECK constraints, the `localtime` default on `created_at`, and the
`idx_created_at` index). To run it against your **remote** D1 instead of the
local dev copy, add `--remote`:

```sh
npx wrangler d1 execute xerox_db --remote --file=./schema.sql
```

---

### Step 4 — Set up the Google Apps Script Web App

The Apps Script is the file warehouse. It needs two Drive folders and one
advanced service.

1. **Create two Google Drive folders:**
   - **Daily Pending** — where freshly uploaded student files land
     (auto-trashed nightly).
   - **Master Catalog** — pre-loaded common documents (lab manuals, forms, etc.)
     that students can request by name without re-uploading.

   Open each folder in Drive; the long string in the URL after `/folders/` is
   its **folder ID**. Copy both.

2. **Create the Apps Script project:** go to <https://script.google.com>,
   **New project**, and paste the entire contents of `apps-script/Code.gs` into
   the editor (replace the default `myFunction`).

3. **Paste the two folder IDs** into the CONFIG block at the top of `Code.gs`:

   ```js
   var DAILY_PENDING_FOLDER_ID  = "your-daily-pending-folder-id";
   var MASTER_CATALOG_FOLDER_ID = "your-master-catalog-folder-id";
   ```

4. **Enable the ADVANCED Drive Service** (required by `nightlyStorageCleanup` —
   it calls `Drive.Files.emptyTrash()` to force-reset the Drive storage
   allocation). In the Apps Script editor: **Services** (the `+` icon in the
   left sidebar) → find **Drive API** → **Add**. Leave the identifier as `Drive`.
   Without this, the nightly cleanup will throw on `emptyTrash`.

5. **Deploy as a Web App:**
   - Click **Deploy → New deployment**.
   - Select type **Web app**.
   - **Execute as:** **Me** (so it can write to your Drive).
   - **Who has access:** **Anyone** (so any student browser can POST to it —
     no login wall).
   - Click **Deploy**, authorize the scopes when prompted, and copy the
     **Web app URL** (it ends in `/exec`).

   > Test it: open the `/exec` URL in a browser. `doGet` returns a small JSON
   > health ping, confirming the deployment is live.

6. **Install the nightly cleanup trigger (run ONCE):** in the Apps Script
   editor, pick the function **`createNightlyTrigger`** from the function
   dropdown and click **Run**. This installs a time-based trigger that fires
   `nightlyStorageCleanup` every night at 23:59 (it first deletes any duplicate
   trigger for the same handler, so it is safe to re-run). Authorize if prompted.

---

### Step 5 — Wire the GAS URL into the student page

Open `index.html`, find the CONFIG block near the top of the inline `<script>`,
and paste your `/exec` URL:

```js
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfy.../exec";
```

This is the only frontend value you must edit. The `/api/*` calls are
same-origin, so no API base URL is needed.

---

### Step 6 — Deploy to Cloudflare Pages

```sh
npm run deploy
```

(`wrangler pages deploy .` — `pages_build_output_dir = "."` means the project
root is published as-is; `functions/` is auto-detected as the Functions
directory.) The first deploy will ask you to create/select a Pages project.
Wrangler prints the live URL when it finishes.

To run everything locally first:

```sh
npm run dev          # wrangler pages dev .  (serves HTML + Functions + local D1)
```

Then visit the printed `http://localhost:8788` URL.

---

## How a print job flows

1. Student opens `index.html`, selects file(s), chooses **copies**, **color**
   (B&W / Color), and **layout** (Single / Double Sided). Price is computed live.
2. The page reserves a token (`POST /api/tokens`), uploads each file to the GAS
   Web App (which stores it in the Daily Pending folder and shares it), then
   finalizes the order (`POST /api/orders`) with the Drive links and specs.
3. The student is shown their **3-digit token**.
4. The shopkeeper opens `shopkeeper.html`, types the token, and the order
   (files, specs, price) appears. They click **Unlock & Print**
   (`PATCH /api/orders`), which marks the order done and opens each file in a new
   tab for immediate Ctrl+P.
5. Order rows older than 2 hours are deleted on the next `/api/tokens` call;
   Drive files older than 12 hours are trashed by the nightly Apps Script job.

---

## Pricing

The **frontend** computes the price; the backend only stores the number.

```js
let ratePerPage = (color === "Color") ? 5 : 2;
if (layout === "Double Sided") ratePerPage += 1;
const total = ratePerPage * pages * copies;
```

| Color | Layout        | Rate per page |
| ----- | ------------- | ------------- |
| B&W   | Single Sided  | ₹2            |
| B&W   | Double Sided  | ₹3            |
| Color | Single Sided  | ₹5            |
| Color | Double Sided  | ₹6            |

`total = ratePerPage × pages × copies`. Currency is the Indian rupee (₹).

---

## API contract summary

All endpoints are Cloudflare Pages Functions, served **same-origin** as the HTML,
and always return a JSON body with the correct HTTP status.

### `POST /api/tokens`
No body. Cleans up rows older than 2 hours, then race-safely reserves a free
token (100–999) by inserting a placeholder row; the `INTEGER PRIMARY KEY` makes
the insert atomic, so a collision just retries with another random number.
- **201** `{ success: true, token_id: NNN }`
- **503** `{ success: false, error }` if no token is free.

### `POST /api/orders`
Body: `{ token_id, student_id, drive_viewer_url, print_specifications, calculated_price }`.
`print_specifications` may be an object or a JSON string; it is always stored as
a JSON string. Finalizes the reserved row (UPSERT on `token_id`).
- **200** `{ success: true, token_id }`

### `GET /api/orders?token_id=NNN`
Validates `token_id` is 100–999 and reads the row.
- **200** `{ success: true, order: { token_id, student_id, drive_viewer_url, calculated_price, is_printed, created_at, print_specifications: <parsed object> } }`
- **404** `{ success: false, error: "No active order for token NNN" }` — not found.
- **404** `{ success: false, error: "Token NNN was already printed / archived" }` — `is_printed === 1`.
- **404** `{ success: false, error: "Token NNN not ready yet" }` — reserved but not finalized (`drive_viewer_url === "PENDING"`).

### `PATCH /api/orders`
Body: `{ token_id }`. Marks the order printed
(`UPDATE … SET is_printed = 1 WHERE token_id = ? AND is_printed = 0`).
- **200** `{ success: true, token_id, updated: <changes> }`
- **404** `{ success: false, error }` if no row was updated.

### `print_specifications` JSON shape

```json
{
  "fileName": "string (primary display name; first file or \"N files\")",
  "fileCount": 0,
  "totalSizeBytes": 0,
  "pages": 0,
  "copies": 0,
  "color": "B&W | Color",
  "layout": "Single Sided | Double Sided",
  "files": [{ "name": "string", "sizeBytes": 0, "url": "Drive webViewLink" }]
}
```

---

## Database

`xerox_queue` (see `schema.sql`) — do **not** add columns. Because there are no
`file_name` / `file_size` columns, those values live inside the
`print_specifications` JSON string.

| Column                 | Type    | Notes                                                        |
| ---------------------- | ------- | ------------------------------------------------------------ |
| `token_id`             | INTEGER | PRIMARY KEY, `CHECK (token_id BETWEEN 100 AND 999)`          |
| `student_id`           | TEXT    | NOT NULL                                                     |
| `drive_viewer_url`     | TEXT    | NOT NULL (`"PENDING"` while reserved, real link once finalized) |
| `print_specifications` | TEXT    | NOT NULL — JSON string (shape above)                         |
| `calculated_price`     | REAL    | NOT NULL                                                     |
| `is_printed`           | INTEGER | DEFAULT 0, `CHECK (is_printed IN (0, 1))`                    |
| `created_at`           | TEXT    | DEFAULT local datetime (`STRFTIME('%Y-%m-%d %H:%M:%S','NOW','localtime')`) |

Index: `idx_created_at` on `created_at` (used by the 2-hour cleanup).

---

## Cost & maintenance

- **Cloudflare Pages + Functions + D1** — generous free tier, no card required.
- **Google Drive + Apps Script** — free; the nightly job trashes files older
  than 12 hours and empties the trash to reset the storage allocation.
- **No cards, no payments, no manual cleanup.** Set it up once and forget it.
