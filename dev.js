import { spawn } from 'node:child_process'
import process from 'node:process'
import net from 'node:net'
import fs from 'node:fs/promises'

try {
  const envFile = await fs.readFile(new URL('.env', import.meta.url), 'utf8')
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
} catch {}

function canUse(port) {
  return new Promise(resolve => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

let apiPort = Number(process.env.PORT || 8790)
while (apiPort < 65536 && !(await canUse(apiPort))) apiPort++
if (apiPort >= 65536) throw new Error('No free local API port is available.')
if (Number(process.env.PORT || 8790) !== apiPort) console.log(`API port is busy; using ${apiPort}.`)
process.env.PORT = String(apiPort)
process.env.VITE_API_PROXY ||= `http://localhost:${apiPort}`

const api=spawn(process.execPath,['server.js'],{stdio:'inherit',env:process.env})
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','0.0.0.0','--port',process.env.VITE_PORT||'5175'],{stdio:'inherit',env:process.env})
function stop(code=0){api.kill();vite.kill();process.exit(code)}
process.on('SIGINT',()=>stop())
process.on('SIGTERM',()=>stop())
api.on('exit',code=>{if(code!==null&&code!==0)stop(code)})
vite.on('exit',code=>{if(code!==null&&code!==0)stop(code)})
