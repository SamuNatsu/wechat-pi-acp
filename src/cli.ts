#!/usr/bin/env node

/**
 * wechat-pi-acp — WeChat-to-ACP Bridge CLI
 *
 * Connects WeChat to Pi ACP agent via QR login.
 */

import { cac } from "cac";
import { VERSION } from "./version.js";
import { loadConfig } from "./config.js";
import { loginWithQR } from "./wechat/auth.js";
import { streamMessages, notifyStart, notifyStop } from "./wechat/stream.js";
import { handleMessage } from "./dispatch.js";
import { fullCleanup, startPeriodicCleanup, stopPeriodicCleanup } from "./media/cleanup.js";
import { killAgent } from "./agent/client.js";
import type { WechatMessageItem } from "./types.js";

// ---- CLI definition ----

const cli = cac("wechat-pi-acp")
  .option("--login", "Force QR login (even if token exists)")
  .option("--verbose", "Enable verbose logging")
  .help()
  .version(VERSION);

interface CliOptions {
  login: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

// ---- main ----

async function main(): Promise<void> {
  // Parse CLI args
  const parsed = cli.parse();
  const opts = parsed.options as CliOptions;

  if (opts.help || opts.version) {
    process.exit(0);
  }

  // Guard: require Node.js 22+
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) {
    console.error("ERROR: Node.js 22+ required.");
    process.exit(1);
  }

  // Load saved config from ~/.wechat-pi-acp/config.json
  let config = loadConfig();

  // QR login (first run or --login flag)
  if (opts.login || !config.token) {
    console.log("wechat-pi-acp: 需要登录微信\n");
    try {
      const result = await loginWithQR({ verbose: opts.verbose });
      config = loadConfig();
      console.log(`已连接! ilink_bot_id=${result.ilinkBotId}\n`);
    } catch (err) {
      console.error(`登录失败: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Guard: token must exist after login
  if (!config.token) {
    console.error("未配置 token，请先运行 wechat-pi-acp --login");
    process.exit(1);
  }

  // Print startup info
  console.log(`wechat-pi-acp v${VERSION} — 正在启动...`);
  console.log(`  目标 Agent: ${config.acpCommand}`);
  console.log(`  用户 ID: ${config.ilinkUserId}`);
  console.log(`  空闲超时: ${config.idleTimeoutMs / 1000}s\n`);

  // Start periodic cleanup of stale temp files (/tmp/wechat-pi-acp/)
  startPeriodicCleanup(config.mediaTempDir, config.fileTtlMs);

  // ---- graceful shutdown ----

  const abortController = new AbortController();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n正在关闭...");
    abortController.abort(); // break the long-poll loop
    killAgent(); // SIGTERM the ACP agent child process
    try {
      await notifyStop(config.baseUrl, config.token);
    } catch {}
    stopPeriodicCleanup();
    await fullCleanup(config.mediaTempDir);
    console.log("再见！");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  // ---- startup handshake ----

  try {
    await notifyStart(config.baseUrl, config.token);
    console.log("[wechat] notifyStart 成功");
  } catch (err) {
    console.error(`[wechat] notifyStart 失败: ${(err as Error).message}`);
  }

  // ---- message loop ----

  console.log("[wechat] 开始长轮询...\n");

  let messageCount = 0;

  // Long-poll WeChat for inbound messages; yields StreamEvent{type, msg}
  for await (const event of streamMessages(config.baseUrl, config.token, abortController.signal, () => {})) {
    if (shuttingDown) break;

    // Server-side session expired — streamSession internally pauses 60 min
    if (event.type === "session-expired") {
      console.log("[wechat] 会话过期 (errcode -14)，暂停 60 分钟...");
      continue;
    }

    if (event.type === "message" && event.msg) {
      messageCount++;
      const from = event.msg.from_user_id || "未知";
      const texts = (event.msg.item_list || []).filter((i: WechatMessageItem) => i.type === 1 && i.text_item?.text);
      const preview = texts.map((i: WechatMessageItem) => i.text_item!.text.slice(0, 40)).join(" | ") || "[非文本消息]";
      console.log(`[msg #${messageCount}] ${from}: ${preview}`);

      // Route to dispatch: slash commands intercept, else agent prompt
      try {
        await handleMessage(event.msg);
      } catch (err) {
        console.error(`[msg] 处理失败: ${(err as Error).message}`);
      }
    }
  }
}

main().catch((err: Error) => {
  console.error(`致命错误: ${err.message}`);
  process.exit(1);
});
