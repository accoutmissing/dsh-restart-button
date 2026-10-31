import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE = '/plugins/dsh-restart-button/__restart'
const SOFT_ROUTE = '/plugins/dsh-restart-button/__reload'
const STATE_ROUTE = '/plugins/dsh-restart-button/__state'

const SHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const EXPLORER = join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')
const WSCRIPT = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')

/**
 * A write route the page can post must prove it is our page.
 *
 * Loopback alone is not enough: every local process shares that peer address,
 * and a cross-site form post from another document would too. A custom header
 * cannot be attached cross-site without a preflight the host refuses, so
 * requiring it narrows "anything on this machine" down to "our own document".
 */
const BUTTON_HEADER = 'x-dsh-restart-button'

/** A press is a one-shot promise: honour it, expire it, never wedge the route forever. */
const PRESS_LOCK_MS = 30_000
/** How long a hot reload may hold the request before the caller gets an honest answer. */
const RELOAD_TIMEOUT_MS = 20_000
/** Nested-transaction races resolve by themselves; a few retries beat a failure. */
const RELOAD_RETRIES = 3
const RELOAD_RETRY_MS = 400
/** Keep the temp crawl in hand: one run directory per press would grow without bound. */
const KEEP_RUNS = 20

const LOG_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'restart-button.log')
const LOG_MAX_BYTES = 1_000_000

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The loaded generation of this module.
 *
 * `hmr.reconcileProfile()` evicts the changed module and re-imports it, so a
 * value read at module scope is the only honest proof that new code is running:
 * a version string in package.json would be re-read from disk and say nothing
 * about what the process actually imported. `__state` reports this, which is
 * what makes "did the reload really take" a question with an answer.
 */
const BUILD = 'gen-3'

/** @type {{ at: number }} */
const press = { at: 0 }

function pressActive() {
  return press.at !== 0 && Date.now() - press.at < PRESS_LOCK_MS
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function json(res, status, body) {
  // An answer that already went out cannot be replaced; end it cleanly instead
  // of throwing a headers-already-sent error out of the route.
  if (res.headersSent === true) {
    if (res.writableEnded !== true && res.destroyed !== true) res.end()
    return
  }
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Keep one log line one log line: control bytes would let a value forge its own entry. */
function oneLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
}

function messageOf(error) {
  return oneLine(error instanceof Error ? error.message : error) || 'unknown error'
}

/**
 * Logging is best effort and must never take a route down with it: a desktop
 * shell treats a failing entry as fatal, and an unwritable log is not a reason
 * to lose a restart.
 */
function log(text) {
  try {
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {
      /* the rotation probe is the only reader; a missing file is the normal case */
    }
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${oneLine(text)}\n`, 'utf8')
  } catch {
    /* the answer to the caller is what matters */
  }
}

/**
 * The floor under every route body.
 *
 * A handler that throws after its headers went out can leave the response
 * hanging, which the page reads as "still working" forever. Answer from here
 * instead of letting the request die.
 */
function guard(path, handler) {
  return (req, res) => {
    const fail = (error) => {
      log(`cannot answer ${path}: ${messageOf(error)}`)
      try {
        json(res, 503, { ok: false, error: 'internal error' })
      } catch {
        /* the response is already gone; the log line is what is left to say */
      }
    }
    try {
      const answer = handler(req, res)
      if (answer !== null && typeof answer === 'object' && typeof answer.then === 'function') {
        answer.then(undefined, fail)
      }
    } catch (error) {
      fail(error)
    }
  }
}

/** The desktop shell forwards its own requests: the peer stays loopback while origin/host are stripped. */
function fromLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** A same-origin page sets this header itself; a cross-site form post cannot. */
function fromOwnPage(req) {
  return oneLine(req.headers?.[BUTTON_HEADER]) !== ''
}

/** PowerShell single-quoted literal: only ' needs doubling. */
function psLiteral(value) {
  return `'${String(value).split("'").join("''")}'`
}

/** VBScript string literal: " needs doubling, and a backslash is not an escape there. */
function vbsLiteral(value) {
  return `"${String(value).split('"').join('""')}"`
}

function stamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    '-',
    String(now.getMilliseconds()).padStart(3, '0')
  ].join('')
}

/**
 * Resolve the desktop relaunch target.
 *
 * The Harness host runs as an Electron child process started with
 * ELECTRON_RUN_AS_NODE=1, so process.execPath is the desktop executable and
 * process.ppid is the Electron main process that owns the window.
 */
function desktopTarget() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') return undefined
  // DSH_DESKTOP_NODE_EXECUTABLE is the shell's own hint; process.execPath points
  // at the same executable because the host runs in Electron's Node mode.
  const hinted = process.env.DSH_DESKTOP_NODE_EXECUTABLE
  const exe = typeof hinted === 'string' && hinted !== '' ? hinted : process.execPath
  const mainPid = process.ppid
  if (typeof exe !== 'string' || exe === '' || !existsSync(exe)) return undefined
  if (!Number.isInteger(mainPid) || mainPid <= 0) return undefined
  return { exe, mainPid }
}

/**
 * @param {{ exe: string, mainPid: number, args?: string[] }} target
 */
function helperSource(target, port, logPath) {
  const name = basename(target.exe).replace(/\.exe$/i, '')
  const args = Array.isArray(target.args) && target.args.length > 0 ? target.args.map(psLiteral).join(', ') : undefined

  return [
    '$ErrorActionPreference = "Continue"',
    `$mainPid = ${target.mainPid}`,
    `$exePath = ${psLiteral(target.exe)}`,
    `$appName = ${psLiteral(name)}`,
    `$port = ${port}`,
    `$log = ${psLiteral(logPath)}`,
    args === undefined ? undefined : `$relaunchArgs = @(${args})`,
    '',
    'function Write-Log([string]$message) {',
    '  try {',
    '    Add-Content -LiteralPath $log -Value ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff") + "] " + $message)',
    '  } catch { }',
    '}',
    '',
    'function Get-AppProcesses() {',
    '  try { return @(Get-Process -Name $appName -ErrorAction SilentlyContinue) } catch { return @() }',
    '}',
    '',
    'function Wait-NoAppProcess([int]$seconds) {',
    '  $deadline = (Get-Date).AddSeconds($seconds)',
    '  while ((Get-Date) -lt $deadline) {',
    '    if ((Get-AppProcesses).Count -eq 0) { return $true }',
    '    Start-Sleep -Milliseconds 250',
    '  }',
    '  return ((Get-AppProcesses).Count -eq 0)',
    '}',
    '',
    'Write-Log ("helper start; self=" + $PID + " main=" + $mainPid + " exe=" + $exePath)',
    'Start-Sleep -Milliseconds 1000',
    '',
    '$current = Get-Process -Id $mainPid -ErrorAction SilentlyContinue',
    'if ($null -eq $current) {',
    '  Write-Log "electron main process already gone"',
    '} else {',
    '  $path = ""',
    '  try { $path = $current.Path } catch { }',
    '  if ($path -ne "" -and $path -ne $exePath) {',
    '    Write-Log ("ABORT: parent process is not the desktop app: " + $path)',
    '    exit 1',
    '  }',
    '  Write-Log ("terminating " + $current.ProcessName + " (" + $mainPid + ")")',
    '  try { Stop-Process -Id $mainPid -Force -ErrorAction Stop } catch { Write-Log ("terminate failed: " + $_.Exception.Message) }',
    '}',
    '',
    '# Chromium children do not die with their parent on Windows; clear any orphan',
    '# so the relaunched instance can bind its port and claim the single-instance lock.',
    'if (-not (Wait-NoAppProcess 15)) {',
    '  $left = Get-AppProcesses',
    '  Write-Log ("orphans remaining: " + $left.Count + "; force stopping")',
    '  foreach ($item in $left) {',
    '    try { Stop-Process -Id $item.Id -Force -ErrorAction Stop } catch { Write-Log ("orphan stop failed: " + $item.Id) }',
    '  }',
    '  [void](Wait-NoAppProcess 10)',
    '}',
    'Write-Log ("app processes remaining: " + (Get-AppProcesses).Count)',
    '',
    'if ($port -gt 0) {',
    '  $deadline = (Get-Date).AddSeconds(20)',
    '  while ((Get-Date) -lt $deadline) {',
    '    $busy = $false',
    '    try {',
    '      $client = New-Object System.Net.Sockets.TcpClient',
    '      $pending = $client.BeginConnect("127.0.0.1", $port, $null, $null)',
    '      if ($pending.AsyncWaitHandle.WaitOne(300) -and $client.Connected) { $busy = $true }',
    '      $client.Close()',
    '    } catch { $busy = $false }',
    '    if (-not $busy) { break }',
    '    Start-Sleep -Milliseconds 250',
    '  }',
    '  Write-Log ("port " + $port + " released")',
    '}',
    '',
    'Start-Sleep -Milliseconds 600',
    '',
    'try {',
    "  $startArgs = @{ FilePath = $exePath; WorkingDirectory = (Split-Path -LiteralPath $exePath) }",
    '  if ($null -ne $relaunchArgs) { $startArgs.ArgumentList = $relaunchArgs }',
    '  Start-Process @startArgs | Out-Null',
    '  Write-Log "relaunch issued"',
    '} catch {',
    '  Write-Log ("relaunch failed: " + $_.Exception.Message)',
    '}',
    '',
    '# A cold Electron start can outlast the settle window; try once more before',
    '# giving up, so a slow first attempt does not leave the app down.',
    'Start-Sleep -Seconds 4',
    'if ((Get-AppProcesses).Count -eq 0) {',
    '  Write-Log "no app process after relaunch; retrying"',
    '  Start-Sleep -Seconds 2',
    '  try {',
    "    $retryArgs = @{ FilePath = $exePath; WorkingDirectory = (Split-Path -LiteralPath $exePath) }",
    '    if ($null -ne $relaunchArgs) { $retryArgs.ArgumentList = $relaunchArgs }',
    '    Start-Process @retryArgs | Out-Null',
    '    Write-Log "relaunch retried"',
    '  } catch {',
    '    Write-Log ("relaunch retry failed: " + $_.Exception.Message)',
    '  }',
    '  Start-Sleep -Seconds 4',
    '}',
    '',
    'Write-Log ("running app processes after relaunch: " + (Get-AppProcesses).Count)',
    ''
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

/**
 * The VBScript that starts the helper PowerShell without a console window.
 *
 * wscript.exe is a GUI-subsystem binary, so it never allocates a console. That
 * is the whole point: putting powershell.exe in the shortcut directly makes
 * conhost allocate a visible console window even with `-WindowStyle Hidden`
 * and `WindowStyle = 7`, which shows up as a black box flashing on screen.
 * WshShell.Run with window style 0 hands the helper to a hidden window instead.
 */
function bootSource(helperPath) {
  const quote = "Chr(34)"
  return [
    'Option Explicit',
    'Dim shell, command',
    'Set shell = CreateObject("WScript.Shell")',
    `command = ${quote} & ${vbsLiteral(SHELL)} & ${quote} & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & ${quote} & ${vbsLiteral(helperPath)} & ${quote}`,
    'shell.Run command, 0, False',
    ''
  ].join('\r\n')
}

function launcherSource(shortcutPath, helperPath, bootPath) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$shortcutPath = ${psLiteral(shortcutPath)}`,
    `$bootPath = ${psLiteral(bootPath)}`,
    `$wscriptExe = ${psLiteral(WSCRIPT)}`,
    `$explorerExe = ${psLiteral(EXPLORER)}`,
    '',
    '# explorer.exe must own the helper: anything spawned by this process inherits',
    '# the desktop Job Object, whose KILL_ON_JOB_CLOSE flag would wipe it out the',
    '# instant the app exits. Handing it to explorer puts it outside that job.',
    '#',
    '# The shortcut targets wscript, not powershell: wscript is a GUI process, so',
    '# no console window is ever created for the helper it goes on to start.',
    '$shell = New-Object -ComObject WScript.Shell',
    '$shortcut = $shell.CreateShortcut($shortcutPath)',
    '$shortcut.TargetPath = $wscriptExe',
    `$shortcut.Arguments = '"' + $bootPath + '"'`,
    '$shortcut.WorkingDirectory = (Split-Path -LiteralPath $bootPath)',
    '$shortcut.WindowStyle = 7',
    '$shortcut.Save()',
    '',
    `Start-Process -FilePath $explorerExe -ArgumentList ('"' + $shortcutPath + '"')`,
    ''
  ].join('\n')
}

/**
 * A helper that only records that it ran.
 *
 * The restart handoff is the fragile part, so `?probe=1` runs the exact same
 * spawn + shortcut + explorer path with this harmless script instead: it proves
 * the machinery inside the live host without taking the app down.
 */
function probeSource(logPath) {
  return [
    `Add-Content -LiteralPath ${psLiteral(logPath)} -Value ("probe helper ran at " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"))`,
    ''
  ].join('\n')
}

/** Forget runs nobody will read again; a directory per press must not pile up forever. */
function pruneRuns(root) {
  try {
    const runs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
    for (const name of runs.slice(KEEP_RUNS)) {
      try {
        rmSync(join(root, name), { recursive: true, force: true })
      } catch {
        /* another press may still be writing there; it will be pruned next time */
      }
    }
  } catch {
    /* no history yet, or nothing to clean: neither is a failure worth reporting */
  }
}

let relaunchOrigin = { getOrigin: () => undefined }

/**
 * Write the restart scripts and, unless this is a dry run, hand the launcher to
 * explorer.exe.
 *
 * `launch: false` exists so the endpoint can be exercised end to end without
 * taking the running app down: it still proves the files, the port and the
 * target resolve correctly. `probe: true` goes one step further and exercises
 * the real handoff with a helper that does nothing.
 */
function prepare(target, launch = true, probe = false) {
  const root = join(tmpdir(), 'dsh-restart')
  const directory = join(root, stamp())
  mkdirSync(directory, { recursive: true })
  pruneRuns(root)

  const helperPath = join(directory, 'restart.ps1')
  const shortcutPath = join(directory, 'restart.lnk')
  const launcherPath = join(directory, 'launch.ps1')
  const bootPath = join(directory, 'boot.vbs')
  const logPath = join(directory, 'restart.log')

  let port = 0
  try {
    const parsed = new URL(relaunchOrigin.getOrigin?.() ?? '')
    port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)
  } catch {
    port = 0
  }

  const script = probe ? probeSource(logPath) : helperSource(target, Number.isFinite(port) ? port : 0, logPath)
  writeFileSync(helperPath, script, 'utf8')
  writeFileSync(bootPath, bootSource(helperPath), 'utf8')
  writeFileSync(launcherPath, launcherSource(shortcutPath, helperPath, bootPath), 'utf8')

  const launchLog = join(directory, 'launch.log')
  const events = []

  if (launch) {
    events.push(`spawn ${SHELL} -> ${launcherPath}`)
    try {
      // Detached children of the host never start here: the Windows Job Object
      // kills the created process before it can run, so the launcher is spawned
      // as an ordinary child. It only builds the shortcut and asks explorer to
      // run it, which takes well under a second.
      const child = spawn(SHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', launcherPath], {
        cwd: directory,
        stdio: 'ignore',
        windowsHide: true
      })
      child.on('error', (error) => {
        events.push(`error: ${messageOf(error)}`)
        writeFileSync(launchLog, events.join('\n') + '\n', 'utf8')
        log(`launcher error: ${messageOf(error)}`)
      })
      child.on('exit', (code, signal) => {
        events.push(`exit code=${String(code)} signal=${String(signal)} lnk=${existsSync(shortcutPath)}`)
        writeFileSync(launchLog, events.join('\n') + '\n', 'utf8')
      })
      if (typeof child.pid === 'number') events.push(`pid ${child.pid}`)
      child.unref()
    } catch (error) {
      events.push(`threw: ${messageOf(error)}`)
    }
    writeFileSync(launchLog, events.join('\n') + '\n', 'utf8')
    log(`${probe ? 'probe' : 'restart'} handed to explorer; run ${directory}`)
  } else {
    log(`${probe ? 'probe' : 'restart'} dry run written to ${directory}`)
  }

  return { exe: target.exe, mainPid: target.mainPid, log: logPath, port, directory, launched: launch, probe, launchLog }
}

/** A nested-transaction rejection is a queue collision, not a broken profile. */
function isNestedTransaction(error) {
  return /\btransactions? cannot be nested\b/iu.test(String(error?.message ?? error))
}

function boundedList(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : []
}

/**
 * When the Client half of this plugin last changed on disk, in epoch ms.
 *
 * The alternative -- comparing the Client module graph before and after -- does
 * not work: an entry's `rev` only moves when the HMR watch calls `rebuilt(id)`,
 * so editing client.js by hand leaves the graph identical and the page would be
 * wrongly declared current. A file stamp is the actual truth of "has this code
 * changed", and the page pairs it with the moment it evaluated its own copy.
 */
function clientStamp() {
  try {
    return statSync(join(here, 'client.js')).mtimeMs
  } catch {
    return null
  }
}

/**
 * Reload plugin code without restarting the app.
 *
 * Replacing an installed package needs a fresh JavaScript module generation,
 * and the hot-reload service is what produces one: it recomposes the profile,
 * evicts the changed modules, restarts the entries that ran them and publishes
 * the new resolution. The running page keeps its old copy until it reloads, but
 * nothing the user was doing is torn down -- the host never exits.
 *
 * This is strictly the safer half of the button: it cannot lose a running turn.
 */
async function softReload(ctx) {
  const hmr = typeof ctx?.get === 'function' ? ctx.get('hmr') : undefined
  if (hmr === undefined || typeof hmr.reconcileProfile !== 'function') {
    return { ok: false, error: 'hot reload is unavailable in this host' }
  }

  const run = () => (typeof hmr.runExclusive === 'function' ? hmr.runExclusive(() => hmr.reconcileProfile()) : hmr.reconcileProfile())

  let lastError
  for (let attempt = 1; attempt <= RELOAD_RETRIES; attempt += 1) {
    try {
      const result = await Promise.race([
        run(),
        delay(RELOAD_TIMEOUT_MS).then(() => {
          throw new Error(`hot reload did not finish within ${RELOAD_TIMEOUT_MS} ms`)
        })
      ])
      const answer = {
        ok: true,
        attempt,
        warnings: boundedList(result?.warnings, 20).map(oneLine),
        pending: boundedList(result?.pending, 50).map((item) => ({ url: oneLine(item?.url), reason: oneLine(item?.reason) })),
        restartReason: result?.restartReason === undefined ? null : oneLine(result.restartReason),
        // The page compares this against the moment it evaluated its own copy:
        // a newer stamp means the running document predates the file and has to
        // be replaced. The host cannot answer that question alone.
        clientStamp: clientStamp()
      }
      log(`hot reload ok on attempt ${attempt}: warnings=${answer.warnings.length} pending=${answer.pending.length} restartReason=${answer.restartReason}`)
      return answer
    } catch (error) {
      lastError = error
      log(`hot reload attempt ${attempt} failed: ${messageOf(error)}`)
      if (!isNestedTransaction(error)) break
      await delay(RELOAD_RETRY_MS * attempt)
    }
  }
  return { ok: false, error: messageOf(lastError) }
}

function codeStamp() {
  try {
    return statSync(join(here, 'index.js')).mtime.toISOString()
  } catch {
    return null
  }
}

function readVersion() {
  try {
    // Bounded read: a package.json is small, and this must not block on a
    // device or a FIFO the way an unbounded read could.
    const parsed = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** Exposed so the generated scripts can be exercised without restarting a live app. */
export const internals = { helperSource, launcherSource, bootSource, desktopTarget, clientStamp }

export const inject = ['webServer']

/**
 * Host half: exposes the endpoints the Client buttons call.
 *
 * A full restart cannot happen in this process. The host runs inside a Windows
 * Job Object with KILL_ON_JOB_CLOSE, so anything spawned here dies together
 * with the desktop app. The helper is therefore handed to explorer.exe first,
 * which places it outside that job, and only then does it stop and relaunch the
 * app. The hot-reload route exists so that most plugin updates never need that.
 */
export function apply(ctx) {
  relaunchOrigin = ctx.webServer

  const sendState = (res) => {
    const target = desktopTarget()
    const hmr = typeof ctx?.get === 'function' ? ctx.get('hmr') : undefined
    json(res, 200, {
      ok: true,
      version: readVersion(),
      // Two different truths: the installed version text, and the code actually
      // loaded. Comparing the stamp against the file tells them apart.
      code: codeStamp(),
      // The proof that a hot reload published a new generation: this value is
      // read once, when the module is imported.
      build: BUILD,
      canRestart: target !== undefined,
      canReload: hmr !== undefined && typeof hmr.reconcileProfile === 'function',
      mainPid: target?.mainPid ?? null,
      exe: target?.exe ?? null,
      pending: pressActive(),
      log: LOG_FILE
    })
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: guard(STATE_ROUTE, (req, res) => {
          if (req.method !== 'GET') {
            json(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!fromLoopback(req)) {
            json(res, 403, { ok: false, error: 'only available from this machine' })
            return
          }
          sendState(res)
        })
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: SOFT_ROUTE,
        handler: guard(SOFT_ROUTE, (req, res) => {
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!fromLoopback(req)) {
            json(res, 403, { ok: false, error: 'only available from this machine' })
            return
          }
          if (!fromOwnPage(req)) {
            json(res, 403, { ok: false, error: `missing ${BUTTON_HEADER} header` })
            return
          }
          return softReload(ctx).then((result) => {
            json(res, result.ok === true ? 200 : 500, result)
          })
        })
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: guard(ROUTE, (req, res) => {
          // Write route only: the state the old diagnostic branch reported now
          // lives on STATE_ROUTE, so a GET here has nothing to offer.
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!fromLoopback(req)) {
            json(res, 403, { ok: false, error: 'restart is only available from this machine' })
            return
          }
          if (!fromOwnPage(req)) {
            json(res, 403, { ok: false, error: `missing ${BUTTON_HEADER} header` })
            return
          }
          if (pressActive()) {
            json(res, 429, { ok: false, error: 'a restart is already in progress' })
            return
          }
          const target = desktopTarget()
          if (target === undefined) {
            json(res, 501, { ok: false, error: 'restart is only supported inside the desktop app' })
            return
          }
          const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
          const dry = params.get('dry') === '1'
          const probe = params.get('probe') === '1'
          try {
            const plan = prepare(target, !dry, probe)
            if (dry) {
              json(res, 200, { ok: true, dryRun: true, ...plan })
              return
            }
            if (probe) {
              json(res, 200, { ok: true, probe: true, ...plan })
              return
            }
            press.at = Date.now()
            json(res, 202, { ok: true, mainPid: plan.mainPid, log: plan.log, run: plan.directory, launchLog: plan.launchLog })
          } catch (error) {
            log(`restart failed: ${messageOf(error)}`)
            json(res, 500, { ok: false, error: messageOf(error) })
          }
        })
      })
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* the server may already be closing; there is nothing left to undo */
        }
      }
    }
  }, 'dsh-restart-button: routes')
}
