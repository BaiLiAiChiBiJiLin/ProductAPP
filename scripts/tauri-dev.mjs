import net from 'node:net'
import { spawn } from 'node:child_process'

const host = '127.0.0.1'
const port = 5173

function portIsOpen() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

if (await portIsOpen()) {
  console.log(`Vite 已在 http://${host}:${port} 运行，复用现有服务`)
  process.exit(0)
}

const vite = process.platform === 'win32'
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd run dev -- --host 127.0.0.1'], { stdio: 'inherit' })
  : spawn('npm', ['run', 'dev', '--', '--host', host], { stdio: 'inherit' })
vite.on('exit', code => process.exit(code ?? 1))
process.on('SIGINT', () => vite.kill('SIGINT'))
process.on('SIGTERM', () => vite.kill('SIGTERM'))
