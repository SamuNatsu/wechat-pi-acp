/**
 * Message dispatch pipeline — the central orchestrator of wechat-pi-acp.
 *
 * Each incoming WeChat message flows through three stages:
 *   1. Command intercept  — slash-commands are handled locally
 *   2. Upload-mode bypass — if the user is in file-upload mode, non-command
 *      messages are intercepted by the inbox module
 *   3. Agent routing      — text and media are forwarded to the ACP agent
 *
 * Reply helpers (`sendTextReply` / `sendMediaReply`) are exported for use
 * by sibling modules (media/inbox, commands via CommandContext closures).
 */

import { type AgentConnection, type CommandContext, dispatchCommand } from "./commands.js";
import type { WechatMessage, WechatMessageItem } from "./types.js";
import { composeCancel, composeEnd, composeStart, handleComposeMode, isComposeMode } from "./media/compose.js";
import { deleteSession, getSession, setSession, touchSession } from "./agent/session.js";
import { downloadMedia, extractMediaItems } from "./media/download.js";
import { ensureAgentRunning, getCurrentCollector, resetSessionState } from "./agent/lifecycle.js";
import { getConfig, sendMessage, sendTyping } from "./wechat/api.js";
import { getConnection, isRunning, killAgent } from "./agent/client.js";
import { handleUploadMode, isUploadMode, uploadEnd, uploadStart } from "./media/inbox.js";
import { cleanupUserDir } from "./media/cleanup.js";
import { loadConfig } from "./config.js";
import path from "node:path";
import { splitText } from "./utils.js";
import { uploadAndBuildMediaItems } from "./media/upload.js";

// ---- message dispatch ----

/**
 * Main entry point for every WeChat message (text + media).
 *
 * Pipeline:
 *   1. Extract text content and per-user temp directory
 *   2. Build a CommandContext (closures over the current message's state)
 *   3. Try command dispatch — if a slash-command matches, handle it and stop
 *   4. If the user is in file-upload mode, route to the inbox module
 *   5. Otherwise download any attached media, ensure the agent is running,
 *      send the prompt, and relay the agent's text reply back to WeChat
 */
export async function handleMessage(message: WechatMessage): Promise<void> {
  const config = loadConfig();
  const fromUserId = message.from_user_id;
  if (!fromUserId) return;

  // Capture the context token early — it's needed for all replies
  // and must be preserved even if the session is deleted mid-flow
  const contextToken = message.context_token || "";

  // Collect all text items from the message (type 1 = text)
  const textItems = (message.item_list || []).filter((i: WechatMessageItem) => i.type === 1 && i.text_item?.text);
  const userText = textItems.map((i: WechatMessageItem) => i.text_item!.text).join("\n") || "";

  // Persist the context token to the session store so commands
  // (which may delete/refresh the session) can still reply
  setSession(fromUserId, { contextToken });

  // Per-user temp directory for downloaded media — sanitises
  // characters that are unsafe in paths (@ and .)
  const userTempDir = path.join(config.mediaTempDir, "inbox", fromUserId.replace(/[@.]/g, "_"));

  // Build a CommandContext that binds the current fromUserId and token.
  // Every closure captures the values at call time so commands can safely
  // mutate sessions without losing the reply target.
  const ctx: CommandContext = {
    fromUserId,
    contextToken,
    inboxDir: userTempDir,
    sendReply: (text) => sendTextReply(fromUserId, text, contextToken),
    sendMedia: (filePath, caption) => sendMediaReply(fromUserId, filePath, contextToken, caption),
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

  // ---- STAGE 1: command intercept ----
  // Slash-commands are handled entirely within the commands module.
  // If the text starts with a recognised command, we stop here.
  const handled = await dispatchCommand(userText, ctx);
  if (handled) return;

  // ---- STAGE 2: compose-mode bypass ----
  // When a user is in message-compose mode (started via /msg-start),
  // all non-command text and media are accumulated until /msg-end.
  if (isComposeMode(fromUserId)) {
    await handleComposeMode(message, fromUserId, userTempDir, config.cdnBaseUrl, contextToken);
    return;
  }

  // ---- STAGE 3: file-upload-mode bypass ----
  // When a user is in file-upload mode (started via /file-upload-start),
  // every non-command message is routed to the inbox module which
  // downloads media, checks for name conflicts, and tracks the file list.
  if (isUploadMode(fromUserId)) {
    await handleUploadMode(message, fromUserId, userTempDir, config.cdnBaseUrl, contextToken);
    return;
  }

  // ---- STAGE 4: agent routing ----

  // Download any media attachments (images, files, videos, voice)
  // Each item is decrypted and saved to the user's temp directory.
  const mediaExtracts = extractMediaItems(message);
  const mediaPaths: { filePath: string; size: number }[] = [];
  if (mediaExtracts.length > 0) {
    for (const media of mediaExtracts) {
      const result = await downloadMedia(config.cdnBaseUrl, media.cdn, userTempDir, media.type);
      if (result) mediaPaths.push(result);
    }
  }

  await routeToAgent(fromUserId, userTempDir, contextToken, userText, mediaPaths);
  touchSession(fromUserId);
}

// ---- agent routing helper ----

async function routeToAgent(
  fromUserId: string,
  userTempDir: string,
  contextToken: string,
  userText: string,
  mediaPaths: { filePath: string; size: number }[],
): Promise<void> {
  const config = loadConfig();

  // Ensure the ACP agent child process is running for this user.
  try {
    await ensureAgentRunning(fromUserId, userTempDir);
  } catch (err) {
    console.error(`[dispatch] Failed to start agent: ${(err as Error).message}`);
    await sendTextReply(fromUserId, `⚠️ Agent 启动失败: ${(err as Error).message}`, contextToken);
    return;
  }

  // Grab the collector (accumulates agent text output) and connection.
  // Both are set by ensureAgentRunning above.
  const collector = getCurrentCollector();
  const conn = getConnection();
  if (!collector || !conn) {
    await sendTextReply(fromUserId, "⚠️ Agent 未运行，请稍后重试。", contextToken);
    return;
  }

  // Wire the collector's flush callback to send real-time text chunks to
  // WeChat. This is set per-message so the correct contextToken is used.
  collector.setOnFlush((text: string): void => {
    for (const chunk of splitText(text, 4000)) {
      void sendTextReply(fromUserId, chunk, contextToken);
    }
  });

  // Clear any leftover text from a previous prompt cycle
  collector.reset();
  const session = getSession(fromUserId);

  // Build the prompt — plain text plus file paths if media was attached
  let prompt = userText || "你好";
  if (mediaPaths.length > 0) {
    prompt += "\n\n用户发送了以下文件：";
    for (const m of mediaPaths) {
      prompt += `\n  - ${m.filePath} (${m.size} bytes)`;
    }
    prompt += "\n\n如果有需要，请使用 read 工具查看文件内容。";
  }

  // Send typing indicator (state 1 = "typing") before the prompt
  try {
    const configResp = await getConfig(config.baseUrl, config.token, fromUserId, contextToken);
    if (configResp.typing_ticket) {
      await sendTyping(config.baseUrl, config.token, fromUserId, configResp.typing_ticket, 1);
    }
  } catch {}

  // Send the prompt to the ACP agent — this blocks until the agent
  // finishes processing (the collector accumulates output concurrently)
  console.log(`[dispatch] Prompting agent: "${prompt.slice(0, 60)}..."`);
  try {
    await conn.prompt({
      sessionId: session?.sessionId || fromUserId,
      prompt: [{ type: "text", text: prompt }],
    });
  } catch (err) {
    console.error(`[dispatch] Prompt failed: ${(err as Error).message}`);
    collector.reset();
    await sendTextReply(fromUserId, `⚠️ Agent 请求失败: ${(err as Error).message}`, contextToken);
    return;
  }

  // Send typing indicator (state 2 = "stopped") after the prompt completes
  try {
    const configResp = await getConfig(config.baseUrl, config.token, fromUserId, contextToken);
    if (configResp.typing_ticket) {
      await sendTyping(config.baseUrl, config.token, fromUserId, configResp.typing_ticket, 2);
    }
  } catch {}

  // Flush any remaining buffered text from the collector.
  // Most text was already sent in real-time via onFlush above.
  const hadRemaining = collector.getText().length > 0;
  collector.flush();

  // If the agent produced no output at all but media was received,
  // send a short acknowledgement
  if (!hadRemaining && (!userText || mediaPaths.length > 0)) {
    await sendTextReply(fromUserId, "✅ 已收到消息", contextToken);
  }

  // Update the last-active timestamp for idle-timeout tracking
  touchSession(fromUserId);
}

// ---- reply helpers ----

/**
 * Send a plain-text WeChat message.
 * Used by the dispatch pipeline and the media/inbox module.
 */
export async function sendTextReply(toUserId: string, text: string, contextToken?: string): Promise<void> {
  if (!text) return;
  const config = loadConfig();
  try {
    await sendMessage(config.baseUrl, config.token, toUserId, [{ type: 1, text_item: { text } }], contextToken);
    const preview = text.length > 30 ? text.slice(0, 30) + "…" : text;
    console.log(`[dispatch] Replied text (${text.length} chars) to ${toUserId}:${preview}`);
  } catch (err) {
    console.error(`[dispatch] Reply failed: ${(err as Error).message}`);
  }
}

/**
 * Upload a local file to WeChat CDN and send it as a media message.
 * An optional caption is sent as a separate text message before the file.
 */
async function sendMediaReply(
  toUserId: string,
  filePath: string,
  contextToken?: string,
  caption?: string,
): Promise<void> {
  const config = loadConfig();
  const result = await uploadAndBuildMediaItems(config.baseUrl, config.token, filePath, toUserId);

  if (caption) {
    await sendMessage(
      config.baseUrl,
      config.token,
      toUserId,
      [{ type: 1, text_item: { text: caption } }],
      contextToken,
    );
  }

  for (const item of result.items) {
    await sendMessage(config.baseUrl, config.token, toUserId, [item], contextToken);
  }
}
