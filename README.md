# dsh-restart-button

**简体中文** · [English](README.en.md)

一个装在侧边栏底部的**重载 / 重启**按钮，给 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面版用。

装插件、更新插件，过去都得关掉应用再打开一次。这个插件在侧边栏放了一个按钮替你做这件事——更重要的是，它**尽量不重启**。

```
点击  ->  原地热重载插件      （正在跑的东西一样不丢）
           |
           +-- 热重载不成  ->  按钮变成「完全重启」，再点一次 -> 应用重新拉起
           +-- 热重载成了  ->  按钮变成「完全重启」，再点一次 -> 同样重新拉起
```

刷新过之后按钮就只有一个意思：**再按一次 = 重启**。

---

## 为什么不干脆重启？

因为 `app.relaunch()` 没有它看起来那么便宜。

替换插件包之后，Harness 自己的 HMR 层可以在**运行中的宿主进程内部**驱逐已变更的模块再把它们启动起来。正在跑的轮次、子代理、终端、排队中的消息、还没发出去的草稿——全都在，因为什么都没被杀掉。

完全重启是「这件事不可能做到时」的兜底（模块驱逐不掉、包在磁盘上挪了位置），不是默认动作。

所以按钮默认走便宜的那条路。什么时候才给贵的那条？两种情况：

1. **Harness 明确报告必须重启**——`hmr.reconcileProfile()` 返回 `restartReason: 'module-comparison' | 'package-moved'`。
2. **你按了第二次**——刷新成功了，你还是按了一次，那就说明这次刷新没解决你的问题。

第二条是可以自己判断的：真正改动到客户端代码的刷新会让页面自己换掉（按钮跟着重置）；按钮还在原地等你，就说明这次热重载什么都没换，再按的价值已经没有了。所以同一个页面里，第一下是刷新，第二下就是重启，而且会在按之前先把按钮标签改成「完全重启」。

误触被挡掉了：500ms 内的第二次点击算双击，不执行。

---

## 安装

这是一个 Cordis bundle。先从源码检出：

```bash
git clone https://github.com/accoutmissing/dsh-restart-button.git
```

然后用那个目录安装 bundle（Harness 通过它的插件管理器暴露这个能力；由 agent 驱动时就是 `plugin_manager` 工具）：

```jsonc
{ "action": "install_bundle", "target": "D:/path/to/dsh-restart-button" }
```

安装成功会返回 `application: "applied"`。按钮立刻出现在侧边栏底部——安装它本身不需要重启。

以后更新：`git pull`，然后按按钮。

---

## 使用

| 按钮显示 | 含义 | 点击会发生什么 |
|---|---|---|
| ⟳ **刷新插件** | 空闲 | 原地热重载已变更的插件代码 |
| ⟳ *正在刷新…* | 进行中 | — |
| ✓ **已刷新** | 完成 | 3 秒后回到空闲 |
| ⟳ **完全重启** | 热重载报告无法原地完成 | 杀掉应用并重新拉起 |
| ⚠ **刷新失败** | 出错（同时写日志） | 3 秒后回到空闲 |

---

## 实现

### 宿主侧（`index.js`）

通过 `webServer` 注册三条路由：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/plugins/dsh-restart-button/__state` | GET | 自描述：版本、代码代号、能力、pid |
| `/plugins/dsh-restart-button/__reload` | POST | `hmr.runExclusive(() => hmr.reconcileProfile())` |
| `/plugins/dsh-restart-button/__restart` | POST | 完整 kill 后重新拉起 |

热重载这条路套在 `hmr.runExclusive()` 里，因为 `reconcileProfile()` 参与宿主的串行队列；与自动重载撞车时会冒出一个 `transactions cannot be nested`，这个错误被识别并退避重试（3 次，400 ms × n）。另加 20 秒上限，免得一次卡死的重载把按钮永久占住。

### 客户端（`client.js`）

挂在 `sidebar.footer.action` 上的状态机，order 90。它的状态放在**模块级 store，而不是组件 state 里**：这个插槽在每次 store 更新时都会被重新投影，组件随之重挂载。用组件 `useState` 的话，两次点击之间状态会被打回 `idle`；模块级 store 活得下来。

### 判断新的客户端代码有没有真的加载

宿主返回 `clientStamp`——`client.js` 的 mtime。页面在模块求值的那一刻记下 `LOADED_AT`。如果 `clientStamp > LOADED_AT + 1000 ms`，说明这个页面跑的是旧的客户端代码，等插件字节确认是新的之后它自己整页重载。

第一版实现比的是 `clientModules.graph().rev`。那是**错的**：`rev` 只在 HMR 监视器登记重建时才前进，手改 `client.js` 图表纹丝不动，页面会被永远判成「最新」。现在改成比文件戳。

### 启动链路（Windows）

这是耗时最长的一部分，也是你打算做类似事情时最值得读的一部分。

插件跑在宿主进程里，而宿主是 Electron 的普通 Node 子进程（`ELECTRON_RUN_AS_NODE=1`）。它调不到 `app.relaunch()`。所以重启被交给操作系统：

```
宿主插件
  └─ powershell  launch.ps1        生成 .lnk，请 explorer.exe 打开它
       └─ explorer.exe             持有快捷方式的启动
            └─ wscript.exe         快捷方式目标；GUI 子系统，不建控制台
                 └─ boot.vbs       WScript.Shell.Run "powershell ... ", 0, False
                      └─ powershell restart.ps1    杀应用、等端口释放、重新拉起
```

四条约束塑造了它，每一条都是撞出来的：

1. **`detached: true` 在这里不能用。** 宿主跑在带 `KILL_ON_JOB_CLOSE` 的 Windows Job Object 里；映射成 `DETACHED_PROCESS` 的进程在创建瞬间就被终止——没有报错、没有日志、进程表里查不到。启动器必须用普通方式 spawn，然后自己退出。
2. **explorer.exe 必须是父进程。** 宿主 spawn 出来的任何东西都会继承那个 job object。经过 explorer 一环才能断链。（这也是为什么启动器是一个 `.lnk` 而不是直接 `Start-Process`。）
3. **快捷方式必须指向 `wscript.exe`，不是 `powershell.exe`。** wscript 是 GUI 子系统程序，永远不分配控制台，所以屏幕上不会闪黑框。实测：指向 powershell 恰好多出一个 `CASCADIA_HOSTING_WINDOW_CLASS` 窗口；指向 wscript 多出零个。
4. **`.lnk` 的 `Arguments` 必须用双引号。** 用单引号包路径会让 explorer 静默什么都不做——没窗口、没报错、没日志。而真实可执行文件路径里带空格，所以这条是必须修的。

helper 还会在目标进程的 `.Path` 与预期可执行文件不匹配时拒绝执行，因此它不可能杀错应用。

---

## 安全

两条 POST 路由都要求请求头 `x-dsh-restart-button` 以及 loopback 来源地址。

真正承重的是那个请求头。只查 loopback 只能证明请求来自本机——你访问的任何网站上的一个表单都能 POST 到 `127.0.0.1`，而一次重启对你正在做的事情就是拒绝服务。自定义请求头在跨源时无法携带，除非有一次服务端永远不会批准的预检，所以真正拦住它的是请求头检查。对写路由发 GET 会得到 `405`，不是重定向也不是状态页。

---

## 日志与临时文件

- `~/.dsh/restart-button.log` —— 每次动作一行，到 1 MB 轮转成 `.1`。每一行都做过消毒：控制字符换成空格，恶意的字段无法伪造日志条目。
- `%TEMP%\dsh-restart\<timestamp>\` —— 每次调用生成的 `restart.ps1`、`boot.vbs`、`launch.ps1` 和 `launch.log`。只保留最近 20 个。

重启路由加 `?dry=1` 只生成脚本不执行。加 `?probe=1` 会用替身 helper（只记一行日志然后退出）跑完整条启动链路——用于在不真正杀掉应用的前提下验证链路仍然可用。

---

## 已实测的行为

| 声明 | 证据 |
|---|---|
| 热重载真的换了代码 | 模块级代号常量在三次修改中依次走过 `undefined → gen-1 → gen-2 → gen-3`，每次修改后各发一次 `POST __reload`（200，`warnings: 0`，`pending: 0`） |
| 不出现控制台窗口 | 用 `EnumWindows` 统计可见控制台窗口，前后相比 `delta = 0` |
| 完全重启可用 | 自测脚手架：旧 pid 死、新 pid 活；在真实应用里也能从 GUI 端口变化看出来 |
| 完全重启不是黑盒 | 每次运行都有 `launch.log` + `restart.log` 记录每一步 |
| CSRF 守门有效 | 不带请求头的 POST：`403 missing x-dsh-restart-button header` |
| 路由方法守门有效 | 对两条写路由发 GET：`405` |

完全重启只在此前的 **Windows** 上验证过——启动链路本身只针对这个平台。热重载用的是有文档的宿主服务，不限于 Windows，但尚未在其他平台测过。

---

## 与 `dsh-unlag` 的关系

[`dsh-unlag`](https://github.com/regrevia/dsh-unlag)（作者 [regrevia](https://github.com/regrevia)，MIT）用另一种取舍解决同一个底层问题。读它改变了本插件的设计，这笔账具体到能点名。

设计对照的是 **`dsh-unlag` v1.14.16**。这不是 fork，没有共同提交历史；是独立实现。

**从阅读中吸收的部分**——前五项已经接近到该算「借用」而不是「各自想到」：

| 借用 | 在本插件中的位置 |
|---|---|
| `transactions? cannot be nested` 的重试机制，含正则 | `index.js` 的 `isNestedTransaction()` |
| `RELOAD_TIMEOUT_MS = 20_000`、`LOG_MAX_BYTES = 1_000_000` | `index.js` 常量 |
| `oneLine()` —— 每个字段进日志行之前先消毒 | `index.js` 的 `oneLine()` |
| 用自定义请求头做写路由的 CSRF 守门 | `BUTTON_HEADER` / `fromOwnPage()` |
| 热重载优先，而不是当兜底 | `softReload()`，以及按钮的默认动作 |
| 用代号常量作为「新代码到底有没有加载」的唯一诚实答案 | `BUILD` |

**未采纳：** 它的 `/plugins` 路由 shim。`dsh-unlag` 为过期版本提供替身模块，因为桌面壳在启动时冻结启动清单，旧页面按旧 revision 请求会 404 并把应用以退出码 1 带走。本插件改走整页重载，所以没有旧客户端代次需要续命——也就不需要在每次上游变更时维护一层平台并不认可的兼容层。

除此之外的一切——启动链路、job object 逃逸、wscript 快捷方式、杀掉再等待再拉起的序列——`dsh-unlag` 里完全没有。它从不重启。

---

## 许可证

MIT
