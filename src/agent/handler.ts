/**
 * ACP handler factory and text collector.
 *
 * The handler factory creates a Client implementation that the ACP SDK calls
 * back when the agent sends session updates, requests file I/O, or asks for
 * permissions.
 *
 * The text collector streams agent_message_chunk text to WeChat in real-time
 * via an onFlush callback — chunks are sent as they accumulate instead of
 * waiting until the prompt cycle completes.
 */

import type {
  Agent,
  Client,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

/** Aggregated session metadata captured from the agent's sessionUpdate stream. */
export interface SessionMeta {
  currentModeId: string | null;
  sessionTitle: string | null;
  configOptions: Array<{ name: string; currentValue: string }>;
}

/**
 * Create an ACP Client handler wired to the given callbacks.
 *
 * @param onUpdate     Called for every sessionUpdate from the agent (text chunks, tool calls, etc.)
 * @param onPermission Called when the agent requests a permission; defaults to "approved"
 * @param cwd          Working directory of the agent — file read/write is restricted to this tree
 */
export function createHandlerFactory(
  onUpdate: (update: SessionUpdate) => void,
  onPermission?: (params: RequestPermissionRequest) => RequestPermissionResponse,
  cwd?: string,
): (agent: Agent) => Client {
  return (_agent: Agent): Client => ({
    sessionUpdate(params: SessionNotification): Promise<void> {
      if (params?.update) {
        onUpdate(params.update);
      }
      return Promise.resolve();
    },

    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return Promise.resolve(
        onPermission ? onPermission(params) : ({ outcome: "approved" } as unknown as RequestPermissionResponse),
      );
    },

    /** Read a text file on behalf of the agent — restricted to the agent's working directory. */
    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const fs = await import("node:fs/promises");
      const nodePath = await import("node:path");
      const resolved = nodePath.resolve(params.path);
      if (cwd && !resolved.startsWith(nodePath.resolve(cwd) + nodePath.sep) && resolved !== nodePath.resolve(cwd)) {
        throw new Error(`Access denied: ${params.path} is outside the agent workspace`);
      }
      const content = await fs.readFile(resolved, "utf-8");
      return { content };
    },

    /** Write a text file on behalf of the agent — restricted to the agent's working directory. */
    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      const fs = await import("node:fs/promises");
      const nodePath = await import("node:path");
      const resolved = nodePath.resolve(params.path);
      if (cwd && !resolved.startsWith(nodePath.resolve(cwd) + nodePath.sep) && resolved !== nodePath.resolve(cwd)) {
        throw new Error(`Access denied: ${params.path} is outside the agent workspace`);
      }
      await fs.mkdir(nodePath.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, params.content, "utf-8");
      return {};
    },
  });
}

/**
 * The text collector streams agent output to WeChat in real-time.
 *
 * Text chunks of the same kind (message or thought) are accumulated
 * consecutively. When the update kind changes — the agent finishes a
 * message block and starts thinking, or finishes thinking and moves on —
 * the accumulated text is flushed via onFlush. Tool-call content is
 * skipped entirely (the user does not need to see raw tool output).
 *
 * Use setOnFlush() after creation to wire the reply callback, then
 * call flush() after the prompt cycle to send any remaining text.
 */
export function createTextCollector() {
  let buf = "";
  let bufKind: string | null = null;
  let onFlush: (text: string) => void = () => {};
  const mediaFiles: unknown[] = [];
  let hasThought = false;
  let hadOutput = false;

  let currentModeId: string | null = null;
  let sessionTitle: string | null = null;
  const configOptionMap = new Map<string, string>();

  function emitBuf(): void {
    const text = buf.trim();
    buf = "";
    if (!text) return;
    hadOutput = true;
    if (bufKind === "thought") {
      onFlush(`**🤔 思考：**\n\n${text}`);
    } else {
      onFlush(text);
    }
  }

  function append(kind: string, text: string): void {
    if (bufKind !== kind) {
      emitBuf();
      bufKind = kind;
    }
    buf += text;
  }

  return {
    reset(): void {
      buf = "";
      bufKind = null;
      hasThought = false;
      hadOutput = false;
      mediaFiles.length = 0;
    },
    getText(): string {
      return buf;
    },
    /** Whether any text was flushed via onFlush since the last reset. */
    hasOutput(): boolean {
      return hadOutput;
    },
    /** Replace the flush callback — called by dispatch on each new message. */
    setOnFlush(fn: (text: string) => void): void {
      onFlush = fn;
    },
    /** Force-flush any remaining buffered text. */
    flush(): void {
      emitBuf();
    },
    getMediaFiles(): unknown[] {
      return mediaFiles;
    },

    /** Snapshot the current session metadata (mode, model, title, etc.). */
    getMeta(): SessionMeta {
      return {
        currentModeId,
        sessionTitle,
        configOptions: Array.from(configOptionMap.entries()).map(([name, currentValue]) => ({ name, currentValue })),
      };
    },

    /** Route the session update to the appropriate aggregator. */
    onUpdate(update: SessionUpdate): void {
      if (!update) return;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          if (!hasThought) break;
          if (update.content?.type === "text") append("message", update.content.text);
          break;
        }
        case "agent_thought_chunk": {
          if (update.content?.type === "text") append("thought", update.content.text);
          hasThought = true;
          break;
        }
        case "tool_call_update": {
          // Skip — tool output is not shown to the user
          break;
        }
        case "tool_call": {
          emitBuf();
          bufKind = null;
          onFlush(`🔧 正在使用工具：${update.title}`);
          break;
        }
        case "current_mode_update": {
          currentModeId = update.currentModeId;
          break;
        }
        case "session_info_update": {
          if (update.title !== undefined) sessionTitle = update.title;
          break;
        }
        case "config_option_update": {
          for (const opt of update.configOptions) {
            configOptionMap.set(opt.name, formatConfigValue(opt));
          }
          break;
        }
        case "available_commands_update":
        case "user_message_chunk":
        case "plan":
        case "usage_update":
        default:
          break;
      }
    },
  };
}

/** Extract a human-readable current value from a SessionConfigOption. */
function formatConfigValue(opt: SessionConfigOption): string {
  if (opt.type === "boolean") return opt.currentValue ? "on" : "off";
  return String(opt.currentValue);
}
