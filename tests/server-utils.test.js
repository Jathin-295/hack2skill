import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAnalysis, priorityDecision, detectSafetyImpact, textSimilarity, distanceKm, findDuplicates, recommendTeam, validateImage } from '../server-utils.js'
import { analyzeReport } from '../analysis-service.js'

const good = { title: 'Pothole blocking lane', summary: 'A pothole is described beside a lane.', category: 'Roads', severity: 'High', priorityScore: 72, priorityReason: 'High score reflects a stated road hazard.', team: 'Roads & Highways', evidence: ['Deep hole'], confidence: .8, uncertainty: 'Depth is unverified.', nextAction: 'Inspect the road.', missingInformation: ['Exact landmark'] }

test('validates complete structured Gemini responses and rejects malformed fields', () => {
  assert.equal(validateAnalysis(good).source, 'gemini')
  assert.throws(() => validateAnalysis({ ...good, priorityScore: 101 }), /priority score/)
  assert.throws(() => validateAnalysis({ ...good, evidence: 'fake' }), /evidence/)
  assert.throws(() => validateAnalysis({ ...good, category: 'Otherish' }), /category/)
})

test('uses an honest labelled demo analysis when credentials are missing', async () => {
  const result = await analyzeReport({ description: 'A broken street light', category: 'Streetlights' }, { apiKey: '' })
  assert.equal(result.source, 'demo')
  assert.match(result.uncertainty, /demo/i)
  assert.equal(result.team, 'Electrical Maintenance')
})

test('rejects malformed Gemini JSON and propagates API and timeout failures', async () => {
  await assert.rejects(analyzeReport({ description: 'A pothole', category: 'Roads' }, { apiKey: 'test', generate: async () => '{broken' }), /malformed JSON/)
  await assert.rejects(analyzeReport({ description: 'A pothole', category: 'Roads' }, { apiKey: 'test', generate: async () => JSON.stringify({ ...good, category: 'bogus' }) }), /category/)
  await assert.rejects(analyzeReport({ description: 'A pothole', category: 'Roads' }, { apiKey: 'test', generate: async () => { throw Object.assign(new Error('limit'), { status: 429 }) } }), error => error.status === 429)
  await assert.rejects(analyzeReport({ description: 'A pothole', category: 'Roads' }, { apiKey: 'test', generate: async () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }) } }), error => error.status === 504)
})

test('priority rules add transparent safety, recurrence, and evidence points', () => {
  const base = priorityDecision({ severity: 'Low' })
  const urgent = priorityDecision({ severity: 'High', safetyImpact: true, recurrence: true, evidenceCount: 2 })
  assert.equal(base.score, 10)
  assert.equal(urgent.score, 79)
  assert.equal(urgent.priority, 'High')
  assert.equal(detectSafetyImpact('a hazard for pedestrians'), true)
  assert.equal(detectSafetyImpact('routine sidewalk wear'), false)
})

test('duplicate matching excludes resolved, unrelated, and distant reports', () => {
  const candidate = { title: 'Deep pothole beside bus stop', description: 'Large pothole blocks the bus stop lane', category: 'Roads', location: 'Main Road', latitude: 17.4, longitude: 78.4 }
  const near = { id: 'near', ...candidate, title: 'Pothole at bus stop', description: 'Large hole blocks lane', latitude: 17.4001, longitude: 78.4001, status: 'Submitted' }
  const far = { ...near, id: 'far', latitude: 18.5, longitude: 79 }
  const resolved = { ...near, id: 'resolved', status: 'Resolved' }
  assert.deepEqual(findDuplicates([far, resolved, near], candidate).map(match => match.id), ['near'])
  assert.ok(findDuplicates([near], { ...candidate, title: 'A new water leak', description: 'Pipe water is leaking', category: 'Water' }).length === 0)
})

test('duplicate matching works without coordinates and reports missing-coordinate distance as unknown', () => {
  const candidate = { title: 'Pothole by central bus stop', description: 'Large deep pothole on the bus lane', category: 'Roads', location: 'Central Bus Stop' }
  const existing = { ...candidate, id: 'CL-1', title: 'Deep pothole near the bus stop', status: 'In Progress' }
  assert.equal(distanceKm(existing, candidate), null)
  const [match] = findDuplicates([existing], candidate)
  assert.equal(match.id, 'CL-1')
  assert.ok(match.similarity > 0)
  assert.ok(match.matchingEvidence.length > 0)
})

test('team mappings can override the category recommendation and images enforce type and size', () => {
  assert.equal(recommendTeam('Roads', { Roads: 'Ward 4 Roads' }), 'Ward 4 Roads')
  assert.throws(() => validateImage({ type: 'image/gif', data: Buffer.from('x') }), /JPG, PNG, or WebP/)
  assert.throws(() => validateImage({ type: 'image/png', data: Buffer.alloc(5 * 1024 * 1024 + 1) }), /5 MB/)
  assert.throws(() => validateImage({ type: 'image/png', data: Buffer.from('not a PNG') }), /does not match/)
})
