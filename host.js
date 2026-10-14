/**
 * dsh-restart-button — host half.
 *
 * Why this file exists at all: the desktop「应用」menu is built by the Electron main
 * process (`applicationItems()` in app.asar), and the Host — this process — is a
 * *child* of that main process, started as `DeepSeek Harness.exe --expose-internals
 * .../dsh-desktop-host/lib/index.js`. Plugin code therefore cannot reach `app.relaunch()`,
 * cannot add items to the native menu, and has no IPC channel to ask main to restart.
 *
 * What is left is to close the application from the outside and start it again, which is
 * exactly what this route does:
 *
 *   GET  /restart-button/status   → { ok, available, reason, exe, mainPid, ... }
 *   POST /restart-button/restart  → schedules a detached PowerShell helper that
 *                                   terminates every process of this application
 *                                   (main + Host + renderers) and relaunches the exe.
 *
 * The helper is created through WMI (`Win32_Process.Create`) on purpose: a process made
 * that way belongs to WmiPrvSE, not to this application's process tree, so killing the
 * tree cannot take the helper down with it. A plain detached child is kept as a fallback
 * (it also survives because the kill is done by executable path, not by process tree).
 *
 * The route is fenced the same way the shipped plugins fence theirs: loopback Host,
 * same-origin (or `dsh-app://app`) origin, no cross-site requests.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const name = "restart-button";

/** Only the HTTP carrier is needed. */
export const inject = ["webServer"];

const ROUTE_PREFIX = "/restart-button";
const SHELL_APP_ORIGIN = "dsh-app://app";
const LOG_PATH = join(tmpdir(), "dsh-restart-button.log");
/** Grace period before the helper closes the app, so the HTTP answer can reach the page. */
const HELPER_DELAY_MS = 1500;

const POWERSHELL =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

/* ------------------------------------------------------------------ HTTP helpers */

function headerValue(headers, key) {
  const value = headers?.[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function parseAuthority(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const url = new URL(`http://${value.trim()}`);
    return { hostname: url.hostname.toLowerCase(), host: url.host.toLowerCase() };
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/** Loopback Host + same-origin (or the desktop shell origin) + not cross-site. */
function isTrustedRequest(request) {
  const authority = parseAuthority(headerValue(request.headers, "host"));
  if (authority === undefined) return false;
  if (!isLoopbackHostname(authority.hostname)) return false;
  if (headerValue(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = headerValue(request.headers, "origin");
  if (origin === undefined || origin === SHELL_APP_ORIGIN) return true;
  try {
    return new URL(origin).hostname.toLowerCase() === authority.hostname;
  } catch {
    return false;
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

/* ------------------------------------------------------------------ capability */

/**
 * A real restart needs three things: Windows (the helper is PowerShell), an Electron
 * runtime, and a supervising parent process to close and relaunch — i.e. the desktop app.
 * A plain `dsh web` host fails the third test and reports `available: false`.
 */
function capabilities() {
  const exe = process.execPath;
  const windows = process.platform === "win32";
  const electron = typeof process.versions.electron === "string";
  const supervised = typeof process.send === "function";
  let reason;
  if (!windows) reason = "platform";
  else if (!electron) reason = "not-electron";
  else if (!supervised) reason = "not-supervised";
  return {
    available: windows && electron && supervised,
    reason,
    platform: process.platform,
    exe,
    appName: basename(exe),
    workdir: dirname(exe),
    mainPid: process.ppid,
    hostPid: process.pid,
    electronVersion: process.versions.electron,
    logPath: LOG_PATH
  };
}

/* ------------------------------------------------------------------ helper script */

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteWin(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/**
 * PowerShell helper: wait a moment (let the HTTP answer flush), close every process of
 * this application, wait until it is really gone, then start it again with the same
 * command line it had before — the same thing Electron's `app.relaunch()` does.
 *
 * Exported for the self-test (`tools/helper-script.mjs`), which generates the script with
 * `dryRun` and executes it without touching the running application.
 */
export function helperScript(caps, options = {}) {
  const dryRun = options.dryRun === true;
  const lines = [
    "# dsh-restart-button helper — closes the DSH desktop app and starts it again.",
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$MainPid = ${caps.mainPid}`,
    `$Exe = ${psQuote(caps.exe)}`,
    `$AppName = ${psQuote(caps.appName)}`,
    `$WorkDir = ${psQuote(caps.workdir)}`,
    `$LogPath = ${psQuote(LOG_PATH)}`,
    `$DryRun = ${dryRun ? "$true" : "$false"}`,
    "",
    "function Write-Log([string]$Text) {",
    "  try { Add-Content -LiteralPath $LogPath -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Text) -Encoding UTF8 } catch { }",
    "}",
    "",
    "function Get-AppProcesses {",
    "  $found = @()",
    "  try {",
    "    $found = @(Get-CimInstance Win32_Process -Filter (\"Name='\" + $AppName + \"'\") |",
    "      Where-Object { $_.ExecutablePath -eq $Exe } | Select-Object -ExpandProperty ProcessId)",
    "  } catch { }",
    "  return $found",
    "}",
    "",
    "Write-Log ('helper started pid=' + $PID + ' target=' + $MainPid)",
    `Start-Sleep -Milliseconds ${HELPER_DELAY_MS}`,
    "",
    "$commandLine = ''",
    "try { $commandLine = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $MainPid)).CommandLine } catch { }",
    "Write-Log ('main command line: ' + $commandLine)",
    "",
    "$targets = @(Get-AppProcesses)",
    "if ($targets.Count -eq 0) { $targets = @($MainPid) }",
    "Write-Log ('targets: ' + ($targets -join ', '))",
    "if ($DryRun) {",
    "  Write-Log 'dry run: the application is left running'",
    "} else {",
    "  foreach ($target in $targets) {",
    "    try { Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $target)) -MethodName Terminate | Out-Null } catch { }",
    "    try { & taskkill.exe /PID $target /T /F 2>$null | Out-Null } catch { }",
    "  }",
    "  $deadline = (Get-Date).AddSeconds(30)",
    "  while ((Get-Date) -lt $deadline) {",
    "    if (@(Get-AppProcesses).Count -eq 0) { break }",
    "    Start-Sleep -Milliseconds 300",
    "  }",
    "  $left = @(Get-AppProcesses)",
    "  if ($left.Count -gt 0) {",
    "    Write-Log ('still running, killing by image name: ' + ($left -join ', '))",
    "    try { & taskkill.exe /IM $AppName /F 2>$null | Out-Null } catch { }",
    "    Start-Sleep -Milliseconds 800",
    "  }",
    "  Start-Sleep -Milliseconds 1200",
    "}",
    "",
    "$appArgs = ''",
    "if ($commandLine -ne '') {",
    "  $trimmed = $commandLine.Trim()",
    "  if ($trimmed.StartsWith('\"')) {",
    "    $end = $trimmed.IndexOf('\"', 1)",
    "    if ($end -gt 0) { $appArgs = $trimmed.Substring($end + 1).Trim() }",
    "  } else {",
    "    $end = $trimmed.IndexOf(' ')",
    "    if ($end -gt 0) { $appArgs = $trimmed.Substring($end + 1).Trim() }",
    "  }",
    "}",
    "",
    "if ($DryRun) {",
    "  Write-Log ('dry run: would start: ' + $Exe + ' ' + $appArgs)",
    "} else {",
    "  Write-Log ('starting: ' + $Exe + ' ' + $appArgs)",
    "  try {",
    "    if ($appArgs -ne '') { Start-Process -FilePath $Exe -WorkingDirectory $WorkDir -ArgumentList $appArgs } else { Start-Process -FilePath $Exe -WorkingDirectory $WorkDir }",
    "    Write-Log 'started'",
    "  } catch { Write-Log ('start failed: ' + $_.Exception.Message) }",
    "}",
    ""
  ];
  return lines.join("\r\n");
}

/* ------------------------------------------------------------------ launchers */

function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(POWERSHELL, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: "", error: String(error?.message ?? error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, stdout, stderr, error: "timeout" }), timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish({ ok: false, stdout, stderr, error: String(error?.message ?? error) }));
    child.on("close", (code) => finish({ ok: code === 0 && stdout.includes("ok"), stdout, stderr, code }));
  });
}

/** Preferred: let the WMI service own the helper process (outside our process tree). */
function launchViaWmi(commandLine) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)} }`,
    "if ($null -eq $result -or $result.ReturnValue -ne 0) { throw ('Win32_Process.Create returned ' + $result.ReturnValue) }",
    "'ok'"
  ].join("; ");
  return runPowerShell(["-NoProfile", "-NonInteractive", "-Command", script], 20000);
}

function launchDetached(args) {
  const child = spawn(POWERSHELL, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

/* ------------------------------------------------------------------ route */

async function scheduleRestart(caps) {
  const dryRun = process.env.DSH_RESTART_BUTTON_DRY_RUN === "1";
  const scriptPath = join(tmpdir(), `dsh-restart-button-${Date.now().toString(36)}.ps1`);
  writeFileSync(scriptPath, helperScript(caps, { dryRun }), "utf8");
  const helperArgs = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    scriptPath
  ];
  const wmi = await launchViaWmi([POWERSHELL, ...helperArgs].map(quoteWin).join(" "));
  if (wmi.ok) {
    return { ok: true, via: "wmi", dryRun, delayMs: HELPER_DELAY_MS, scriptPath, logPath: LOG_PATH };
  }
  launchDetached(helperArgs);
  return {
    ok: true,
    via: "detached",
    dryRun,
    delayMs: HELPER_DELAY_MS,
    scriptPath,
    logPath: LOG_PATH,
    wmiError: String(wmi.stderr || wmi.error || "").slice(0, 400)
  };
}

export function apply(ctx) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[restart-button] ${message}`);
    } catch {
      /* logging must never break the route */
    }
  };

  const dispose = ctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!isTrustedRequest(request)) {
        sendJson(response, 403, { ok: false, error: "forbidden" });
        return;
      }
      let pathname = "/";
      try {
        pathname = new URL(request.url ?? "/", "http://dsh.internal").pathname;
      } catch {
        /* keep the default */
      }
      if (pathname === `${ROUTE_PREFIX}/status`) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          sendJson(response, 405, { ok: false, error: "method" });
          return;
        }
        sendJson(response, 200, { ok: true, ...capabilities() });
        return;
      }
      if (pathname === `${ROUTE_PREFIX}/restart`) {
        if (request.method !== "POST") {
          sendJson(response, 405, { ok: false, error: "method" });
          return;
        }
        const caps = capabilities();
        if (!caps.available) {
          sendJson(response, 409, { ok: false, error: "unavailable", reason: caps.reason });
          return;
        }
        const outcome = await scheduleRestart(caps);
        log(`restart scheduled via ${outcome.via} (main pid ${caps.mainPid}, exe ${caps.exe})`);
        sendJson(response, outcome.ok ? 200 : 500, outcome);
        return;
      }
      sendJson(response, 404, { ok: false, error: "not-found" });
    }
  });

  ctx.effect(() => dispose, "restart-button: http route");
}
