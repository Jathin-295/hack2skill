import { randomUUID, timingSafeEqual } from 'node:crypto'
import { analyzeReport } from '../analysis-service.js'
import { samples } from '../server.js'
import { categories, statuses, validateAnalysis, validateImage, findDuplicates, priorityDecision, recommendTeam, detectSafetyImpact } from '../server-utils.js'
import { initializeDatabase, listReports, createReport, updateReport, saveAnalysisSession, consumeAnalysisSession, getReportImage } from '../vercel-database.js'

function send(res, status, body, headers = {}) {
  res.statusCode = status
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body
    if (typeof req.body === 'string') return Buffer.from(req.body)
    return Buffer.from(JSON.stringify(req.body))
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 5 * 1024 * 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function input(req) {
  const body = await readBody(req)
  const type = req.headers['content-type'] || ''
  if (type.includes('application/json')) {
    try { return JSON.parse(body.toString('utf8')) } catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }) }
  }
  if (!type.includes('multipart/form-data')) throw Object.assign(new Error('Unsupported request content type.'), { status: 415 })
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean)
  if (!boundary) throw Object.assign(new Error('Missing multipart boundary.'), { status: 400 })
  const out = {}
  for (const part of body.toString('latin1').split(`--${boundary}`).slice(1, -1)) {
    const split = part.indexOf('\r\n\r\n')
    if (split < 0) continue
    const head = part.slice(0, split), name = head.match(/name="([^"]+)"/)?.[1], filename = head.match(/filename="([^"]*)"/)?.[1]
    if (!name) continue
    const value = part.slice(split + 4).replace(/\r\n$/, '')
    out[name] = filename ? { data: Buffer.from(value, 'latin1'), type: head.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || '', name: filename } : Buffer.from(value, 'latin1').toString()
  }
  return out
}

function coerceImage(image) {
  if (!image) return undefined
  if (typeof image === 'string') {
    const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/)
    if (!match) throw Object.assign(new Error('Choose a JPG, PNG, or WebP image.'), { status: 400 })
    return { type: match[1], data: Buffer.from(match[2], 'base64') }
  }
  return image
}

function isAdmin(req) {
  const configured = process.env.ADMIN_TOKEN, provided = req.headers['x-admin-token']
  return Boolean(configured && typeof provided === 'string' && provided.length === configured.length && timingSafeEqual(Buffer.from(provided), Buffer.from(configured)))
}

async function route(req, res) {
  const path = `/api/${(req.query?.path || '').toString().replace(/^\/+|\/+$/g, '')}`
  if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, aiConfigured: Boolean(process.env.GEMINI_API_KEY), adminAuthConfigured: Boolean(process.env.ADMIN_TOKEN), persistentStore: 'postgres' })
  if (req.method === 'GET' && path === '/api/reports') return send(res, 200, { reports: await listReports() })
  if (req.method === 'POST' && path === '/api/analyze') {
    const value = await input(req)
    value.image = coerceImage(value.image)
    if (!String(value.description || '').trim() && !value.image) return send(res, 400, { error: 'Add a description or photo before analysis.' })
    if (String(value.description || '').length > 1200 || String(value.title || '').length > 90 || !categories.includes(value.category)) return send(res, 400, { error: 'Check the report details and category.' })
    validateImage(value.image)
    const analysis = await analyzeReport(value)
    const analysisId = randomUUID()
    await saveAnalysisSession(analysisId, analysis.source, analysis)
    return send(res, 200, { analysis, analysisId })
  }
  if (req.method === 'POST' && path === '/api/reports') {
    const value = await input(req), title = String(value.title || '').trim(), description = String(value.description || '').trim(), location = String(value.location || '').trim(), category = String(value.category || '')
    value.image = coerceImage(value.image)
    if (title.length < 4 || title.length > 90 || description.length < 12 || description.length > 1200 || location.length < 3 || location.length > 120 || !categories.includes(category)) return send(res, 400, { error: 'Check title, description, category, and approximate location.' })
    if (value.latitude !== undefined && (!Number.isFinite(Number(value.latitude)) || Math.abs(Number(value.latitude)) > 90) || value.longitude !== undefined && (!Number.isFinite(Number(value.longitude)) || Math.abs(Number(value.longitude)) > 180)) return send(res, 400, { error: 'Coordinates are invalid.' })
    validateImage(value.image)
    const all = await listReports(), candidate = { title, description, location, category, latitude: value.latitude === undefined ? undefined : Number(value.latitude), longitude: value.longitude === undefined ? undefined : Number(value.longitude) }
    const matches = findDuplicates(all, candidate)
    if (matches.length && !value.confirmDuplicates) return send(res, 200, { duplicates: matches })
    if (value.duplicateOf && !matches.some(report => report.id === value.duplicateOf)) return send(res, 400, { error: 'Link only to an unresolved report shown as a possible match.' })
    const now = new Date().toISOString(), id = `CL-${randomUUID().slice(0, 6).toUpperCase()}`, session = value.analysisId ? await consumeAnalysisSession(value.analysisId) : null
    let ai = null
    if (session && value.analysis && typeof value.analysis === 'object') {
      try { ai = validateAnalysis({ ...session.analysis, source: session.source }) } catch { throw Object.assign(new Error('The reviewed AI suggestion is invalid. Run the analysis again.'), { status: 400 }) }
    }
    const text = `${title} ${description}`.toLowerCase(), severity = /exposed wire|open manhole|injur|immediate danger|deep pothole/i.test(text) ? 'High' : /overflow|leak|broken|not working|blocked|pothole/i.test(text) ? 'Moderate' : 'Low'
    const decision = priorityDecision({ severity, safetyImpact: detectSafetyImpact(text), recurrence: matches.length > 0, evidenceCount: value.image ? 1 : 0 })
    let mapping = {}
    try { mapping = JSON.parse(process.env.TEAM_MAPPING_JSON || '{}') } catch { throw Object.assign(new Error('TEAM_MAPPING_JSON must be valid JSON.'), { status: 500 }) }
    const assignedTeam = mapping[category] || recommendTeam(category)
    const report = { id, title, description, category, location, area: location.split(',').at(-1).trim() || location, status: 'Submitted', priority: decision.priority, priorityScore: decision.score, priorityRationale: decision.components, assignedTeam, createdAt: now, isSample: false,
      ...(candidate.latitude !== undefined ? { latitude: candidate.latitude } : {}), ...(candidate.longitude !== undefined ? { longitude: candidate.longitude } : {}), ...(value.image ? { imageUrl: `/api/images/${id}` } : {}), ...(ai ? { ai: { ...ai, source: session.source } } : {}), ...(value.duplicateOf ? { duplicateOf: value.duplicateOf } : {}), history: [{ status: 'Submitted', at: now, note: value.duplicateOf ? `Submitted by community member and linked as a possible duplicate of ${value.duplicateOf}` : 'Submitted by a community member' }] }
    await createReport(report, value.image)
    return send(res, 201, { report })
  }
  const imageMatch = path.match(/^\/api\/images\/([^/]+)$/)
  if (req.method === 'GET' && imageMatch) {
    const image = await getReportImage(decodeURIComponent(imageMatch[1]))
    if (!image) return send(res, 404, { error: 'Image not found.' })
    res.statusCode = 200; res.setHeader('Content-Type', image.mime_type); res.setHeader('Cache-Control', 'private, max-age=3600'); return res.end(Buffer.from(image.image_base64, 'base64'))
  }
  const match = path.match(/^\/api\/reports\/([^/]+)$/)
  if (req.method === 'PATCH' && match) {
    if (!process.env.ADMIN_TOKEN) return send(res, 503, { error: 'Status and team updates are disabled until the server ADMIN_TOKEN is configured.' })
    if (!isAdmin(req)) return send(res, 401, { error: 'Admin authorization required.' })
    const value = await input(req)
    if (value.status !== undefined && !statuses.includes(value.status) || value.assignedTeam !== undefined && (typeof value.assignedTeam !== 'string' || value.assignedTeam.trim().length < 2 || value.assignedTeam.trim().length > 80) || value.status === undefined && value.assignedTeam === undefined) return send(res, 400, { error: 'Provide a valid status or assigned team.' })
    const report = (await listReports()).find(item => item.id === decodeURIComponent(match[1]))
    if (!report) return send(res, 404, { error: 'Report not found.' })
    const now = new Date().toISOString(), activities = []
    if (value.status !== undefined && value.status !== report.status) { report.status = value.status; activities.push({ status: report.status, at: now, note: 'Status updated in the CivicLens admin workspace' }) }
    if (value.assignedTeam !== undefined && value.assignedTeam.trim() !== report.assignedTeam) { report.assignedTeam = value.assignedTeam.trim(); activities.push({ status: report.status, at: now, note: `Assigned to suggested team: ${report.assignedTeam}` }) }
    for (const activity of activities) { report.history.push(activity); await updateReport(report, activity) }
    return send(res, 200, { report })
  }
  return send(res, 404, { error: 'Not found.' })
}

export default async function handler(req, res) {
  try {
    await initializeDatabase(samples)
    await route(req, res)
  } catch (error) {
    console.error('[api]', error)
    send(res, error.status || 500, { error: error.message || 'Unexpected server error.' })
  }
}
