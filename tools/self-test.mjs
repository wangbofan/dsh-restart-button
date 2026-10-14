/**
 * Self-test for dsh-restart-button.
 *
 * Verifies the restart helper without touching the running application:
 *   1. generates the helper script with dryRun = true,
 *   2. asks the PowerShell parser to validate it,
 *   3. starts it exactly the way the plugin does (WMI `Win32_Process.Create`),
 *   4. reads the helper log and asserts it resolved the app processes and would relaunch.
 *
 * Usage:
 *   node tools/self-test.mjs [mainPid] ["C:\path\to\DeepSeek Harness.exe"]
 * Both arguments default to the desktop app process currently owning this session.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { helperScript } from "../host.js";

const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const LOG_PATH = join(tmpdir(), "dsh-restart-button.log");

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

async function main() {
  const mainPid = Number(process.argv[2] ?? 0);
  const exe = process.argv[3] ?? "";
  if (!Number.isInteger(mainPid) || mainPid <= 0 || exe === "") {
    console.error("usage: node tools/self-test.mjs <mainPid> <path to app exe>");
    process.exit(2);
  }

  const caps = { mainPid, exe, appName: basename(exe), workdir: dirname(exe) };
  const scriptPath = join(tmpdir(), `dsh-restart-button-selftest-${Date.now().toString(36)}.ps1`);
  writeFileSync(scriptPath, helperScript(caps, { dryRun: true }), "utf8");
  console.log(`helper script: ${scriptPath}`);

  const parse = await run([
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${psQuote(scriptPath)}, [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 } else { 'parse-ok' }`
  ]);
  const parsed = parse.stdout.includes("parse-ok");
  console.log(`1. PowerShell parse: ${parsed ? "PASS" : `FAIL\n${parse.stdout}${parse.stderr}`}`);

  if (existsSync(LOG_PATH)) rmSync(LOG_PATH, { force: true });

  const commandLine = [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath]
    .map((part) => (/[\s"]/.test(part) ? `"${part}"` : part))
    .join(" ");
  const created = await run([
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)} }; if ($result.ReturnValue -ne 0) { throw ('Win32_Process.Create returned ' + $result.ReturnValue) } else { 'created ' + $result.ProcessId }`
  ]);
  const launched = created.code === 0 && created.stdout.includes("created");
  console.log(`2. WMI launch:       ${launched ? `PASS (${created.stdout.trim()})` : `FAIL\n${created.stdout}${created.stderr}`}`);

  await new Promise((resolve) => setTimeout(resolve, 6000));
  const log = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8").trim() : "";
  console.log("3. helper log:");
  for (const line of log.split(/\r?\n/)) console.log(`   ${line}`);

  const resolved = /targets: .*\d/.test(log);
  const dryRan = log.includes("dry run: the application is left running") && log.includes("dry run: would start:");
  console.log(`4. resolved app processes: ${resolved ? "PASS" : "FAIL"}`);
  console.log(`5. dry run reached relaunch: ${dryRan ? "PASS" : "FAIL"}`);

  const ok = parsed && launched && resolved && dryRan;
  console.log(ok ? "\nALL CHECKS PASSED (the running app was not touched)" : "\nCHECKS FAILED");
  process.exit(ok ? 0 : 1);
}

await main();
