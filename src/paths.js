import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")

/**
 * Config + secrets live in a config dir (safe to back up, never commit).
 * Database + logs live in a data dir (rebuildable, avoid syncing).
 */
export const HOME = process.env.EMAIL_AGENT_HOME || join(xdgConfig, "opencode", "email-agent")
export const DATA = process.env.EMAIL_AGENT_DATA || join(xdgData, "opencode", "email-agent")

export const configFile = join(HOME, "config.json")
export const accountsFile = join(HOME, "accounts.json")
export const secretsFile = join(HOME, "secrets.json")
export const tokenFile = join(HOME, "token")
export const pidFile = join(DATA, "daemon.pid")
export const dbFile = join(DATA, "agent.db")
export const logFile = join(DATA, "daemon.log")

export const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR || join(xdgConfig, "opencode")
export const agentsDir = join(opencodeConfigDir, "agents")
export const skillsDir = join(opencodeConfigDir, "skills")
export const commandsDir = join(opencodeConfigDir, "commands")
export const pluginsDir = join(opencodeConfigDir, "plugins")

/** Repository root (works both from src/ and from an installed package). */
export const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/, "")
export const assetsDir = join(packageRoot, "assets")
