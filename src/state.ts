/**
 * Centralized application state for compose/upload mode and QR login.
 *
 * Only three modules import from here: compose.ts, inbox.ts, auth.ts.
 * Agent process state lives locally in agent/agent.ts.
 */

import type { ActiveLogin } from "./types.js";
import type { ComposeItem } from "./media/compose.js";

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
