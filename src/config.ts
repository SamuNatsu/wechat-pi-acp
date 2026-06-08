import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AppConfig } from "./types.js";
import { VERSION } from "./version.js";

/** Config directory: ~/.wechat-pi-acp/ */
const CONFIG_DIR = path.join(os.homedir(), ".wechat-pi-acp");
/** Main config file: ~/.wechat-pi-acp/config.json */
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

/** Fallback values merged under any user-specified config. */
const DEFAULTS: AppConfig = {
  token: "",
  ilinkBotId: "",
  ilinkUserId: "",
  baseUrl: "https://ilinkai.weixin.qq.com",
  cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
  acpCommand: "npx pi-acp",
  idleTimeoutMs: 600_000,
  mediaTempDir: path.join(os.tmpdir(), "wechat-pi-acp"),
  fileTtlMs: 3_600_000,
  maxFileSize: 104_857_600,
  botAgent: `WeChat-Pi-ACP/${VERSION}`,
};

/** Return the absolute path to config.json. */
export function resolveConfigPath(): string {
  return CONFIG_PATH;
}

/** Return the config directory path. */
export function resolveConfigDir(): string {
  return CONFIG_DIR;
}

/** Return the path to sessions.json (per-user session persistence). */
export function resolveSessionsPath(): string {
  return path.join(CONFIG_DIR, "sessions.json");
}

/** Return the path to tokens.json (reserved for future use). */
export function resolveTokensPath(): string {
  return path.join(CONFIG_DIR, "tokens.json");
}

/**
 * Load the app config, merging user overrides onto DEFAULTS.
 * Creates the config directory if it doesn't exist.
 */
export function loadConfig(): AppConfig {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  } catch {}
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      return { ...DEFAULTS, ...parsed };
    }
  } catch {}
  return { ...DEFAULTS };
}

/**
 * Persist partial config updates merged with the existing config.
 * Restricts file permissions to owner-only (0o600).
 */
export function saveConfig(update: Partial<AppConfig>): AppConfig {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  } catch {}
  const current = loadConfig();
  const merged = { ...current, ...update };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {}
  return merged;
}

/**
 * Load the in-memory session store from disk.
 * Returns an empty object if the file is missing or unparseable.
 */
export function loadSessions(): Record<string, Record<string, unknown>> {
  const file = resolveSessionsPath();
  try {
    if (!fs.existsSync(file)) return {};
    return (JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, Record<string, unknown>>) || {};
  } catch {
    return {};
  }
}

/** Atomically write the in-memory session store to disk. */
export function saveSessions(sessions: Record<string, Record<string, unknown>>): void {
  const file = resolveSessionsPath();
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  } catch {}
  fs.writeFileSync(file, JSON.stringify(sessions, null, 2), "utf-8");
}
