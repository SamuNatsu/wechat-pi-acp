import type { CancelNotification, SetSessionModeRequest } from "@agentclientprotocol/sdk";
import { escape, humanizeSize } from "./utils.js";
import type { SessionData } from "./types.js";
import type { SessionMeta } from "./agent/handler.js";
import fs from "node:fs/promises";
import path from "node:path";

// ---- CommandContext ----

/** Narrowed view of the ACP connection exposed to slash-command handlers. */
export interface AgentConnection {
  cancel: (params: CancelNotification) => Promise<void>;
  setSessionMode: (params: SetSessionModeRequest) => Promise<void>;
}

export interface CommandReplyOps {
  fromUserId: string;
  contextToken: string;
  sendReply: (text: string) => Promise<void>;
  sendMedia: (filePath: string) => Promise<void>;
}

export interface CommandSessionOps {
  getSession: () => SessionData | null;
  deleteSession: () => void;
  agentRunning: () => boolean;
  killAgent: () => void;
  resetSessionState: () => void;
  getSessionMeta: () => SessionMeta | null;
}

export interface CommandAgentOps {
  agentConn: () => AgentConnection | null;
  sendPrompt: (text: string) => Promise<void>;
}

export interface CommandMediaOps {
  inboxDir: string;
  cleanupUserDir: () => Promise<void>;
  uploadStart: () => void;
  uploadEnd: () => { name: string; size: number }[];
  composeStart: () => void;
  composeEnd: () => string | null;
  composeCancel: () => void;
}

/**
 * Dependency-injection context passed to every command handler.
 * Methods are closures that capture the current message's fromUserId
 * and contextToken so commands can mutate sessions without losing the
 * reply target.
 */
export interface CommandContext extends CommandReplyOps, CommandSessionOps, CommandAgentOps, CommandMediaOps {}

// ---- handler & registry ----

type CommandHandler = (ctx: CommandContext, args: string[]) => Promise<void>;

interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: CommandHandler;
}

/** Case-sensitive registry of all registered slash commands. */
const registry = new Map<string, CommandDef>();

function register(def: CommandDef): void {
  registry.set(def.name, def);
  if (def.aliases) {
    for (const alias of def.aliases) {
      registry.set(alias, def);
    }
  }
}

// ---- tokenizer ----

/**
 * Shell-style tokenizer: splits on whitespace, supports double-quoted strings.
 * Used to parse slash-command arguments (e.g. /file-send "my file.txt" hello).
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    if (input[i] === '"') {
      i++;
      let token = "";
      while (i < input.length && input[i] !== '"') {
        token += input[i];
        i++;
      }
      if (i < input.length) i++;
      tokens.push(token);
    } else {
      let token = "";
      while (i < input.length && !/\s/.test(input[i])) {
        token += input[i];
        i++;
      }
      tokens.push(token);
    }
  }
  return tokens;
}

// ---- resolve + dispatch ----

/**
 * Parse the first token of a message. If it starts with '/' and matches
 * a registered command, return the command definition and remaining args.
 */
function resolve(text: string): { def: CommandDef; args: string[] } | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  const cmd = tokens[0];
  if (!cmd.startsWith("/")) return null;
  const def = registry.get(cmd);
  if (!def) return null;
  return { def, args: tokens.slice(1) };
}

/**
 * Try to handle a user message as a slash command.
 * Returns true if a command was matched and executed; false otherwise.
 */
export async function dispatchCommand(text: string, ctx: CommandContext): Promise<boolean> {
  const resolved = resolve(text);
  if (!resolved) return false;
  await resolved.def.handler(ctx, resolved.args);
  return true;
}

// ---- help text ----

/** Build a Markdown table listing all registered commands. */
export function commandsHelpText(): string {
  let text = "**💡 可用命令：**\n\n| 命令 | 说明 | 用法 |\n| --- | --- | --- |\n";
  for (const [name, def] of registry) {
    const desc = name === def.name ? def.description : `同 ${def.name} — ${def.description}`;
    const usage = def.usage ? `\`${def.usage}\`` : "";
    text += `| \`${name}\` | ${escape(desc)} | ${usage} |\n`;
  }
  return text;
}

// ---- built-in commands ----

register({
  name: "/new",
  description: "创建新会话（清除历史）",
  handler: async (ctx) => {
    ctx.killAgent();
    ctx.resetSessionState();
    ctx.deleteSession();
    ctx.uploadEnd();
    ctx.composeCancel();
    await ctx.cleanupUserDir();
    await ctx.sendReply("✅ 新会话已创建。");
  },
});

register({
  name: "/cancel",
  description: "取消当前正在执行的请求",
  handler: async (ctx) => {
    const conn = ctx.agentConn();
    const session = ctx.getSession();
    if (conn && session?.sessionId) {
      await conn.cancel({ sessionId: session.sessionId }).catch(() => {});
    }
    await ctx.sendReply("✅ 已取消");
  },
});

register({
  name: "/status",
  description: "查看当前会话状态",
  handler: async (ctx) => {
    const session = ctx.getSession();
    const meta = ctx.getSessionMeta();
    const lastActive = session?.lastActiveAt ? new Date(session.lastActiveAt).toLocaleString() : "";

    const rows: string[][] = [
      ["会话 ID", session?.sessionId || "无"],
      ["最后活跃", lastActive || "未知"],
      ["Agent 运行中", ctx.agentRunning() ? "是" : "否"],
    ];

    if (meta?.sessionTitle) rows.push(["会话标题", meta.sessionTitle]);
    if (meta?.currentModeId) rows.push(["当前模式", meta.currentModeId]);

    for (const opt of meta?.configOptions || []) {
      rows.push([opt.name, opt.currentValue]);
    }

    const text = ["**📊 会话状态：**", "", "| 属性 | 值 |", "| --- | --- |"]
      .concat(rows.map(([k, v]) => `| ${escape(k)} | ${escape(v)} |`))
      .join("\n");

    await ctx.sendReply(text);
  },
});

register({
  name: "/file-list",
  description: "列出当前会话的临时文件",
  handler: async (ctx) => {
    let entries: { name: string; size: number }[];
    try {
      const items = await fs.readdir(ctx.inboxDir, { withFileTypes: true });
      const stats = await Promise.all(
        items
          .filter((d) => d.isFile())
          .map(async (d) => {
            const s = await fs.stat(path.join(ctx.inboxDir, d.name));
            return { name: d.name, size: s.size };
          }),
      );
      entries = stats;
    } catch {
      entries = [];
    }

    if (entries.length === 0) {
      await ctx.sendReply("📂 暂无临时文件");
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    let text = "**📂 临时文件列表：**\n\n| 文件名 | 大小 |\n| --- | --- |\n";
    for (const entry of entries) {
      text += `| ${escape(entry.name)} | ${humanizeSize(entry.size)} |\n`;
    }
    await ctx.sendReply(text);
  },
});

register({
  name: "/file-upload-start",
  description: "开始接收文件上传",
  handler: async (ctx) => {
    ctx.uploadStart();
    await ctx.sendReply("📤 文件上传模式已开启，请直接发送文件。发送 `/file-upload-end` 结束上传");
  },
});

register({
  name: "/file-upload-end",
  description: "结束文件上传",
  handler: async (ctx) => {
    const files = ctx.uploadEnd();
    if (files.length === 0) {
      await ctx.sendReply("📤 文件上传模式已结束，未接收文件");
    } else {
      let text = "**📤 上传完成，共接收以下文件：**\n\n| 文件名 | 大小 |\n| --- | --- |\n";
      for (const f of files) {
        text += `| ${escape(f.name)} | ${humanizeSize(f.size)} |\n`;
      }
      await ctx.sendReply(text);
    }
  },
});

register({
  name: "/file-send",
  description: "手动发送文件到微信",
  usage: "/file-send <文件路径>",
  handler: async (ctx, args) => {
    if (args.length === 0) {
      await ctx.sendReply("ℹ️ 用法: `/file-send <文件路径>`");
      return;
    }
    const rawPath = args[0];
    const resolved = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(ctx.inboxDir, rawPath));
    if (!resolved.startsWith(ctx.inboxDir + path.sep) && resolved !== ctx.inboxDir) {
      await ctx.sendReply("⚠️ 仅支持发送会话目录中的文件，请使用 `/file-list` 查看可发送文件");
      return;
    }
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) throw new Error("不是文件");
    } catch {
      await ctx.sendReply(`⚠️ 文件不存在: ${rawPath}`);
      return;
    }
    try {
      await ctx.sendMedia(resolved);
      await ctx.sendReply("✅ 文件已发送");
    } catch (err) {
      await ctx.sendReply(`⚠️ 发送失败: ${(err as Error).message}`);
    }
  },
});

register({
  name: "/file-clear",
  description: "清除当前会话的临时文件",
  handler: async (ctx) => {
    await ctx.cleanupUserDir();
    await ctx.sendReply("✅ 临时文件已清除");
  },
});

register({
  name: "/think",
  description: "设置思考深度",
  usage: "/think off|minimal|low|medium|high|xhigh",
  handler: async (ctx, args) => {
    if (args.length === 0) {
      await ctx.sendReply("ℹ️ 用法: `/think off|minimal|low|medium|high|xhigh`");
      return;
    }
    const level = args[0];
    const valid = ["off", "minimal", "low", "medium", "high", "xhigh"];
    if (!valid.includes(level)) {
      await ctx.sendReply(`⚠️ 无效: ${level}。有效值: ${valid.join(", ")}`);
      return;
    }
    const conn = ctx.agentConn();
    if (conn) {
      const session = ctx.getSession();
      if (session?.sessionId) {
        await conn.setSessionMode({ sessionId: session.sessionId, modeId: level }).catch(() => {});
      }
    }
    await ctx.sendReply(`🧠 思考深度: ${level}`);
  },
});

register({
  name: "/msg-start",
  description: "开始收集消息和文件（混合消息模式）",
  handler: async (ctx) => {
    ctx.composeStart();
    await ctx.sendReply("📝 消息收集模式已开启，请继续发送文本和文件。\n发送 `/msg-end` 提交  |  `/msg-cancel` 取消");
  },
});

register({
  name: "/msg-end",
  description: "提交收集的消息和文件",
  handler: async (ctx) => {
    const prompt = ctx.composeEnd();
    if (prompt === null) {
      await ctx.sendReply("⚠️ 未在消息收集模式中，请先使用 `/msg-start`");
      return;
    }
    await ctx.sendReply("📝 已提交，正在处理...");
    await ctx.sendPrompt(prompt);
  },
});

register({
  name: "/msg-cancel",
  description: "取消消息收集",
  handler: async (ctx) => {
    ctx.composeCancel();
    await ctx.sendReply("❌ 已取消消息收集");
  },
});

register({
  name: "/help",
  description: "显示帮助",
  handler: async (ctx) => {
    await ctx.sendReply(commandsHelpText());
  },
});
