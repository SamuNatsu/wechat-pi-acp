/**
 * Centralized application state — replaces scattered module-level mutable variables.
 *
 * All state lives here. Modules import getters/setters instead of mutating
 * their own module-level variables. This makes state flow explicit and
 * enables future features like state persistence or hot-reload.
 */

import type { ActiveLogin } from "./types.js";
import type { ChildProcess } from "node:child_process";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { ComposeItem } from "./media/compose.js";
import type { createTextCollector } from "./agent/handler.js";

// ---- agent process ----

let _proc: ChildProcess | null = null;
let _conn: ClientSideConnection | null = null;
let _promptRejector: ((err: Error) => void) | null = null;

export function getProc(): ChildProcess | null {
  return _proc;
}

export function setProc(p: ChildProcess | null): void {
  _proc = p;
}

export function getConn(): ClientSideConnection | null {
  return _conn;
}

export function setConn(c: ClientSideConnection | null): void {
  _conn = c;
}

export function getPromptRejector(): ((err: Error) => void) | null {
  return _promptRejector;
}

export function setPromptRejector(r: ((err: Error) => void) | null): void {
  _promptRejector = r;
}

export function isAgentRunning(): boolean {
  return _proc !== null && !_proc.killed;
}

// ---- agent lifecycle ----

let _currentUserId: string | null = null;
let _currentCollector: ReturnType<typeof createTextCollector> | null = null;

export function getCurrentUserId(): string | null {
  return _currentUserId;
}

export function setCurrentUserId(id: string | null): void {
  _currentUserId = id;
}

export function getCurrentCollector(): ReturnType<typeof createTextCollector> | null {
  return _currentCollector;
}

export function setCurrentCollector(c: ReturnType<typeof createTextCollector> | null): void {
  _currentCollector = c;
}

// ---- sessions ----

let _sessions: Record<string, Record<string, unknown>> = {};

export function getSessions(): Record<string, Record<string, unknown>> {
  return _sessions;
}

export function setSessions(s: Record<string, Record<string, unknown>>): void {
  _sessions = s;
}

// ---- media upload mode ----

const _uploadModeUsers = new Set<string>();
const _uploadFiles = new Map<string, { name: string; size: number }[]>();

export function getUploadModeUsers(): Set<string> {
  return _uploadModeUsers;
}

export function getUploadFiles(): Map<string, { name: string; size: number }[]> {
  return _uploadFiles;
}

// ---- message compose mode ----

const _composeModeUsers = new Set<string>();
const _composeAccum = new Map<string, ComposeItem[]>();

export function getComposeModeUsers(): Set<string> {
  return _composeModeUsers;
}

export function getComposeAccum(): Map<string, ComposeItem[]> {
  return _composeAccum;
}

// ---- QR login ----

let _activeLogin: ActiveLogin | null = null;

export function getActiveLogin(): ActiveLogin | null {
  return _activeLogin;
}

export function setActiveLogin(l: ActiveLogin | null): void {
  _activeLogin = l;
}
