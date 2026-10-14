import apiHandler from '../../api/handler.js'

// Adapt the existing request/response API to Netlify's Lambda function runtime.
export async function handler(event) {
  const requestPath = event.rawUrl ? new URL(event.rawUrl).pathname : event.path || ''
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
  const body = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
    : Buffer.alloc(0)
  const req = {
    method: event.httpMethod || 'GET',
    headers,
    body,
    query: { path: requestPath.replace(/^\/api\/?/, '') },
  }

  let statusCode = 200
  const responseHeaders = {}
  let responseBody = Buffer.alloc(0)
  const res = {
    get statusCode() { return statusCode },
    set statusCode(value) { statusCode = value },
    setHeader(name, value) { responseHeaders[name] = value },
    hasHeader(name) { return Object.keys(responseHeaders).some(key => key.toLowerCase() === name.toLowerCase()) },
    end(value) { responseBody = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(String(value)) },
  }

  await apiHandler(req, res)
  const contentType = Object.entries(responseHeaders).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || ''
  const binary = contentType.startsWith('image/')
  return {
    statusCode,
    headers: responseHeaders,
    body: binary ? responseBody.toString('base64') : responseBody.toString('utf8'),
    ...(binary ? { isBase64Encoded: true } : {}),
  }
}
