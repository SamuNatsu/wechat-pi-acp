/**
 * Message dispatch pipeline — the central orchestrator of wechat-pi-acp.
 *
 * Each incoming WeChat message flows through four stages:
 *   1. Command intercept  — slash-commands are handled locally
 *   2. Compose-mode bypass — if the user is in compose mode, accumulate text + files
 *   3. File-upload-mode bypass — if the user is in file-upload mode, save media
 *   4. Agent routing      — text and media are forwarded to the ACP agent
 */

import { type AgentConnection, type CommandContext, dispatchCommand } from "./commands.js";
import type { WechatMessage, WechatMessageItem } from "./types.js";
import {
  clearPromptRejector,
  ensureAgentRunning,
  getConnection,
  getCurrentCollector,
  isRunning,
  isSessionFresh,
  killAgent,
  markSessionUsed,
  resetSessionState,
  setPromptRejector,
} from "./agent/agent.js";
import { composeCancel, composeEnd, composeStart, handleComposeMode, isComposeMode } from "./media/compose.js";
import { deleteSession, getSession, setSession, touchSession } from "./agent/session.js";
import { downloadMedia, extractMediaItems } from "./media/download.js";
import { handleUploadMode, isUploadMode, uploadEnd, uploadStart } from "./media/inbox.js";
import { sendMediaReply, sendTextReply } from "./reply.js";
import { cleanupUserDir } from "./media/cleanup.js";
import { createLogger } from "./logger.js";
import { getWechatClient } from "./wechat/client.js";
import { loadConfig } from "./config.js";
import path from "node:path";
import { splitText } from "./utils.js";

const log = createLogger("dispatch");

// ---- message dispatch ----

export async function handleMessage(message: WechatMessage): Promise<void> {
  const config = loadConfig();
  const fromUserId = message.from_user_id;
  if (!fromUserId) return;

  const contextToken = message.context_token || "";

  const textItems = (message.item_list || []).filter((i: WechatMessageItem) => i.type === 1 && i.text_item?.text);
  const userText = textItems.map((i: WechatMessageItem) => i.text_item!.text).join("\n") || "";

  setSession(fromUserId, { contextToken });

  const userTempDir = path.join(config.mediaTempDir, "inbox", fromUserId.replace(/[@.]/g, "_"));

  const ctx: CommandContext = {
    fromUserId,
    contextToken,
    inboxDir: userTempDir,
    sendReply: (text) => sendTextReply(fromUserId, text, contextToken),
    sendMedia: (filePath) => sendMediaReply(fromUserId, filePath, contextToken),
    getSession: () => getSession(fromUserId),
    deleteSession: () => deleteSession(fromUserId),
    agentConn: () => getConnection() as AgentConnection | null,
    agentRunning: () => isRunning(),
    killAgent: () => killAgent(),
    resetSessionState: () => resetSessionState(),
    cleanupUserDir: () => cleanupUserDir(userTempDir),
    uploadStart: () => uploadStart(fromUserId),
    uploadEnd: () => uploadEnd(fromUserId),
    composeStart: () => composeStart(fromUserId),
    composeEnd: () => composeEnd(fromUserId),
    composeCancel: () => composeCancel(fromUserId),
    sendPrompt: (text: string) => routeToAgent(fromUserId, userTempDir, contextToken, text, []),
    getSessionMeta: () => getCurrentCollector()?.getMeta() ?? null,
  };

  const handled = await dispatchCommand(userText, ctx);
  if (handled) return;

  if (isComposeMode(fromUserId)) {
    await handleComposeMode(message, fromUserId, userTempDir, config.cdnBaseUrl, contextToken, config.maxFileSize);
    return;
  }

  if (isUploadMode(fromUserId)) {
    await handleUploadMode(message, fromUserId, userTempDir, config.cdnBaseUrl, contextToken, config.maxFileSize);
    return;
  }

  const mediaExtracts = extractMediaItems(message);
  const mediaPaths: { filePath: string; size: number }[] = [];
  if (mediaExtracts.length > 0) {
    for (const media of mediaExtracts) {
      const result = await downloadMedia(config.cdnBaseUrl, media.cdn, userTempDir, media.type, config.maxFileSize);
      if (result) mediaPaths.push(result);
    }
  }

  await routeToAgent(fromUserId, userTempDir, contextToken, userText, mediaPaths);
  touchSession(fromUserId);
}

// ---- agent routing helper ----

let promptBusy = false;

async function setTyping(fromUserId: string, contextToken: string, status: number): Promise<void> {
  try {
    const client = getWechatClient();
    const configResp = await client.getConfig(fromUserId, contextToken);
    if (configResp.typing_ticket) {
      await client.sendTyping(fromUserId, configResp.typing_ticket, status);
    }
  } catch {}
}

async function routeToAgent(
  fromUserId: string,
  userTempDir: string,
  contextToken: string,
  userText: string,
  mediaPaths: { filePath: string; size: number }[],
): Promise<void> {
  if (promptBusy) {
    await sendTextReply(fromUserId, "⚠️ Agent 正在处理上一条消息，请稍后重试。", contextToken);
    return;
  }
  promptBusy = true;

  try {
    try {
      await ensureAgentRunning(fromUserId, userTempDir);
    } catch (err) {
      log.error("Failed to start agent: %s", (err as Error).message);
      await sendTextReply(fromUserId, `⚠️ Agent 启动失败: ${(err as Error).message}`, contextToken);
      return;
    }

    const collector = getCurrentCollector();
    const conn = getConnection();
    if (!collector || !conn) {
      await sendTextReply(fromUserId, "⚠️ Agent 未运行，请稍后重试。", contextToken);
      return;
    }

    collector.setOnFlush((text: string): void => {
      for (const chunk of splitText(text, 4000)) {
        void sendTextReply(fromUserId, chunk, contextToken);
      }
    });

    collector.reset();
    const session = getSession(fromUserId);

    let prompt = userText || "你好";
    if (mediaPaths.length > 0) {
      prompt += "\n\n用户发送了以下文件：";
      for (const m of mediaPaths) {
        prompt += `\n  - ${m.filePath} (${m.size} bytes)`;
      }
      prompt += "\n\n如果有需要，请使用 read 工具查看文件内容。";
    }

    if (isSessionFresh(fromUserId)) {
      const config = loadConfig();
      if (config.systemPrompt) {
        prompt = config.systemPrompt + "\n\n---\n\n" + prompt;
        markSessionUsed(fromUserId);
      }
    }

    await setTyping(fromUserId, contextToken, 1);

    log.debug('Prompting agent: "%s..."', prompt.slice(0, 60));
    try {
      await new Promise<void>((resolve, reject) => {
        setPromptRejector(reject);
        conn
          .prompt({
            sessionId: session?.sessionId || fromUserId,
            prompt: [{ type: "text", text: prompt }],
          })
          .then(() => resolve(), reject)
          .finally(clearPromptRejector);
      });
    } catch (err) {
      log.error("Prompt failed: %s", (err as Error).message);
      collector.reset();
      await sendTextReply(fromUserId, `⚠️ Agent 请求失败: ${(err as Error).message}`, contextToken);
      return;
    }

    await setTyping(fromUserId, contextToken, 2);

    const hadOutput = collector.hasOutput() || collector.getText().length > 0;
    collector.flush();

    if (!hadOutput && (!userText || mediaPaths.length > 0)) {
      await sendTextReply(fromUserId, "✅ 已收到消息", contextToken);
    }

    touchSession(fromUserId);
  } finally {
    promptBusy = false;
  }
}
