# Changelog

## 0.4.0 — 2026-11-01

**第二次点击就是重启。** 之前只有 Harness 明确报告「必须重启」时按钮才肯升格成重启按钮；
现在同一个页面里的第二次点击也算——刷新成功了还再点一次，本身就是「这次刷新没解决问题」的表达。

### 新增

- 刷新成功后按钮进入 **armed** 状态：停止 3 秒的「插件已刷新」提示后，标签和颜色都变成「完全重启」，下一按直接重启应用。
- armed 的生命周期就是页面本身：真正换掉客户端代码的刷新会让页面自己重载（模块重新求值，自动解除 armed），完全重启同理，所以不存在「越点越重」的循环。

### 修复

- 500ms 内的第二次点击按双击处理，直接忽略：第一下的结果可能在第二下点击之前就回来了，此时按钮已经 armed，误触会真的重启。

### 验证

- `test/second-press.test.mjs`：用假 React + 可拨时钟 + 打桩 fetch 驱动真实组件，覆盖「第一下刷新 / 第二下重启」「宿主返回 restartReason」「双击只发一次请求」「刷新失败不 arm，只重试刷新」四种路径，12 条断言全过。

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
