/**
 * WeChat HTTP API client — low-level fetch wrappers for the ilink bot API.
 *
 * All requests go through apiPost() / apiGet() which attach the required
 * auth headers, build the base URL, and handle timeouts via AbortController.
 *
 * Reference: WEIXIN-API.md in the repo root.
 */

import type {
  GetConfigResponse,
  GetUpdatesResponse,
  NotifyResponse,
  QrCodeResponse,
  QrStatusResponse,
  SendResult,
  UploadUrlParams,
  UploadUrlResponse,
  WechatMessageItem,
} from "../types.js";
import type { AppConfig } from "../types.js";
import { VERSION } from "../version.js";
import { loadConfig } from "../config.js";
import { randomWechatUin } from "../media/crypto.js";

/** The fixed login host — QR code and status polling always hit this origin. */
const FIXED_LOGIN_BASE = "https://ilinkai.weixin.qq.com";

/** WeChat iLink client version parts. */
const CLIENT_MAJOR = 2;
const CLIENT_MINOR = 4;
const CLIENT_PATCH = 4;

/** Encoded client version packed into a 32-bit integer for the iLink-App-ClientVersion header. */
const CLIENT_VERSION = ((CLIENT_MAJOR & 0xff) << 16) | ((CLIENT_MINOR & 0xff) << 8) | (CLIENT_PATCH & 0xff);
/** Client version string for the channel_version base-info field. */
const CHANNEL_VERSION = `${CLIENT_MAJOR}.${CLIENT_MINOR}.${CLIENT_PATCH}`;

/** Default timeout for long-poll getUpdates (msec). */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for message-send and upload operations (msec). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for config and typing operations (msec). */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

/** Common headers sent on every request (iLink App identity). */
function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
  };
}

/** Auth headers for authenticated requests — includes the Bearer token. */
function buildAuthHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
}

/** Base info object attached to most request bodies. */
function buildBaseInfo(): Record<string, string> {
  const config: AppConfig = loadConfig();
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: config.botAgent || `WeChat-Pi-ACP/${VERSION}`,
  };
}

/**
 * Generic authenticated POST to the WeChat API.
 * Returns the raw response body string. Throws on non-2xx or when the external signal aborts.
 */
export async function apiPost(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string | null,
  timeoutMs?: number,
  abortSignal?: AbortSignal,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  const headers = token ? buildAuthHeaders(token) : { ...buildCommonHeaders(), "Content-Type": "application/json" };
  const timeoutController = timeoutMs ? new AbortController() : undefined;
  const t = timeoutController && timeoutMs ? setTimeout(() => timeoutController.abort(), timeoutMs) : undefined;
  const combinedSignal = timeoutController
    ? abortSignal
      ? AbortSignal.any([timeoutController.signal, abortSignal])
      : timeoutController.signal
    : abortSignal;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } finally {
    if (t) clearTimeout(t);
  }
}

/**
 * Generic unauthenticated GET to the WeChat API.
 * Returns the raw response body string. Throws on non-2xx or when the external signal aborts.
 */
export async function apiGet(
  baseUrl: string,
  endpoint: string,
  timeoutMs?: number,
  abortSignal?: AbortSignal,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  const headers = buildCommonHeaders();
  const timeoutController = timeoutMs ? new AbortController() : undefined;
  const t = timeoutController && timeoutMs ? setTimeout(() => timeoutController.abort(), timeoutMs) : undefined;
  const combinedSignal = timeoutController
    ? abortSignal
      ? AbortSignal.any([timeoutController.signal, abortSignal])
      : timeoutController.signal
    : abortSignal;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: combinedSignal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Fetch a new QR code for login. Always hits the fixed login base URL. */
export async function fetchQRCode(baseUrl: string, botType: string): Promise<QrCodeResponse> {
  const raw = await apiPost(FIXED_LOGIN_BASE, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {
    local_token_list: [],
  });
  return JSON.parse(raw) as QrCodeResponse;
}

/** Poll the QR code status until the user scans/confirms or it expires. */
export async function pollQRStatus(baseUrl: string, qrcode: string, verifyCode?: string): Promise<QrStatusResponse> {
  let ep = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) ep += `&verify_code=${encodeURIComponent(verifyCode)}`;
  const raw = await apiGet(baseUrl, ep, DEFAULT_LONG_POLL_TIMEOUT_MS);
  return JSON.parse(raw) as QrStatusResponse;
}

/**
 * Long-poll for inbound WeChat messages.
 * Passes the opaque get_updates_buf cursor and the AbortSignal for graceful shutdown.
 */
export async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
  abortSignal?: AbortSignal,
  timeoutMs?: number,
): Promise<GetUpdatesResponse> {
  const t = timeoutMs || DEFAULT_LONG_POLL_TIMEOUT_MS;
  const raw = await apiPost(
    baseUrl,
    "ilink/bot/getupdates",
    {
      get_updates_buf: getUpdatesBuf || "",
      base_info: buildBaseInfo(),
    },
    token,
    t,
    abortSignal,
  );
  return JSON.parse(raw) as GetUpdatesResponse;
}

/** Send a WeChat message (text or media items) to a user. Returns clientId and runId. */
export async function sendMessage(
  baseUrl: string,
  token: string,
  toUserId: string,
  itemList: WechatMessageItem[],
  contextToken?: string,
): Promise<SendResult> {
  const clientId = `wechat-pi-acp:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const runId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 18)}`;
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: itemList,
      context_token: contextToken || undefined,
      run_id: runId,
    },
    base_info: buildBaseInfo(),
  };
  const raw = await apiPost(baseUrl, "ilink/bot/sendmessage", body, token, DEFAULT_API_TIMEOUT_MS);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.ret !== undefined && parsed.ret !== 0) {
      throw new Error(`sendMessage API error: resp=${raw}`);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      // non-JSON response body — assume success if HTTP was 2xx
    } else {
      throw err;
    }
  }
  return { clientId, runId };
}

/** Fetch a typing ticket and other config for the given user. */
export async function getConfig(
  baseUrl: string,
  token: string,
  ilinkUserId: string,
  contextToken?: string,
): Promise<GetConfigResponse> {
  const raw = await apiPost(
    baseUrl,
    "ilink/bot/getconfig",
    {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    },
    token,
    DEFAULT_CONFIG_TIMEOUT_MS,
  );
  return JSON.parse(raw) as GetConfigResponse;
}

/** Send a typing indicator (status 1 = typing, status 2 = stopped). */
export async function sendTyping(
  baseUrl: string,
  token: string,
  ilinkUserId: string,
  typingTicket: string,
  status: number,
): Promise<void> {
  await apiPost(
    baseUrl,
    "ilink/bot/sendtyping",
    {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
      base_info: buildBaseInfo(),
    },
    token,
    DEFAULT_CONFIG_TIMEOUT_MS,
  );
}

/** Request a CDN upload URL. Returns the URL and encrypted upload param. */
export async function getUploadUrl(
  baseUrl: string,
  token: string,
  params: UploadUrlParams,
): Promise<UploadUrlResponse> {
  const raw = await apiPost(
    baseUrl,
    "ilink/bot/getuploadurl",
    { ...params, base_info: buildBaseInfo() },
    token,
    DEFAULT_API_TIMEOUT_MS,
  );
  return JSON.parse(raw) as UploadUrlResponse;
}

/** Notify WeChat that the bridge is starting (allows the server to route messages). */
export async function notifyStart(baseUrl: string, token: string): Promise<NotifyResponse> {
  const raw = await apiPost(
    baseUrl,
    "ilink/bot/msg/notifystart",
    { base_info: buildBaseInfo() },
    token,
    DEFAULT_CONFIG_TIMEOUT_MS,
  );
  return JSON.parse(raw) as NotifyResponse;
}

/** Notify WeChat that the bridge is stopping. */
export async function notifyStop(baseUrl: string, token: string): Promise<NotifyResponse> {
  const raw = await apiPost(
    baseUrl,
    "ilink/bot/msg/notifystop",
    { base_info: buildBaseInfo() },
    token,
    DEFAULT_CONFIG_TIMEOUT_MS,
  );
  return JSON.parse(raw) as NotifyResponse;
}

export const FIXED_BASE_URL: string = FIXED_LOGIN_BASE;
export const DEFAULT_BOT_TYPE: string = "3";
export const LONG_POLL_TIMEOUT: number = DEFAULT_LONG_POLL_TIMEOUT_MS;
export const API_TIMEOUT: number = DEFAULT_API_TIMEOUT_MS;
