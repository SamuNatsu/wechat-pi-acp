/**
 * WeChat API client — convenient wrapper around api.ts that holds baseUrl and token.
 *
 * Keeps api.ts low-level helpers; this class bundles auth for high-level operations.
 */

import type {
  GetConfigResponse,
  GetUpdatesResponse,
  NotifyResponse,
  SendResult,
  UploadUrlParams,
  UploadUrlResponse,
  WechatMessageItem,
} from "../types.js";
import {
  getConfig as apiGetConfig,
  getUpdates as apiGetUpdates,
  getUploadUrl as apiGetUploadUrl,
  notifyStart as apiNotifyStart,
  notifyStop as apiNotifyStop,
  sendMessage as apiSendMessage,
  sendTyping as apiSendTyping,
} from "./api.js";
import { loadConfig } from "../config.js";

export class WechatClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  sendMessage(toUserId: string, itemList: WechatMessageItem[], contextToken?: string): Promise<SendResult> {
    return apiSendMessage(this.baseUrl, this.token, toUserId, itemList, contextToken);
  }

  getConfig(ilinkUserId: string, contextToken?: string): Promise<GetConfigResponse> {
    return apiGetConfig(this.baseUrl, this.token, ilinkUserId, contextToken);
  }

  sendTyping(ilinkUserId: string, typingTicket: string, status: number): Promise<void> {
    return apiSendTyping(this.baseUrl, this.token, ilinkUserId, typingTicket, status);
  }

  getUploadUrl(params: UploadUrlParams): Promise<UploadUrlResponse> {
    return apiGetUploadUrl(this.baseUrl, this.token, params);
  }

  getUpdates(getUpdatesBuf: string, abortSignal?: AbortSignal, timeoutMs?: number): Promise<GetUpdatesResponse> {
    return apiGetUpdates(this.baseUrl, this.token, getUpdatesBuf, abortSignal, timeoutMs);
  }

  notifyStart(): Promise<NotifyResponse> {
    return apiNotifyStart(this.baseUrl, this.token);
  }

  notifyStop(): Promise<NotifyResponse> {
    return apiNotifyStop(this.baseUrl, this.token);
  }
}

let _client: WechatClient | null = null;

export function getWechatClient(): WechatClient {
  if (!_client) {
    const config = loadConfig();
    _client = new WechatClient(config.baseUrl, config.token);
  }
  return _client;
}

export function setWechatClient(client: WechatClient): void {
  _client = client;
}
