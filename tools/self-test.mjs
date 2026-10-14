/**
 * Self-test for dsh-restart-button.
 *
 * Verifies the restart helper without touching the running application:
 *   1. generates the helper with dryRun = true and checks it contains no console tooling,
 *   2. starts it exactly the way the plugin does (WMI `Win32_Process.Create` → wscript.exe),
 *   3. reads the helper log and asserts it resolved the app processes and would relaunch,
 *   4. asserts the run created no console host — the whole point of the .vbs helper,
 *   5. exercises the WMI process-creation primitive the helper uses to relaunch the app.
 *
 * Usage:
 *   node tools/self-test.mjs <mainPid> "<C:\path\to\DeepSeek Harness.exe>"
 * Both are printed by `GET /restart-button/status` on the running plugin.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { helperVbs } from "../host.js";

const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const POWERSHELL = join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");
const WSCRIPT = join(SYSTEM32, "wscript.exe");
const LOG_PATH = join(tmpdir(), "dsh-restart-button.log");
const TOUCH_FILE = join(tmpdir(), "dsh-restart-button-wmi-create.txt");
/** WMI moniker kept as a raw string so the generated VBScript receives `\\.\root\cimv2` verbatim. */
const WMI_MONIKER = String.raw`winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2`;

function run(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(POWERSHELL, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout, stderr: `${stderr}\n[timeout]` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Hidden PowerShell that asks WMI to start a wscript-hosted .vbs outside our process tree. */
async function launchViaWmi(commandLine) {
  return run([
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)} }; if ($result.ReturnValue -ne 0) { throw ('Win32_Process.Create returned ' + $result.ReturnValue) } else { 'created ' + $result.ProcessId }`
  ]);
}

async function countConsoleHosts() {
  const result = await run([
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "(Get-Process conhost -ErrorAction SilentlyContinue | Measure-Object).Count"
  ]);
  return Number(result.stdout.trim());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const mainPid = Number(process.argv[2] ?? 0);
  const exe = process.argv[3] ?? "";
  if (!Number.isInteger(mainPid) || mainPid <= 0 || exe === "") {
    console.error('usage: node tools/self-test.mjs <mainPid> "<C:\\...\\DeepSeek Harness.exe>"');
    process.exit(2);
  }
  if (!existsSync(WSCRIPT)) {
    console.error(`missing ${WSCRIPT}`);
    process.exit(2);
  }

  const caps = { mainPid, exe, appName: basename(exe), workdir: dirname(exe) };
  const scriptPath = join(tmpdir(), `dsh-restart-button-selftest-${Date.now().toString(36)}.vbs`);
  const source = helperVbs(caps, { dryRun: true });
  writeFileSync(scriptPath, source, "utf8");
  console.log(`helper script: ${scriptPath}`);

  const forbidden = ["powershell", "Start-Process", "taskkill", "cmd.exe"];
  const found = forbidden.filter((needle) => source.toLowerCase().includes(needle.toLowerCase()));
  console.log(`1. helper is console-free: ${found.length === 0 ? "PASS" : `FAIL (contains ${found.join(", ")})`}`);

  if (existsSync(LOG_PATH)) rmSync(LOG_PATH, { force: true });
  const conhostBefore = await countConsoleHosts();

  const created = await launchViaWmi([WSCRIPT, "//B", "//Nologo", scriptPath].map((part) => (/[\s"]/.test(part) ? `"${part}"` : part)).join(" "));
  const launched = created.code === 0 && created.stdout.includes("created");
  console.log(`2. WMI launch of the helper: ${launched ? `PASS (${created.stdout.trim()})` : `FAIL\n${created.stdout}${created.stderr}`}`);

  await sleep(6000);
  const log = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8").trim() : "";
  console.log("3. helper log:");
  for (const line of log.split(/\r?\n/)) console.log(`   ${line}`);

  const started = log.includes("helper started (wscript)");
  const resolved = /targets: .*\d/.test(log);
  const dryRan = log.includes("dry run: the application is left running") && log.includes("dry run: would start:");
  console.log(`4. helper started:                ${started ? "PASS" : "FAIL"}`);
  console.log(`5. resolved app processes:        ${resolved ? "PASS" : "FAIL"}`);
  console.log(`6. dry run reached relaunch:      ${dryRan ? "PASS" : "FAIL"}`);

  const conhostAfter = await countConsoleHosts();
  console.log(`7. no console host created:       ${conhostAfter === conhostBefore ? `PASS (${conhostBefore} → ${conhostAfter})` : `FAIL (${conhostBefore} → ${conhostAfter})`}`);

  /* Exercise the helper's own relaunch primitive: the LaunchApp function is lifted out of the
     generated helper and run for real (starting a second wscript that drops a file), so this
     checks the code that ships rather than a hand-written copy of it. */
  const touchScript = join(tmpdir(), "dsh-restart-button-selftest-touch.vbs");
  const createScript = join(tmpdir(), "dsh-restart-button-selftest-create.vbs");
  const createLog = join(tmpdir(), "dsh-restart-button-selftest-create.log");
  const launchApp = /Function LaunchApp\(Args\)[\s\S]*?End Function/.exec(source)?.[0] ?? "";
  const vbs = (value) => `"${String(value).replace(/"/g, '""')}"`;
  if (launchApp === "") console.log("   note: no LaunchApp function in the generated helper");
  rmSync(TOUCH_FILE, { force: true });
  rmSync(createLog, { force: true });
  writeFileSync(
    touchScript,
    [
      "Dim fso, f",
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `Set f = fso.CreateTextFile(${vbs(TOUCH_FILE)}, True)`,
      'f.WriteLine "wmi-create-ok"',
      "f.Close",
      ""
    ].join("\r\n"),
    "utf8"
  );
  writeFileSync(
    createScript,
    [
      "On Error Resume Next",
      "Dim Fso, Wmi, ExePath, WorkDir, LogPath, created, handle",
      'Set Fso = CreateObject("Scripting.FileSystemObject")',
      `Set Wmi = GetObject(${vbs(WMI_MONIKER)})`,
      `LogPath = ${vbs(createLog)}`,
      `ExePath = ${vbs(WSCRIPT)}`,
      `WorkDir = ${vbs(tmpdir())}`,
      launchApp,
      `created = LaunchApp(${vbs(`//B //Nologo "${touchScript}"`)})`,
      "Set handle = Fso.OpenTextFile(LogPath, 8, True)",
      'handle.WriteLine "launchapp returned " & created',
      "handle.Close",
      ""
    ].join("\r\n"),
    "utf8"
  );
  await launchViaWmi([WSCRIPT, "//B", "//Nologo", createScript].map((part) => (/[\s"]/.test(part) ? `"${part}"` : part)).join(" "));
  await sleep(3000);
  const createLogText = existsSync(createLog) ? readFileSync(createLog, "utf8").trim() : "";
  const launchedPid = /launchapp returned (\d+)/.exec(createLogText);
  const touched = existsSync(TOUCH_FILE) && readFileSync(TOUCH_FILE, "utf8").includes("wmi-create-ok");
  console.log(`8. helper LaunchApp via WMI:      ${touched && launchedPid !== null ? `PASS (${createLogText})` : `FAIL (${createLogText || "no log"})`}`);

  const ok =
    found.length === 0 && launched && started && resolved && dryRan && conhostAfter === conhostBefore && touched && launchedPid !== null;
  console.log(ok ? "\nALL CHECKS PASSED (the running app was not touched)" : "\nCHECKS FAILED");
  process.exit(ok ? 0 : 1);
}

await main();
