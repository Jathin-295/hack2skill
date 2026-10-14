import { neon } from '@neondatabase/serverless'

let connection
let initialized

function sqlClient() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!url) throw Object.assign(new Error('Connect a Postgres Marketplace database and set DATABASE_URL.'), { status: 503 })
  connection ||= neon(url)
  return connection
}

function withoutHistory(report) {
  const { history, ...payload } = report
  return payload
}

async function persist(report) {
  const sql = sqlClient()
  const payload = withoutHistory(report)
  const severity = report.ai?.severity || (report.priority === 'High' ? 'High' : report.priority === 'Low' ? 'Low' : 'Moderate')
  await sql`INSERT INTO civic_issues (id, title, description, category, severity, location, area, status, priority, priority_score, priority_rationale, assigned_team, created_at, latitude, longitude, duplicate_of, image_url, ai_analysis, is_sample, payload)
    VALUES (${report.id}, ${report.title}, ${report.description}, ${report.category}, ${severity}, ${report.location}, ${report.area || ''}, ${report.status}, ${report.priority}, ${report.priorityScore || 0}, ${JSON.stringify(report.priorityRationale || {})}::jsonb, ${report.assignedTeam || ''}, ${report.createdAt}, ${report.latitude ?? null}, ${report.longitude ?? null}, ${report.duplicateOf ?? null}, ${report.imageUrl ?? null}, ${JSON.stringify(report.ai || null)}::jsonb, ${Boolean(report.isSample)}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, category=EXCLUDED.category, severity=EXCLUDED.severity, location=EXCLUDED.location, area=EXCLUDED.area, status=EXCLUDED.status, priority=EXCLUDED.priority, priority_score=EXCLUDED.priority_score, priority_rationale=EXCLUDED.priority_rationale, assigned_team=EXCLUDED.assigned_team, latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude, duplicate_of=EXCLUDED.duplicate_of, image_url=EXCLUDED.image_url, ai_analysis=EXCLUDED.ai_analysis, is_sample=EXCLUDED.is_sample, payload=EXCLUDED.payload`
}

export async function initializeDatabase(samples) {
  if (!initialized) initialized = (async () => {
    const sql = sqlClient()
    await sql`CREATE TABLE IF NOT EXISTS civic_issues (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'Moderate', location TEXT NOT NULL, area TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, priority TEXT NOT NULL,
      priority_score INTEGER NOT NULL DEFAULT 0, priority_rationale JSONB NOT NULL DEFAULT '{}'::jsonb,
      assigned_team TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL, latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION, duplicate_of TEXT REFERENCES civic_issues(id), image_url TEXT,
      ai_analysis JSONB, is_sample BOOLEAN NOT NULL DEFAULT FALSE, payload JSONB NOT NULL
    )`
    await sql`CREATE INDEX IF NOT EXISTS civic_issues_created_at_idx ON civic_issues (created_at DESC)`
    await sql`CREATE INDEX IF NOT EXISTS civic_issues_category_status_idx ON civic_issues (category, status)`
    await sql`CREATE TABLE IF NOT EXISTS civic_activity_logs (
      id BIGSERIAL PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES civic_issues(id) ON DELETE CASCADE,
      status TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, note TEXT NOT NULL
    )`
    await sql`CREATE INDEX IF NOT EXISTS civic_activity_issue_time_idx ON civic_activity_logs (issue_id, at)`
    await sql`CREATE TABLE IF NOT EXISTS civic_report_images (
      issue_id TEXT PRIMARY KEY REFERENCES civic_issues(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL, image_bytes BYTEA NOT NULL
    )`
    await sql`CREATE TABLE IF NOT EXISTS civic_analysis_sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, analysis JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL
    )`
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM civic_issues`
    if (count === 0) for (const sample of samples) {
      await persist(sample)
      for (const item of sample.history || []) await sql`INSERT INTO civic_activity_logs (issue_id, status, at, note) VALUES (${sample.id}, ${item.status}, ${item.at}, ${item.note})`
    }
  })().catch(error => { initialized = undefined; throw error })
  return initialized
}

export async function listReports() {
  const sql = sqlClient()
  const rows = await sql`SELECT payload FROM civic_issues ORDER BY created_at DESC`
  const logs = await sql`SELECT issue_id, status, at, note FROM civic_activity_logs ORDER BY at ASC, id ASC`
  const history = new Map()
  for (const item of logs) {
    const list = history.get(item.issue_id) || []
    list.push({ status: item.status, at: new Date(item.at).toISOString(), note: item.note })
    history.set(item.issue_id, list)
  }
  return rows.map(row => ({ ...row.payload, history: history.get(row.payload.id) || [] }))
}

export async function createReport(report, image) {
  const sql = sqlClient()
  await persist(report)
  for (const item of report.history || []) await sql`INSERT INTO civic_activity_logs (issue_id, status, at, note) VALUES (${report.id}, ${item.status}, ${item.at}, ${item.note})`
  if (image) await sql`INSERT INTO civic_report_images (issue_id, mime_type, image_bytes) VALUES (${report.id}, ${image.type}, decode(${image.data.toString('base64')}, 'base64'))`
}

export async function updateReport(report, activity) {
  const sql = sqlClient()
  await persist(report)
  await sql`INSERT INTO civic_activity_logs (issue_id, status, at, note) VALUES (${report.id}, ${activity.status}, ${activity.at}, ${activity.note})`
}

export async function saveAnalysisSession(id, source, analysis) {
  const sql = sqlClient()
  await sql`DELETE FROM civic_analysis_sessions WHERE expires_at < NOW()`
  await sql`INSERT INTO civic_analysis_sessions (id, source, analysis, expires_at) VALUES (${id}, ${source}, ${JSON.stringify(analysis)}::jsonb, NOW() + INTERVAL '20 minutes')`
}

export async function consumeAnalysisSession(id) {
  const sql = sqlClient()
  const [session] = await sql`DELETE FROM civic_analysis_sessions WHERE id = ${id} AND expires_at > NOW() RETURNING source, analysis`
  return session || null
}

export async function getReportImage(id) {
  const sql = sqlClient()
  const [image] = await sql`SELECT mime_type, encode(image_bytes, 'base64') AS image_base64 FROM civic_report_images WHERE issue_id = ${id}`
  return image || null
}
