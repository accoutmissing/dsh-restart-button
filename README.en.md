# dsh-restart-button

[简体中文](README.md) · **English**

A one-click **reload / restart** button for the [DeepSeek Harness](https://github.com/deepseek-ai) desktop app, sitting at the bottom of the sidebar.

Installing or updating a plugin normally means quitting the app and opening it again. This plugin puts a button in the sidebar that does it for you — and, more importantly, tries **not** to restart at all first.

```
click  ->  hot-reload plugins in place   (nothing running is lost)
           |
           +-- reload could not take  ->  button turns into "Full restart"
                                           click again -> app relaunches
```

---

## Why not just restart?

Because `app.relaunch()` is not the cheap operation it looks like.

When you replace a plugin package, the Harness's own HMR layer can evict the changed modules and start them again **inside the running host process**. Turns in flight, subagents, terminals, queued messages, unsent drafts — all survive, because nothing is killed.

A full restart is the fallback for the cases where that is impossible (a module that cannot be evicted, a package that moved on disk), not the default.

So the button defaults to the cheap path and only offers the expensive one when the Harness reports it is actually needed — `hmr.reconcileProfile()` returns `restartReason: 'module-comparison' | 'package-moved'` when it is.

---

## Install

The plugin is a Cordis bundle. Install it from a checkout:

```bash
git clone https://github.com/accoutmissing/dsh-restart-button.git
```

Then install the bundle from that directory (the Harness exposes this through its plugin manager, and via the `plugin_manager` tool when an agent is driving):

```jsonc
{ "action": "install_bundle", "target": "D:/path/to/dsh-restart-button" }
```

A successful install reports `application: "applied"`. The button appears at the bottom of the sidebar immediately — no restart needed to install *it*.

To update later: `git pull`, then press the button.

---

## Usage

| Button shows | Means | What a click does |
|---|---|---|
| ⟳ **Reload plugins** | idle | hot-reloads changed plugin code in place |
| ⟳ *Reloading…* | working | — |
| ✓ **Reloaded** | done | resets to idle after 3s |
| ⟳ **Full restart** | hot reload reported it cannot take | kills and relaunches the app |
| ⚠ **Reload failed** | error (also logged) | resets to idle after 3s |

---

## How it works

### Host side (`index.js`)

Three routes registered through `webServer`:

| Route | Method | Purpose |
|---|---|---|
| `/plugins/dsh-restart-button/__state` | GET | self-description: version, code generation, capabilities, pid |
| `/plugins/dsh-restart-button/__reload` | POST | `hmr.runExclusive(() => hmr.reconcileProfile())` |
| `/plugins/dsh-restart-button/__restart` | POST | full kill-and-relaunch |

The hot-reload path is wrapped in `hmr.runExclusive()` because `reconcileProfile()` participates in the host's transaction queue; a concurrent automatic reload surfaces as `transactions cannot be nested`, which is caught and retried with backoff (3 attempts, 400 ms × n). A 20 s ceiling stops a wedged reload from holding the button forever.

### Client side (`client.js`)

A state machine in `sidebar.footer.action`, order 90. Its state lives in a **module-level store, not component state**: the slot is re-projected on every store update, which remounts the component. Component `useState` would snap back to `idle` between clicks — the store survives.

### Knowing whether new client code actually loaded

The host returns `clientStamp` — the mtime of `client.js`. The page records `LOADED_AT` when the module is evaluated. If `clientStamp > LOADED_AT + 1000 ms`, this page is running stale client code, and it reloads itself once the plugin bytes are guaranteed new.

The first implementation compared `clientModules.graph().rev` instead. That is **wrong**: `rev` only advances when the HMR watcher registers a rebuild, so editing `client.js` by hand leaves the graph unchanged and the page is declared fresh forever. File stamps it is.

### The launcher chain (Windows)

The part that took the longest, and the part worth reading if you plan to do anything similar.

A plugin runs inside the host process, which is a plain Node child of Electron (`ELECTRON_RUN_AS_NODE=1`). It cannot call `app.relaunch()`. So the restart is handed to the OS:

```
host plugin
  └─ powershell  launch.ps1        creates a .lnk and asks explorer.exe to open it
       └─ explorer.exe             owns the shortcut launch
            └─ wscript.exe         shortcut target; GUI subsystem, no console
                 └─ boot.vbs       WScript.Shell.Run "powershell ... ", 0, False
                      └─ powershell restart.ps1    kill app, wait for port, relaunch
```

Four constraints shaped this, each found the hard way:

1. **`detached: true` does not work here.** The host runs inside a Windows Job Object with `KILL_ON_JOB_CLOSE`; a process mapped to `DETACHED_PROCESS` is terminated the instant it is created — no error, no log, nothing in the process table. The launcher must be spawned normally and die on its own.
2. **explorer.exe must be the parent.** Anything the host spawns inherits the job object. Going through explorer breaks the chain. (This is also why the launcher is a `.lnk` and not a direct `Start-Process`.)
3. **The shortcut must target `wscript.exe`, not `powershell.exe`.** wscript is a GUI-subsystem binary and never allocates a console, so nothing black flashes on screen. Measured: targeting powershell adds exactly one `CASCADIA_HOSTING_WINDOW_CLASS` window; targeting wscript adds zero.
4. **`.lnk` `Arguments` must use double quotes.** Single-quoted paths make explorer silently do nothing — no window, no error, no log. Since the real executable path contains spaces, this matters.

The helper also refuses to run if the target process's `.Path` doesn't match the expected executable, so it can never kill the wrong app.

---

## Security

Both POST routes require the header `x-dsh-restart-button` and a loopback remote address.

The header is the load-bearing part. A loopback check alone only proves the request came from this machine — a form on any website you visit can POST to `127.0.0.1`, and a restart is a denial-of-service on whatever you were doing. Custom headers cannot be set cross-origin without a preflight the server never approves, so the header check is what actually stops it. GET on a write route answers `405`, not a redirect or a status page.

---

## Logs and temp files

- `~/.dsh/restart-button.log` — one line per action, rotated to `.1` at 1 MB. Every line is sanitised: control characters become spaces so a hostile field cannot forge entries.
- `%TEMP%\dsh-restart\<timestamp>\` — the generated `restart.ps1`, `boot.vbs`, `launch.ps1` and `launch.log` for each invocation. Pruned to the 20 most recent.

`?dry=1` on the restart route writes the scripts and stops. `?probe=1` runs the whole launcher chain against a stub helper that logs one line and exits — useful to verify the chain still works without actually killing the app.

---

## Verified behaviour

| Claim | Evidence |
|---|---|
| Hot reload really swaps code | A module-level generation constant went `undefined → gen-1 → gen-2 → gen-3` across three edits, each followed by one `POST __reload` (200, `warnings: 0`, `pending: 0`) |
| No console window appears | `EnumWindows` count of visible console windows before/during/after: `delta = 0` |
| Full restart works | Self-test harness: old pid dies, new pid alive; the relaunch is also visible in the real app by the GUI port changing |
| Full restart is not a black box | `launch.log` + `restart.log` per run record every step |
| CSRF guard works | POST without the header: `403 missing x-dsh-restart-button header` |
| Route method guards work | GET on both write routes: `405` |

Full restart has only been exercised on **Windows** — that is the only platform the launcher chain targets. Hot reload uses a documented host service and is not Windows-specific, but it has not been tested elsewhere.

---

## Relationship to `dsh-unlag`

[`dsh-unlag`](https://github.com/regrevia/dsh-unlag) by [regrevia](https://github.com/regrevia) (MIT) solves the same underlying problem with a different trade-off. Reading it changed this plugin's design, and the debt is specific enough to name.

Design was compared against **`dsh-unlag` v1.14.16**. This is not a fork and shares no commit history; it is an independent implementation.

**Adopted from reading it** — the first five are close enough to call borrowed rather than independently arrived at:

| Borrowed | Where it lives in this plugin |
|---|---|
| The `transactions? cannot be nested` retry, including the regex | `isNestedTransaction()` in `index.js` |
| `RELOAD_TIMEOUT_MS = 20_000`, `LOG_MAX_BYTES = 1_000_000` | `index.js` constants |
| `oneLine()` — sanitising every field before it reaches a log line | `oneLine()` in `index.js` |
| A custom request header as the CSRF gate on write routes | `BUTTON_HEADER` / `fromOwnPage()` |
| Hot reload as the first choice rather than the fallback | `softReload()`, and the button's default action |
| The generation constant as the only honest answer to "did the reload load new code" | `BUILD` |

**Not adopted:** its `/plugins` route shim. `dsh-unlag` serves stand-in modules for stale revisions because the desktop shell freezes its boot manifest at startup, and an old page asking for an old revision would 404 and take the app down with exit code 1. This plugin reloads the page instead, so there is no old client generation to keep alive — and no compatibility layer the platform does not sanction to maintain on every upstream change.

Everything else — the launcher chain, the job-object escape, the wscript shortcut, the kill-and-wait-and-relaunch sequence — is not in `dsh-unlag` at all. That one never restarts.

---

## License

MIT
