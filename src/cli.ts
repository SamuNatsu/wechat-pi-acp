#!/usr/bin/env node

/**
 * wechat-pi-acp — WeChat-to-ACP Bridge CLI
 *
 * Connects WeChat to Pi ACP agent via QR login.
 */

import { createLogger, setVerbose } from "./logger.js";
import { VERSION } from "./version.js";
import type { WechatMessageItem } from "./types.js";
import { cac } from "cac";
import { fullCleanup } from "./media/cleanup.js";
import { getWechatClient } from "./wechat/client.js";
import { handleMessage } from "./dispatch.js";
import { killAgent } from "./agent/agent.js";
import { loadConfig } from "./config.js";
import { loginWithQR } from "./wechat/auth.js";
import { streamMessages } from "./wechat/stream.js";

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

// ---- loggers ----

const wechatLog = createLogger("wechat");
const msgLog = createLogger("msg");

// ---- main ----

async function main(): Promise<void> {
  const parsed = cli.parse();
  const opts = parsed.options as CliOptions;

  if (opts.help || opts.version) {
    process.exit(0);
  }

  setVerbose(opts.verbose);

  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) {
    console.error("ERROR: Node.js 22+ required.");
    process.exit(1);
  }

  let config = loadConfig();

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

  if (!config.token) {
    console.error("未配置 token，请先运行 wechat-pi-acp --login");
    process.exit(1);
  }

  console.log(`wechat-pi-acp v${VERSION} — 正在启动...`);
  console.log(`  目标 Agent: ${config.acpCommand}`);
  console.log(`  用户 ID: ${config.ilinkUserId}`);
  console.log(`  空闲超时: ${config.idleTimeoutMs / 1000}s\n`);

  const abortController = new AbortController();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n正在关闭...");
    abortController.abort();
    killAgent();
    try {
      await getWechatClient().notifyStop();
    } catch {}
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

  try {
    await getWechatClient().notifyStart();
    wechatLog.info("notifyStart 成功");
  } catch (err) {
    wechatLog.error("notifyStart 失败: %s", (err as Error).message);
  }

  wechatLog.info("开始长轮询...");

  let messageCount = 0;

  for await (const event of streamMessages(abortController.signal, () => {})) {
    if (shuttingDown) break;

    if (event.type === "session-expired") {
      wechatLog.warn("会话过期 (errcode -14)，暂停 60 分钟...");
      continue;
    }

    if (event.type === "message" && event.msg) {
      messageCount++;
      const from = event.msg.from_user_id || "未知";
      const texts = (event.msg.item_list || []).filter((i: WechatMessageItem) => i.type === 1 && i.text_item?.text);
      const preview = texts.map((i: WechatMessageItem) => i.text_item!.text.slice(0, 40)).join(" | ") || "[非文本消息]";
      msgLog.info("#%d %s: %s", messageCount, from, preview);

      void handleMessage(event.msg).catch((err) => {
        msgLog.error("处理失败: %s", (err as Error).message);
      });
    }
  }
}

main().catch((err: Error) => {
  console.error(`致命错误: ${err.message}`);
  process.exit(1);
});
