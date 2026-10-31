# Changelog

## 0.3.0 — 2026-10-31

### Added

- **Click once, not twice.** The button no longer asks for confirmation. The slot is re-projected on every store update, which remounts the component; a component-level confirm flag was reset to idle between clicks, so the confirm state was unreachable in practice.
- **Stale-client detection.** The host reports `clientStamp` (mtime of `client.js`); the page compares it against the moment it evaluated that module and reloads itself when it is running stale code.
- `GET /plugins/dsh-restart-button/__state` — self-description: version, code generation, capabilities, pid, executable path, log path.
- `?dry=1` on the restart route — generate the launcher scripts without executing them.
- `?probe=1` on the restart route — exercise the whole launcher chain against a stub helper.

### Changed

- Write routes are POST-only; GET answers `405` instead of leaking a status page.
- Both POST routes require the `x-dsh-restart-button` header in addition to a loopback address. A loopback check alone does not stop cross-site form posts to `127.0.0.1`.
- The button's resting action is now **hot reload**; full restart is offered only when `reconcileProfile()` returns a non-null `restartReason`.

### Fixed

- `pageStale` never became true. It compared `clientModules.graph().rev`, which only advances when the HMR watcher registers a rebuild — a hand-edited `client.js` left the graph untouched. Now compares file mtimes.

## 0.2.0 — 2026-10-31

### Added

- **Hot reload.** `POST /__reload` runs `hmr.runExclusive(() => hmr.reconcileProfile())`, replacing changed plugin code inside the running host process without restarting the app.
- Nested-transaction retry: `transactions cannot be nested` is recognised and retried with backoff (3 attempts, 400 ms × n).
- 20 s ceiling on a reload so a wedged recomposition cannot hold the button.
- Structured action log at `~/.dsh/restart-button.log`, rotated to `.1` at 1 MB, with control characters stripped from every field.
- Generated run directories under `%TEMP%\dsh-restart\` pruned to the 20 most recent.
- Defensive handler wrapper: every route callback is guarded, and responses check `headersSent` before writing.

### Changed

- A module-level `BUILD` constant is reported by `__state`, so "did the hot reload actually load new code" has an answer that cannot be faked by re-reading `package.json` from disk.

## 0.1.0 — 2026-10-30

### Added

- Sidebar-footer button that kills and relaunches the desktop app.
- Launcher chain that survives the Windows job object: `.lnk` → explorer.exe → `wscript.exe` → `boot.vbs` → PowerShell helper.
- No console window: the shortcut targets `wscript.exe`, a GUI-subsystem binary, instead of `powershell.exe`.
- Helper refuses to act unless the target process executable path matches, so it cannot kill the wrong application.
- Waits for the listening port to be released before relaunching.
