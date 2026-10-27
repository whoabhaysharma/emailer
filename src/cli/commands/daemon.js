import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { daemonStatus, startDaemon, stopDaemon } from "../../daemon.js"
import { logFile, packageRoot, pidFile, tokenFile } from "../../paths.js"
import { printJson } from "../io.js"
import { withService } from "../context.js"

export async function daemonCommand(flags) {
  const result = await startDaemon({
    port: flags.port,
    once: flags.once === true,
    quiet: flags.quiet === true,
  })
  if (!result) return
  if (flags.once !== true) {
    console.log(`daemon running at ${result.address}`)
    await new Promise(() => {})
  }
}

const LAUNCHD_LABEL = "dev.opencode.email-agent"

function installLaunchd(node, cli) {
  const plist = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
  mkdirSync(dirname(plist), { recursive: true })
  mkdirSync(dirname(logFile), { recursive: true })
  stopDaemon()

  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${cli}</string>
    <string>daemon</string>
    <string>--quiet</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
`,
  )

  try {
    execFileSync("launchctl", ["unload", plist], { stdio: "ignore" })
  } catch {}
  execFileSync("launchctl", ["load", plist], { stdio: "inherit" })
  console.log(`installed launch agent: ${plist}`)
  return plist
}

function uninstallLaunchd() {
  const plist = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
  try {
    execFileSync("launchctl", ["unload", plist], { stdio: "ignore" })
  } catch {}
  stopDaemon()
  try {
    execFileSync("rm", ["-f", plist])
  } catch {}
  console.log("removed launch agent")
}

function installSystemd(node, cli) {
  const unitDir = join(homedir(), ".config", "systemd", "user")
  const unit = join(unitDir, "opencode-email-agent.service")
  mkdirSync(unitDir, { recursive: true })

  writeFileSync(
    unit,
    `[Unit]
Description=OpenCode email agent
After=network-online.target

[Service]
ExecStart=${node} ${cli} daemon --quiet
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`,
  )

  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" })
  execFileSync("systemctl", ["--user", "enable", "--now", "opencode-email-agent"], { stdio: "inherit" })
  console.log(`installed systemd unit: ${unit}`)
}

function uninstallSystemd() {
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", "opencode-email-agent"], { stdio: "inherit" })
  } catch {}
  const unit = join(homedir(), ".config", "systemd", "user", "opencode-email-agent.service")
  try {
    execFileSync("rm", ["-f", unit])
  } catch {}
  console.log("removed systemd unit")
}

export function serviceCommand(action) {
  const node = process.execPath
  const cli = join(packageRoot, "src", "cli.js")

  if (process.platform === "darwin") {
    if (action === "install") return installLaunchd(node, cli)
    if (action === "uninstall") return uninstallLaunchd()
    console.log(daemonStatus().running ? `running (pid ${daemonStatus().pid})` : "not running")
    console.log(`plist: ${join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)}`)
    return
  }

  if (process.platform === "linux") {
    if (action === "install") return installSystemd(node, cli)
    if (action === "uninstall") return uninstallSystemd()
    console.log(daemonStatus().running ? `running (pid ${daemonStatus().pid})` : "not running")
    return
  }

  console.log("service install is supported on macOS (launchd) and Linux (systemd). Use: opencode-email-agent daemon")
}

export async function statusCommand() {
  const status = daemonStatus()
  const health = await withService(async (instance) => instance.health()).catch(() => null)
  printJson({ ...status, health, token: existsSync(tokenFile), pidFile })
}
