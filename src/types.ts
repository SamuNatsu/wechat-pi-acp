/**
 * Application-level configuration stored in ~/.wechat-pi-acp/config.json.
 * Loaded at startup via loadConfig() and merged with defaults.
 */
export interface AppConfig {
  token: string;
  ilinkBotId: string;
  ilinkUserId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  acpCommand: string;
  /** Inactivity window (ms) after which the agent process is killed. */
  idleTimeoutMs: number;
  /** Root directory for temporary media downloads. */
  mediaTempDir: string;
  /** TTL (ms) for cached media files before periodic cleanup purges them. */
  fileTtlMs: number;
  /** Hard cap on a single file upload/download (bytes). */
  maxFileSize: number;
  botAgent: string;
}

/**
 * Per-user ACP session data persisted in ~/.wechat-pi-acp/sessions.json.
 * sessionId is the opaque handle the agent uses for loadSession/newSession.
 * contextToken is the latest WeChat context token for reply routing.
 */
export interface SessionData {
  sessionId?: string;
  contextToken?: string;
  lastActiveAt?: number;
}

/** WeChat CDN media metadata — encryption params and download URLs. */
export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
  encrypt_type?: number;
  aeskey?: string;
}

/** A single item (text, image, file, voice, video) inside a WeChat message. */
export interface WechatMessageItem {
  /** 1=text, 2=image, 3=voice, 4=file, 5=video */
  type: number;
  text_item?: { text: string };
  image_item?: { media?: CdnMedia; aeskey?: string; mid_size?: number };
  voice_item?: { media?: CdnMedia };
  file_item?: { media?: CdnMedia; file_name?: string; len?: string };
  video_item?: { media?: CdnMedia; video_size?: number };
}

/** Inbound WeChat message envelope — arrives via the getUpdates long-poll stream. */
export interface WechatMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WechatMessageItem[];
  /** Opaque reply-routing token, must be echoed in sendMessage replies. */
  context_token?: string;
  run_id?: string;
}

/** Response from the QR-code fetch endpoint. */
export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

/** Response from the QR-code status polling endpoint. */
export interface QrStatusResponse {
  status: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

/** Response from the getUpdates long-poll endpoint. */
export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  /** Server-suggested poll interval, used to set the next long-poll timeout. */
  longpolling_timeout_ms?: number;
  /** Opaque buffer — must be echoed in the next getUpdates call for cursor tracking. */
  get_updates_buf?: string;
  msgs?: WechatMessage[];
}

/** Response from the getConfig endpoint — provides the typing ticket. */
export interface GetConfigResponse {
  typing_ticket?: string;
}

/** Response from the getUploadUrl endpoint — CDN upload URL and param. */
export interface UploadUrlResponse {
  upload_full_url?: string;
  upload_param?: string;
}

/** Parsed media attachment ready for download. */
export interface MediaExtract {
  type: string;
  field: string;
  item: Record<string, unknown>;
  cdn: CdnMedia;
  aesKeyHex?: string;
  fileName?: string;
}

/** Result of a successful media download + decrypt. */
export interface DownloadResult {
  filePath: string;
  size: number;
}

/** Result of a successful media upload — the items to embed in a WeChat outbound message. */
export interface UploadResult {
  items: WechatMessageItem[];
  rawsize: number;
  filekey: string;
}

/** Events yielded by the streamMessages async generator. */
export type StreamEvent = { type: "session-expired" } | { type: "message"; msg: WechatMessage };

/** Successful QR login result — saved to config. */
export interface LoginResult {
  botToken: string;
  ilinkBotId: string;
  ilinkUserId: string;
  baseUrl: string;
}

/** Options passed to loginWithQR(). */
export interface LoginOptions {
  botType?: string;
  verbose?: boolean;
}

/** Track an in-progress QR login attempt. */
export interface ActiveLogin {
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
}

/** Result of sending a WeChat message via sendMessage(). */
export interface SendResult {
  clientId: string;
  runId: string;
}

/** Parameters for requesting a CDN upload URL. */
export interface UploadUrlParams {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
}

/** Generic response envelope for notifyStart / notifyStop. */
export interface NotifyResponse {
  ret?: number;
}
