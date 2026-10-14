export const categories = ['Roads', 'Waste', 'Water', 'Drainage', 'Streetlights', 'Public infrastructure', 'Other']
export const statuses = ['Submitted', 'Under Review', 'In Progress', 'Resolved']
export const priorities = ['Low', 'Medium', 'High']

const arrays = (value, max, field) => {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 240)) {
    throw new Error(`Invalid Gemini ${field}.`)
  }
  return value.map(item => item.trim())
}

export function validateAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gemini returned an invalid analysis object.')
  const { title, summary, category, severity, priorityScore, priorityReason, team, evidence, confidence, uncertainty, nextAction, missingInformation } = value
  if (typeof title !== 'string' || title.trim().length < 3 || title.length > 90) throw new Error('Invalid Gemini title.')
  if (typeof summary !== 'string' || summary.trim().length < 5 || summary.length > 700) throw new Error('Invalid Gemini summary.')
  if (!categories.includes(category)) throw new Error('Invalid Gemini category.')
  if (!['Low', 'Moderate', 'High', 'Critical'].includes(severity)) throw new Error('Invalid Gemini severity.')
  if (!Number.isInteger(priorityScore) || priorityScore < 0 || priorityScore > 100) throw new Error('Invalid Gemini priority score.')
  if (typeof priorityReason !== 'string' || priorityReason.trim().length < 5 || priorityReason.length > 350) throw new Error('Invalid Gemini priority explanation.')
  if (typeof team !== 'string' || team.trim().length < 2 || team.length > 80) throw new Error('Invalid Gemini team.')
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('Invalid Gemini confidence.')
  if (typeof uncertainty !== 'string' || uncertainty.length > 500) throw new Error('Invalid Gemini uncertainty.')
  if (typeof nextAction !== 'string' || nextAction.trim().length < 3 || nextAction.length > 240) throw new Error('Invalid Gemini next action.')
  return { title: title.trim(), summary: summary.trim(), category, severity, priorityScore, priorityReason: priorityReason.trim(), team: team.trim(), evidence: arrays(evidence, 5, 'evidence'), confidence, uncertainty: uncertainty.trim(), nextAction: nextAction.trim(), missingInformation: arrays(missingInformation, 6, 'missing information'), source: 'gemini' }
}

export function priorityDecision({ severity = 'Moderate', safetyImpact = false, recurrence = false, evidenceCount = 0 } = {}) {
  const rules = { Low: 10, Moderate: 30, High: 55, Critical: 75 }
  const components = { severity: rules[severity] ?? rules.Moderate, safetyImpact: safetyImpact ? 15 : 0, recurrence: recurrence ? 7 : 0, evidence: Math.min(3, Math.max(0, evidenceCount)) * 1 }
  const score = Math.min(100, Object.values(components).reduce((a, b) => a + b, 0))
  return { score, priority: score >= 70 ? 'High' : score >= 35 ? 'Medium' : 'Low', components }
}

export function detectSafetyImpact(text) {
  return /injur|exposed wire|open manhole|immediate danger|hazard|risk to (?:people|pedestrians)/i.test(String(text || ''))
}

export function normalizeWords(text) {
  return String(text || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(word => word.length > 2)
}

export function textSimilarity(left, right) {
  const a = new Set(normalizeWords(left)), b = new Set(normalizeWords(right))
  if (!a.size || !b.size) return 0
  let overlap = 0
  for (const word of a) if (b.has(word)) overlap++
  return overlap / (a.size + b.size - overlap)
}

export function distanceKm(a, b) {
  if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite)) return null
  const rad = n => n * Math.PI / 180
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

export function recommendTeam(category, override = {}) {
  const defaults = { Roads: 'Roads & Highways', Waste: 'Solid Waste Management', Water: 'Water Supply', Drainage: 'Stormwater & Drainage', Streetlights: 'Electrical Maintenance', 'Public infrastructure': 'Public Works', Other: 'Civic Response' }
  return override[category] || defaults[category] || defaults.Other
}

export function findDuplicates(reports, candidate) {
  return reports.filter(report => report.status !== 'Resolved' && report.category === candidate.category).map(report => {
    const textScore = textSimilarity(`${report.title} ${report.description}`, `${candidate.title} ${candidate.description}`)
    const distance = distanceKm(report, candidate)
    const locationScore = textSimilarity(report.location, candidate.location)
    if (distance !== null && distance > 5) return null
    if (distance === null && locationScore < 0.2 && textScore < 0.24) return null
    const proximityScore = distance === null ? (locationScore >= 0.2 ? 0.15 : 0) : Math.max(0, 0.2 * (1 - distance / 5))
    const similarity = Math.min(1, textScore * 0.8 + proximityScore)
    if (similarity < 0.2) return null
    const matchingEvidence = []
    if (textScore >= 0.2) matchingEvidence.push('Similar issue description or title')
    if (distance !== null) matchingEvidence.push(`Coordinates are ${distance.toFixed(1)} km apart`)
    else if (locationScore >= 0.2) matchingEvidence.push('Similar location wording')
    return { id: report.id, title: report.title, category: report.category, location: report.location, status: report.status, similarity: Number(similarity.toFixed(2)), matchingEvidence, distanceKm: distance === null ? null : Number(distance.toFixed(1)) }
  }).filter(Boolean).sort((a, b) => b.similarity - a.similarity).slice(0, 3)
}

export function validateImage(image) {
  if (!image) return
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type)) throw Object.assign(new Error('Use JPG, PNG, or WebP.'), { status: 400 })
  if (!image.data?.length || image.data.length > 5 * 1024 * 1024) throw Object.assign(new Error('Images must be non-empty and 5 MB or smaller.'), { status: 413 })
  const b = image.data
  const matches = image.type === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : image.type === 'image/jpeg' ? b[0] === 255 && b[1] === 216 && b[b.length - 2] === 255 && b[b.length - 1] === 217 : b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
  if (!matches) throw Object.assign(new Error('The image content does not match its JPG, PNG, or WebP file type.'), { status: 400 })
}
