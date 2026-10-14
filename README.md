# dsh-restart-button

给 **DSH 桌面端（Windows）** 的标题栏菜单栏加一个「重启」按钮：点一下，整个应用（Electron shell + DSH Host + 渲染进程 + 插件守护进程）退出并自动重新打开。

![菜单栏示意图](assets/preview.svg)

---

## 为什么需要它

DSH 桌面端的「应用」菜单是 **Electron 主进程** 用原生 `Menu` 弹出的（`applicationItems()`，打包在 `app.asar` 内）。菜单里本来就有一项「重启应用与 Host」，但它被 `development`（`!app.isPackaged`）门槛挡住，**正式安装包里看不到**。

而 DSH 插件运行在 **Host 子进程** 里：

```
"DeepSeek Harness.exe" --expose-internals "...\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js" ...
```

这个子进程：

- 拿不到 `app.relaunch()` / `app.quit()` —— 那是主进程的 API；
- 没有任何往原生菜单插项的扩展点 —— 菜单项列表硬编码在主进程里；
- 没有「请求主进程重启」的 IPC 通道 —— IPC 只允许主进程 → Host 单向指挥（`shutdown` / `quit-inspection` / `update-tasks`）。

所以插件只能**从外面把应用关掉再拉起来**。这正是本插件做的事：不改 `app.asar`、不依赖桌面端版本、装一次就一直在。

## 工作原理

### host 半边（`host.js`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/restart-button/status` | 可用性 + 进程信息（`exe`、`appName`、`workdir`、`mainPid`、`hostPid`、`electronVersion`、`logPath`） |
| POST | `/restart-button/restart` | 安排一次重启，立刻返回 `{ ok, via, dryRun, delayMs, scriptPath, logPath }` |

`POST /restart` 的动作序列：

1. 把一段 PowerShell 助手脚本写到 `%TEMP%\dsh-restart-button-<random>.ps1`；
2. 通过 **WMI**（`Invoke-CimMethod -ClassName Win32_Process -MethodName Create`）创建它 —— WMI 创建的进程挂在 `WmiPrvSE.exe` 名下，**不属于本应用的进程树**，因此第 4 步「按 exe 路径杀掉整个应用」不会把助手自己一起杀掉（WMI 不可用时退化为 `spawn(..., { detached: true, stdio: "ignore" })`）；
3. 助手先睡 `1500ms`，让 HTTP 响应先回到页面（否则页面会看到连接被掐断）；
4. 按 **exe 路径**枚举并终止该应用的所有进程：主进程 + Host + 渲染/GPU 进程 + 用同一个 exe 以 Node 模式跑的插件守护进程（例如 `billion-context` 的 `... start --host 127.0.0.1 --port 18789`），轮询 30s，必要时兜底 `taskkill /IM`；
5. 从主进程原始命令行里取出参数（正常情况下为空），用 `Start-Process -WorkingDirectory <安装目录>` 重新启动同一个 exe。

日志写在 `%TEMP%\dsh-restart-button.log`，每次重启的完整决策链（目标 PID 列表、是否 dry-run、重启命令行）都在里面。

### client 半边（`client.js`）

Windows 的「应用 / 编辑」菜单栏不是原生菜单条，而是桌面端 preload **画在页面里的 DOM**（`div[data-windows-menu]`，open shadow root）。client 半边在这个菜单栏里追加第三个按钮「重启」：

- 点击 → 确认气泡（中英双语，跟随 `document.documentElement.lang`）；
- 确认 → `POST /restart-button/restart` → 全屏遮罩 + 每 2s 轮询 `/status`（探不通 = Host 已退出，说明重启已生效）；
- 25s 内仍能探通则提示失败并可重试；
- 2.5s 内找不到菜单栏（例如跑在 `dsh web` 里）→ 退化为右下角浮动按钮 `#dsh-restart-button-floating`。

### 安全边界

两个路由都带栅栏，只接受：**loopback Host** + **非 `cross-site`** + **origin 同源或 `dsh-app://app`** 的请求（与官方插件 `isTrustedApiRequest` 相同的判定口径）。

## 安装

> 前置：DSH 桌面端（Windows）。profile 目录默认 `%USERPROFILE%\.dsh\profiles\desktop`。

### 方式 A：用 dsh-super-injector（最省事，热装配免重启）

如果你装了 **dsh-super-injector**（DSH 插件运行时注入器），直接注入本目录的绝对路径：

```
dev_inject_plugin   dir=<本插件目录绝对路径>
```

或写进 profile（重启后仍在）：

```
dev_install_package dir=<本插件目录绝对路径> profile=desktop
```

> ⚠️ 两种注入方式与 bundle patch 的正式条目**不要同时存在**：`dev_install_package` 会先建一个临时 entry（幽灵），而 `cordis.patch.yml` 的正式 entry 后加载时会因为路由重复报
> `webserver: duplicate prefix route "/restart-button"`。处置：清掉幽灵 entry 后让正式 entry `refresh()`，或干脆重启一次应用（正式条目会正常加载）。

### 方式 B：手动装进 profile

1. 把插件目录放进 profile 的 `node_modules`（目录拷贝或 junction 均可）：

   ```bat
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-restart-button" "C:\path\to\dsh-restart-button"
   ```

2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

   ```jsonc
   {
     "dependencies": {
       "dsh-restart-button": "link:C:\\path\\to\\dsh-restart-button"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // ... 其它 bundles ...
           "dsh-restart-button"
         ]
       }
     }
   }
   ```

3. 重启 DSH（关掉桌面端再打开，或重启 `dsh web`）。

### 方式 C：从 GitHub / tgz 安装

在 profile 目录里用 DSH 捆绑的 pnpm 安装，再把包名加进 `dsh.profile.bundles`，然后重启：

```bash
# 直接从 GitHub
pnpm add "dsh-restart-button@github:wangbofan/dsh-restart-button"
# 或从打包产物
pnpm add "file:C:\path\to\dsh-restart-button-1.0.0.tgz"
```

### 卸载

从 `dsh.profile.bundles` 与 `dependencies` 里删掉 `dsh-restart-button`，删掉 `node_modules` 下的链接，重启 DSH 即可（插件不写任何其它位置，除 `%TEMP%` 下的脚本与日志）。

## 使用

标题栏菜单栏：`应用 | 编辑 | 重启` → 点「重启」→ 确认气泡 → 应用关闭并自动重新打开。

> 位置说明：原生「应用」下拉的菜单项列表在 Electron 主进程内，插件无法插入菜单项，所以按钮做在菜单栏上、紧邻「应用」。

## 配置

| 环境变量 | 作用 |
| --- | --- |
| `DSH_RESTART_BUTTON_DRY_RUN=1` | 演练模式：助手只把将要终止的 PID 与重启命令行写进日志，**不真的杀进程** |

代码内常量（`host.js`）：`ROUTE_PREFIX = "/restart-button"`、`HELPER_DELAY_MS = 1500`。

## 自测

用 DSH 捆绑的 node（本机 `node` 不在 PATH 时）：

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\self-test.mjs
```

它会：生成一份 dry-run 助手脚本 → 用 PowerShell 解析器校验语法 → **用与插件完全相同的 WMI 方式**启动它 → 读日志断言（目标 PID 列表、`dry run: the application is left running`、重启命令行）。整个过程不碰正在运行的应用。

实测输出（本机 8 个同 exe 进程）：

```
targets: 21152, 5396, 25584, 18908, 17060, 17236, 15228, 23980
dry run: the application is left running
dry run: would start: C:\...\DeepSeek Harness\DeepSeek Harness.exe
```

## 兼容性与限制

- 仅 **Windows 桌面端**；`dsh web` 下 `capabilities()` 会返回 `available: false`（`reason: "not-supervised"`），client 半边退化为浮动按钮但点击会提示不可用。
- **不是优雅关闭**：按 exe 路径硬杀进程树，正在跑的任务会被中断（确认气泡里有提示）。
- 不修改 `app.asar`，桌面端更新后依然有效。
- 重启后窗口位置/会话由桌面端自己恢复；本插件不保存任何状态。

## License

MIT © wangbofan

---

## English (brief)

`dsh-restart-button` adds a **Restart** button to the DSH desktop titlebar menu bar (Windows). The native「应用」dropdown is built inside the Electron main process and has no plugin extension point, and plugins run in the *Host child process* with no way to call `app.relaunch()`. So the Host half (`host.js`) exposes `POST /restart-button/restart`, which writes a PowerShell helper and creates it through **WMI** (so it lives outside the app's process tree), waits 1.5s, kills every process of the app by executable path, and relaunches the exe. The client half (`client.js`) appends a「重启 / Restart」button to the titlebar menu bar (an open shadow root rendered by the desktop preload) with a confirm popover. Windows only; hard restart (running tasks are interrupted); no `app.asar` patching.
