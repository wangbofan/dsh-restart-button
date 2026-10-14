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
 *   POST /restart-button/restart  → schedules a detached helper that terminates every
 *                                   process of this application (main + Host + renderers)
 *                                   and relaunches the exe with the same command line.
 *
 * Helper design, and why it is a `.vbs` run by `wscript.exe`:
 *
 *   1. It must outlive the process tree it kills, so it is created through WMI
 *      (`Win32_Process.Create`): the helper belongs to WmiPrvSE, not to this application,
 *      which is also why a plain detached child is *not* used as the primary path.
 *   2. It must not put anything on screen. A PowerShell helper is a console program: even
 *      with `-WindowStyle Hidden`, Windows Terminal (the default console host on Windows 11)
 *      opens a visible tab for it, and anything the relaunched app writes to stdout — the
 *      `dsh web:` banner and plugin logs — lands in that window. `wscript.exe` is a
 *      GUI-subsystem host, so no console is ever created.
 *   3. It must not spawn console tools either: `taskkill`, `Start-Process` and friends each
 *      allocate their own console. Every process operation below therefore goes through WMI
 *      (`Win32_Process.Terminate` / `Win32_Process.Create`).
 *
 * The route is fenced the same way the shipped plugins fence theirs: loopback Host,
 * same-origin (or `dsh-app://app`) origin, no cross-site requests.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
/** How long to wait for the helper's first log line before reporting a failed restart. */
const HELPER_START_TIMEOUT_MS = 2000;

const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
/** The helper itself: GUI-subsystem, never allocates a console. */
const WSCRIPT = join(SYSTEM32, "wscript.exe");
/** Only used to ask the WMI service to create the helper — spawned hidden. */
const POWERSHELL = join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");

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
 * A real restart needs four things: Windows, an Electron runtime, a supervising parent
 * process to close and relaunch — i.e. the desktop app — and a usable Windows Script Host
 * for the helper. A plain `dsh web` host fails the third test and reports `available: false`.
 */
function capabilities() {
  const exe = process.execPath;
  const windows = process.platform === "win32";
  const electron = typeof process.versions.electron === "string";
  const supervised = typeof process.send === "function";
  const wsh = windows && existsSync(WSCRIPT);
  let reason;
  if (!windows) reason = "platform";
  else if (!electron) reason = "not-electron";
  else if (!supervised) reason = "not-supervised";
  else if (!wsh) reason = "no-wscript";
  return {
    available: windows && electron && supervised && wsh,
    reason,
    platform: process.platform,
    exe,
    appName: basename(exe),
    workdir: dirname(exe),
    mainPid: process.ppid,
    hostPid: process.pid,
    electronVersion: process.versions.electron,
    helper: "wscript+vbs",
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

/** VBScript string literal: `"` is doubled. */
function vbsString(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * VBScript helper: wait a moment (let the HTTP answer flush), close every process of this
 * application, wait until it is really gone, then start it again with the same command line
 * it had before — the same thing Electron's `app.relaunch()` does, minus the console window.
 *
 * Exported so the self-test (`tools/self-test.mjs`) can generate it with `dryRun` and run it
 * without touching the running application.
 */
export function helperVbs(caps, options = {}) {
  const dryRun = options.dryRun === true;
  const delayMs = Number.isInteger(options.delayMs) ? options.delayMs : HELPER_DELAY_MS;
  return [
    "' dsh-restart-button helper - closes the DSH desktop app and starts it again.",
    "' Hosted by wscript.exe (GUI subsystem: no console window is ever created) and every",
    "' process operation goes through WMI, so no console tool is launched either.",
    "On Error Resume Next",
    "Dim Fso, Wmi, LogPath, MainPid, ExePath, AppName, WorkDir, DryRun, DelayMs",
    `LogPath = ${vbsString(LOG_PATH)}`,
    `MainPid = ${Number(caps.mainPid) || 0}`,
    `ExePath = ${vbsString(caps.exe)}`,
    `AppName = ${vbsString(caps.appName)}`,
    `WorkDir = ${vbsString(caps.workdir)}`,
    `DryRun = ${dryRun ? "True" : "False"}`,
    `DelayMs = ${delayMs}`,
    'Set Fso = CreateObject("Scripting.FileSystemObject")',
    'Set Wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2")',
    "",
    "Sub WriteLog(Text)",
    "  Dim f",
    "  On Error Resume Next",
    "  Set f = Fso.OpenTextFile(LogPath, 8, True)",
    "  If Err.Number = 0 Then",
    '    f.WriteLine "[" & Stamp() & "] " & Text',
    "    f.Close",
    "  End If",
    "  Err.Clear",
    "End Sub",
    "",
    "Function Pad2(Value)",
    '  If Len(CStr(Value)) < 2 Then Pad2 = "0" & CStr(Value) Else Pad2 = CStr(Value)',
    "End Function",
    "",
    "Function Stamp()",
    "  Dim d",
    "  d = Now",
    '  Stamp = CStr(Year(d)) & "-" & Pad2(Month(d)) & "-" & Pad2(Day(d)) & " " & Pad2(Hour(d)) & ":" & Pad2(Minute(d)) & ":" & Pad2(Second(d))',
    "End Function",
    "",
    "' Every process of this application: same image name and same executable path.",
    "Function AppPids()",
    "  Dim q, p, list",
    '  list = ""',
    '  On Error Resume Next',
    "  Set q = Wmi.ExecQuery(\"SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name='\" & AppName & \"'\")",
    "  For Each p In q",
    "    If IsNull(p.ExecutablePath) Then",
    '      list = list & p.ProcessId & ","',
    "    ElseIf LCase(p.ExecutablePath) = LCase(ExePath) Then",
    '      list = list & p.ProcessId & ","',
    "    End If",
    "  Next",
    "  Err.Clear",
    '  If Len(list) > 0 Then list = Left(list, Len(list) - 1)',
    "  AppPids = list",
    "End Function",
    "",
    "' WMI termination: no console kill utility is involved, so no console appears.",
    "Sub TerminatePid(Text)",
    "  Dim p",
    "  On Error Resume Next",
    "  Set p = Wmi.Get(\"Win32_Process.Handle='\" & Text & \"'\")",
    "  If Not p Is Nothing Then p.Terminate()",
    "  Err.Clear",
    "End Sub",
    "",
    "Function MainCommandLine()",
    "  Dim p",
    '  MainCommandLine = ""',
    "  On Error Resume Next",
    "  Set p = Wmi.Get(\"Win32_Process.Handle='\" & MainPid & \"'\")",
    "  If Not p Is Nothing And Not IsNull(p.CommandLine) Then MainCommandLine = p.CommandLine",
    "  Err.Clear",
    "End Function",
    "",
    "' Everything after the executable path of the original command line.",
    "Function ExtraArgs(CommandLine)",
    "  Dim t, idx",
    '  ExtraArgs = ""',
    "  t = Trim(CommandLine)",
    '  If t = "" Then Exit Function',
    '  If Left(t, 1) = """" Then',
    '    idx = InStr(2, t, """")',
    "    If idx > 0 Then ExtraArgs = Trim(Mid(t, idx + 1))",
    "  Else",
    '    idx = InStr(t, " ")',
    "    If idx > 0 Then ExtraArgs = Trim(Mid(t, idx + 1))",
    "  End If",
    "End Function",
    "",
    "' WMI process creation: a GUI process, no console, no inherited stdout.",
    "Function LaunchApp(Args)",
    "  Dim cls, method, inParams, outParams, cmd",
    "  LaunchApp = 0",
    "  On Error Resume Next",
    '  cmd = """" & ExePath & """"',
    '  If Args <> "" Then cmd = cmd & " " & Args',
    '  Set cls = Wmi.Get("Win32_Process")',
    '  Set method = cls.Methods_("Create")',
    "  Set inParams = method.InParameters.SpawnInstance_()",
    "  inParams.CommandLine = cmd",
    "  inParams.CurrentDirectory = WorkDir",
    '  Set outParams = cls.ExecMethod_("Create", inParams)',
    "  If Err.Number <> 0 Then",
    "    Err.Clear",
    '    Set outParams = Wmi.ExecMethod("Win32_Process", "Create", inParams)',
    "  End If",
    "  If Err.Number <> 0 Or outParams Is Nothing Then",
    "    LaunchApp = -1",
    "  ElseIf outParams.ReturnValue <> 0 Then",
    "    LaunchApp = -outParams.ReturnValue",
    "  Else",
    "    LaunchApp = CLng(outParams.ProcessId)",
    "  End If",
    "  Err.Clear",
    "End Function",
    "",
    "Dim commandLine, args, targets, left, parts, i, waited, created, rounds",
    'WriteLog "helper started (wscript) target=" & MainPid',
    "WScript.Sleep DelayMs",
    "commandLine = MainCommandLine()",
    'WriteLog "main command line: " & commandLine',
    "args = ExtraArgs(commandLine)",
    "targets = AppPids()",
    'If targets = "" Then targets = CStr(MainPid)',
    'WriteLog "targets: " & targets',
    "If DryRun Then",
    '  WriteLog "dry run: the application is left running"',
    '  WriteLog "dry run: would start: " & ExePath & " " & args',
    "Else",
    '  parts = Split(targets, ",")',
    "  For i = 0 To UBound(parts)",
    '    If Trim(parts(i)) <> "" Then TerminatePid Trim(parts(i))',
    "  Next",
    "  waited = 0",
    "  rounds = 0",
    "  left = AppPids()",
    '  Do While left <> "" And waited < 30000',
    "    WScript.Sleep 300",
    "    waited = waited + 300",
    "    If waited Mod 3000 = 0 And rounds < 8 Then",
    "      rounds = rounds + 1",
    '      parts = Split(left, ",")',
    "      For i = 0 To UBound(parts)",
    '        If Trim(parts(i)) <> "" Then TerminatePid Trim(parts(i))',
    "      Next",
    "    End If",
    "    left = AppPids()",
    "  Loop",
    '  If left <> "" Then WriteLog "still running after " & waited & " ms: " & left',
    "  WScript.Sleep 1200",
    '  WriteLog "starting: " & ExePath & " " & args',
    "  created = LaunchApp(args)",
    "  If created > 0 Then",
    '    WriteLog "started pid=" & created',
    "  Else",
    '    WriteLog "start failed (Win32_Process.Create returned " & created & ")"',
    "  End If",
    "End If",
    ""
  ].join("\r\n");
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

/**
 * Let the WMI service own the helper process (outside our process tree). This launcher is a
 * hidden PowerShell (`windowsHide` → CREATE_NO_WINDOW), so it stays invisible as well.
 */
function launchViaWmi(commandLine) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)} }`,
    "if ($null -eq $result -or $result.ReturnValue -ne 0) { throw ('Win32_Process.Create returned ' + $result.ReturnValue) }",
    "'ok'"
  ].join("; ");
  return runPowerShell(["-NoProfile", "-NonInteractive", "-Command", script], 20000);
}

/* ------------------------------------------------------------------ route */

function helperStartCount() {
  try {
    return (readFileSync(LOG_PATH, "utf8").match(/helper started/g) ?? []).length;
  } catch {
    return 0;
  }
}

async function waitForHelperStart(before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (helperStartCount() > before) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/**
 * @param caps - Facts about this process and its application.
 * @param options - `dryRun` skips the actual close/relaunch; also enabled by
 *   `DSH_RESTART_BUTTON_DRY_RUN=1` or by `?dryRun=1` on the request (a fenced loopback call),
 *   which is how the HTTP path itself can be exercised without losing the session.
 */
async function scheduleRestart(caps, options = {}) {
  const dryRun = options.dryRun === true || process.env.DSH_RESTART_BUTTON_DRY_RUN === "1";
  const scriptPath = join(tmpdir(), `dsh-restart-button-${Date.now().toString(36)}.vbs`);
  writeFileSync(scriptPath, helperVbs(caps, { dryRun }), "utf8");

  const before = helperStartCount();
  const commandLine = [WSCRIPT, "//B", "//Nologo", scriptPath].map(quoteWin).join(" ");
  const wmi = await launchViaWmi(commandLine);
  if (!wmi.ok) {
    return {
      ok: false,
      via: "wmi",
      dryRun,
      error: "helper-launch-failed",
      detail: String(wmi.stderr || wmi.error || "").trim().slice(0, 400),
      scriptPath,
      logPath: LOG_PATH
    };
  }
  const started = await waitForHelperStart(before, HELPER_START_TIMEOUT_MS);
  if (!started) {
    return {
      ok: false,
      via: "wmi",
      dryRun,
      error: "helper-did-not-start",
      detail: `no helper log line within ${HELPER_START_TIMEOUT_MS} ms (script ${scriptPath})`,
      scriptPath,
      logPath: LOG_PATH
    };
  }
  return {
    ok: true,
    via: "wmi+wscript",
    dryRun,
    delayMs: HELPER_DELAY_MS,
    scriptPath,
    logPath: LOG_PATH
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
        const outcome = await scheduleRestart(caps, {
          dryRun: /(?:^|[?&])dryRun=1(?:&|$)/.test(String(request.url ?? ""))
        });
        log(
          outcome.ok
            ? `restart scheduled via ${outcome.via} (main pid ${caps.mainPid}, exe ${caps.exe})`
            : `restart scheduling failed: ${outcome.error} ${outcome.detail ?? ""}`
        );
        sendJson(response, outcome.ok ? 200 : 500, outcome);
        return;
      }
      sendJson(response, 404, { ok: false, error: "not-found" });
    }
  });

  ctx.effect(() => dispose, "restart-button: http route");
}
