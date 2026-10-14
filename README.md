# CivicLens AI

CivicLens AI is a local civic issue intake and review demo. Citizens can submit a report with an optional photo, review advisory analysis, inspect possible duplicates, and follow report status and activity history. The overview and analytics are calculated from the persisted report records. This demo is not connected to a municipal authority.

## Features and implementation

- Responsive overview, community reports, operations queue, and insights: `src/App.tsx`, `src/styles.css`.
- Persistent local JSON report store and API routes: `server.js`; Vercel serverless API and Postgres persistence: `api/handler.js`, `vercel-database.js`.
- Google Gemini structured analysis with a labeled, non-vision demo fallback: `analysis-service.js`.
- Analysis and image validation, deterministic priority rules, category-to-team suggestions, geographic distance, and explainable duplicate scoring: `server-utils.js`.
- Regression tests for validation, fallback and provider errors, duplicate cases, priority scoring, teams, and image limits: `tests/server-utils.test.js`.

## Prerequisites and setup

- Node.js 20 or newer and npm.
- From this directory (`civiclens-ai`):

```sh
npm install
Copy-Item .env.example .env
```

Edit `.env` and replace `ADMIN_TOKEN` with a private local value. The example placeholder must be changed. Keep `.env` private; it is ignored by Git. Restart the server after changing environment values.

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | To change status | Shared token required by `PATCH /api/reports/:id`; configure privately and enter it on the Admin desk. Status and team updates are disabled if unset. |
| `GEMINI_API_KEY` | No | Server-side Gemini API credential. When absent, the API returns visibly labeled demo analysis and says photos were not analyzed. |
| `DATABASE_URL` | Vercel only | Postgres connection string from a Vercel Marketplace provider such as Neon. Local mode uses JSON files when this is unset. |
| `GEMINI_MODEL` | No | Model name. Defaults to `gemini-3.8-flash`. |
| `TEAM_MAPPING_JSON` | No | Optional JSON object overriding category-to-team recommendations. Defaults are defined in `server-utils.js`. |
| `PORT` | No | Preferred local API and production server port; defaults to `8790`. If occupied, the API tries the next free port. Vite normally uses `5175` in development and selects another available port when needed. |

The app uses Google's supported `@google/genai` JavaScript SDK. Gemini calls happen only in the Node server and time out after 20 seconds. Analysis output is parsed and validated before it is shown or persisted. Rate-limit, malformed-response, timeout, and provider failures return errors; failed live requests do not masquerade as demo analysis. AI recommendations remain advisory. The deterministic report priority score is a separate rule calculation.

## Data and sample records

On first local startup the API writes five illustrative, clearly labeled reports to `data/reports.json`. Citizen reports and uploaded images persist under `data/`. Do not delete these files unless you want to reset your local demo; deleting `reports.json` reseeds the sample set. The JSON store is for a single local demo process, not concurrent or production use. It is not Prisma or SQLite. Vercel uses Postgres tables for issues, activity logs, report images, and expiring analysis sessions, and seeds the same illustrative reports when the database is empty.

Priority score rules (0–100): severity adds 10 (low), 30 (moderate), 55 (high), or 75 (critical); a safety impact adds 15; recurrence adds 7; and up to three evidence items add one point each. The result is capped at 100 and mapped to Low (<35), Medium (35–69), or High (70+). For incoming reports, severity and safety terms come from the report text, recurrence comes from detected unresolved similar reports, and an attached photo counts as one evidence item. This transparent rule score is distinct from Gemini's suggested score.

Duplicate review uses category, normalized description/title similarity, and location wording. If coordinates are supplied to the API, it also uses geographic distance and excludes candidate locations more than 5 km apart. The current form collects an approximate text location and does not geocode it. Only unresolved reports are suggested. The reporter must choose to link a possible duplicate or continue separately; linking creates a new report and records a reference, without merging or deleting either report.

## Run and verify

```sh
npm run dev
```

Open the Vite URL printed by the command (normally `http://localhost:5175`). The API health endpoint normally uses `http://localhost:8790/api/health`. If either default port is occupied, the development runner and API move to the next available port; Vite proxies to the selected API port. For a production-style local run:

```sh
npm run build
npm start
```

Run regression tests and the production build:

```sh
npm test
npm run build
```

## API reference

- `GET /api/health` — server and AI/admin-configuration flags (never returns credentials).
- `GET /api/reports` — stored reports, newest first.
- `POST /api/analyze` — multipart form fields `title`, `description`, `category`, optional `image`; returns structured analysis and a short-lived server-issued analysis ID. Supported images are actual JPEG, PNG, or WebP files up to 5 MB.
- `POST /api/reports` — JSON fields `title`, `description`, `category`, `location`, optional data-URL `image`, reviewed `analysis` plus `analysisId`, optional `confirmDuplicates`, and optional `duplicateOf`. Returns possible matches before creation if duplicate confirmation is missing; otherwise creates a new record.
- `PATCH /api/reports/:id` — JSON `{ "status": "Submitted" | "Under Review" | "In Progress" | "Resolved" }` or `{ "assignedTeam": "..." }`; requires `x-admin-token` matching the configured `ADMIN_TOKEN`; every actual change appends a timestamped activity entry.

All endpoints validate inputs, cap request size, and avoid sending server secrets to the browser. The local demo has no user accounts or roles: one shared admin token gates status changes. Local API binds to loopback and uses JSON files. On Vercel, `/api/*` routes through `api/handler.js` and requires Postgres `DATABASE_URL`; set `ADMIN_TOKEN` in Vercel for status/team edits. Report photos are stored in Postgres on Vercel. The Vercel function request-size limit may be lower than the local 5 MB image limit, so use smaller uploads or move photos to object storage for larger files. Vercel's former first-party Postgres product has been replaced by Marketplace providers such as Neon.

## 90-second demo script

1. Open the overview and point out that totals, categories, status, and recent activity come from `data/reports.json`; sample items are labeled.
2. Create a report for a deep pothole near a bus stop, enter the area, and optionally add a photo. Select **Analyze report**. With `GEMINI_API_KEY`, the card says Gemini; without it, it clearly says demo and admits the photo was not inspected.
3. Review the suggested summary, category, evidence, uncertainty, priority score, team, and missing details. Adjust the report title, description, or category if needed.
4. Submit wording similar to the seeded pothole and inspect the similarity percentage, matching evidence, location, and status. Choose **Link as possible duplicate** to create a linked report; alternatively continue separately. Both records remain.
5. Open Admin desk, enter the configured `ADMIN_TOKEN`, open the new report, and change its status. Open the report again to see the timestamped activity entry and team/priority explanation.
6. Assign a responsible team from report details, change status, then return to Overview and Insights. Confirm that total/category/status counts reflect the new report and its status.

## Known limitations

- Local JSON file persistence is single-process demo storage; it is not SQLite/Prisma and does not support concurrent writes. The Vercel path uses Postgres, but production authentication, rate limiting, and object-storage uploads are not included.
- The report form accepts typed locations only; geographic duplicate-distance checks are available only for API clients that provide coordinates.
- Priority rules use explicit text clues and photo presence, not computer vision or verified safety facts. Team mapping is a suggestion, and no team or public authority receives a notification.
- AI analysis and persisted analysis IDs are held in server memory for 20 minutes. Restarting the server invalidates unfinished analyses. AI results are advisory and require human review.
- Automated tests cover core utility behavior; live Gemini credentials/provider access and a browser-driven UI session depend on local configuration and were not asserted by unit tests.
