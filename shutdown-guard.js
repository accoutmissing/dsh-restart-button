import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Exit watchdog for the desktop host.
 *
 * Why this exists: the shell sends `shutdown`, the host disposes its tree, sends
 * `shutdown-complete` and disconnects. From that moment the *shell* expects the
 * process to drain and exit, and it allows ten seconds before escalating to
 * SIGTERM — at which point the update refuses to install and the user sees
 * "Host did not complete graceful task teardown". DSH's own controller clears its
 * five-second force-exit timer as soon as disposal resolves, so a single handle
 * left behind (a child process, a listening socket, a ref'd timer) holds the
 * process open with nothing left to rescue it.
 *
 * One process, one watchdog. It is armed only where the shell owns an IPC
 * channel (`process.send`), so `dsh web` and other CLI surfaces never see it.
 */

const LOG_MAX_BYTES = 200_000
const ARMED = Symbol.for('dsh.shutdown-guard.armed')

function logFile() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'shutdown-guard.log')
}

function append(line) {
  try {
    const path = logFile()
    mkdirSync(dirname(path), { recursive: true })
    try {
      if (statSync(path).size > LOG_MAX_BYTES) return
    } catch {
      /* 还没有这个文件 */
    }
    appendFileSync(path, `${line}\n`)
  } catch {
    /* 退出路径上不再制造新的失败 */
  }
}

/** Name the handle well enough that the log points at a culprit, not just a type. */
function describe(handle) {
  const parts = [handle?.constructor?.name ?? typeof handle]
  if (typeof handle?.pid === 'number') parts.push(`pid=${handle.pid}`)
  if (typeof handle?.spawnfile === 'string') parts.push(`spawn=${handle.spawnfile}`)
  if (typeof handle?.spawnargs?.[0] === 'string') parts.push(`arg=${handle.spawnargs[0]}`)
  if (typeof handle?.remoteAddress === 'string') parts.push(`${handle.remoteAddress}:${handle.remotePort ?? '?'}`)
  if (typeof handle?.localPort === 'number') parts.push(`localPort=${handle.localPort}`)
  if (typeof handle?.fd === 'number') parts.push(`fd=${handle.fd}`)
  if (typeof handle?.path === 'string') parts.push(handle.path)
  if (typeof handle?._idleTimeout === 'number') parts.push(`idleTimeout=${handle._idleTimeout}`)
  return parts.join(' ')
}

/**
 * Arm the watchdog. Safe to call repeatedly: a reload re-imports this module but
 * must not stack listeners on the same process.
 *
 * @param {{ graceMs?: number, exitCode?: number }} [options]
 * @returns {'armed' | 'already-armed' | 'not-a-desktop-host'}
 */
export function armShutdownGuard(options = {}) {
  if (globalThis[ARMED] === true) return 'already-armed'
  if (typeof process.on !== 'function' || process.send === undefined) return 'not-a-desktop-host'

  const graceMs = Number.isFinite(options.graceMs) ? Math.max(0, options.graceMs) : 1500
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 0
  globalThis[ARMED] = true

  // `disconnect` is the honest signal that the shell has finished sending us
  // work: the host calls process.disconnect() right after `shutdown-complete`.
  process.once('disconnect', () => {
    append(`[${new Date().toISOString()}] disconnect: 宿主已发出 shutdown-complete, ${graceMs}ms 后退出`)
    // Left ref'd on purpose: if some handle is holding the loop open, this timer
    // is the only thing guaranteed to still run.
    setTimeout(() => {
      let resources = []
      try {
        resources = process.getActiveResourcesInfo()
      } catch {
        /* 老版本 Node 没有这个 API */
      }
      let handles = []
      try {
        handles = process._getActiveHandles().map(describe)
      } catch {
        /* 私有 API,取不到就只报 resources */
      }
      let requests = []
      try {
        requests = (process._getActiveRequests?.() ?? []).map(describe)
      } catch {
        /* 同上 */
      }
      append(`  resources=${JSON.stringify(resources)}`)
      append(`  handles=${JSON.stringify(handles)}`)
      append(`  requests=${JSON.stringify(requests)}`)
      append(`  exit(${exitCode})`)
      process.exit(exitCode)
    }, graceMs)
  })

  return 'armed'
}

/** Exposed for tests: the same descriptor the log uses. */
export const internals = { describe, logFile }
