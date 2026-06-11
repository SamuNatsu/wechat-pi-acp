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
import { getWechatClient } from "./wechat/client.js";
import { loadConfig } from "./config.js";
import path from "node:path";
import { splitText } from "./utils.js";

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
    await handleComposeMode(message, fromUserId, userTempDir, config.cdnBaseUrl, contextToken, config.maxFileSize);
    return;
  }

  // ---- STAGE 3: file-upload-mode bypass ----
  // When a user is in file-upload mode (started via /file-upload-start),
  // every non-command message is routed to the inbox module which
  // downloads media, checks for name conflicts, and tracks the file list.
  if (isUploadMode(fromUserId)) {
    await handleUploadMode(message, fromUserId, userTempDir, config.cdnBaseUrl, contextToken, config.maxFileSize);
    return;
  }

  // ---- STAGE 4: agent routing ----

  // Download any media attachments (images, files, videos, voice)
  // Each item is decrypted and saved to the user's temp directory.
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

/** True when a prompt is in-flight — guards against concurrent conn.prompt() calls. */
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
  // Guard against concurrent prompts.  Must be checked and set BEFORE
  // any await so two callers cannot race past the check together.
  if (promptBusy) {
    await sendTextReply(fromUserId, "⚠️ Agent 正在处理上一条消息，请稍后重试。", contextToken);
    return;
  }
  promptBusy = true;

  try {
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

    // Inject system prompt before the first message of a fresh session
    if (isSessionFresh(fromUserId)) {
      const config = loadConfig();
      if (config.systemPrompt) {
        prompt = config.systemPrompt + "\n\n---\n\n" + prompt;
        markSessionUsed(fromUserId);
      }
    }

    // Send typing indicator before the prompt
    await setTyping(fromUserId, contextToken, 1);

    // Send the prompt to the ACP agent — this blocks until the agent
    // finishes processing (the collector accumulates output concurrently)
    console.log(`[dispatch] Prompting agent: "${prompt.slice(0, 60)}..."`);
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
      console.error(`[dispatch] Prompt failed: ${(err as Error).message}`);
      collector.reset();
      await sendTextReply(fromUserId, `⚠️ Agent 请求失败: ${(err as Error).message}`, contextToken);
      return;
    }

    // Send typing indicator after the prompt completes
    await setTyping(fromUserId, contextToken, 2);

    // Flush any remaining buffered text from the collector.
    // Most text was already sent in real-time via onFlush above.
    const hadOutput = collector.hasOutput() || collector.getText().length > 0;
    collector.flush();

    // If the agent produced no output at all but media was received,
    // send a short acknowledgement
    if (!hadOutput && (!userText || mediaPaths.length > 0)) {
      await sendTextReply(fromUserId, "✅ 已收到消息", contextToken);
    }

    // Update the last-active timestamp for idle-timeout tracking
    touchSession(fromUserId);
  } finally {
    promptBusy = false;
  }
}
