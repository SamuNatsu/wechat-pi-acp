/**
 * Format a byte count as a human-readable string (e.g. "1.5 MB").
 * Uses binary prefixes: B, KB, MB, GB.
 */
export function humanizeSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx++;
  }
  return `${size.toFixed(unitIdx === 0 ? 0 : 1)} ${units[unitIdx]}`;
}

/**
 * Escape a string so it renders as plain text inside a markdown table cell.
 * Backslash-escapes all markdown special characters (| * _ ` [ ] etc.) and
 * replaces newlines with spaces so the output displays exactly as-is with no
 * unintentional formatting.
 */
export function escape(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|~])/g, "\\$1").replace(/\n/g, " ");
}

/**
 * Split a string into chunks of at most maxLen characters.
 * Splits at paragraph boundaries, then line boundaries outside code blocks,
 * and finally word boundaries — avoiding broken markdown structures.
 * Used to stay within WeChat's ~4000-character message limit.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const blocks = tokenizeBlocks(text);
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    if (current && current.length + block.length + 1 > maxLen) {
      chunks.push(current.trimEnd());
      current = "";
    }

    if (block.length > maxLen) {
      for (const line of splitLongBlock(block, maxLen)) {
        if (current && current.length + line.length + 1 > maxLen) {
          chunks.push(current.trimEnd());
          current = line.trimStart();
        } else {
          current += (current ? "\n" : "") + line;
        }
      }
    } else {
      current += (current ? "\n" : "") + block;
    }
  }

  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

/**
 * Tokenize markdown text into logical blocks. Fenced code blocks (```...```)
 * are kept intact as a single block. Everything else is split at double-newline
 * paragraph boundaries.
 */
function tokenizeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");
  let buf = "";
  let fenceMarker: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!fenceMarker && /^(```|~~~)/.test(trimmed)) {
      if (buf) {
        blocks.push(buf.trimEnd());
        buf = "";
      }
      fenceMarker = trimmed.startsWith("```") ? "```" : "~~~";
      buf = line;
    } else if (fenceMarker) {
      buf += "\n" + line;
      if (trimmed === fenceMarker) {
        blocks.push(buf.trimEnd());
        buf = "";
        fenceMarker = null;
      }
    } else if (line === "") {
      if (buf) {
        blocks.push(buf.trimEnd());
        buf = "";
      }
    } else {
      buf += (buf ? "\n" : "") + line;
    }
  }

  if (buf) blocks.push(buf.trimEnd());
  return blocks.filter((b) => b.length > 0);
}

/**
 * Split a single block that exceeds maxLen. Tries line boundaries first,
 * then word boundaries. Never splits a line in the middle.
 */
function splitLongBlock(block: string, maxLen: number): string[] {
  const lines = block.split("\n");
  const parts: string[] = [];
  let current = "";

  for (const line of lines) {
    if (current && current.length + line.length + 1 > maxLen) {
      parts.push(current.trimEnd());
      current = "";
    }
    if (line.length > maxLen) {
      // Single line is too long — split at word boundary
      if (current) {
        parts.push(current.trimEnd());
        current = "";
      }
      for (const part of splitLongLine(line, maxLen)) {
        parts.push(part);
      }
    } else {
      current += (current ? "\n" : "") + line;
    }
  }

  if (current) parts.push(current.trimEnd());
  return parts;
}

/**
 * Split a single long line at the last word boundary before maxLen.
 */
function splitLongLine(line: string, maxLen: number): string[] {
  const parts: string[] = [];
  let remaining = line;

  while (remaining.length > maxLen) {
    const spaceAt = remaining.lastIndexOf(" ", maxLen);
    const cut = spaceAt > maxLen / 4 ? spaceAt : maxLen;
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) parts.push(remaining);
  return parts;
}
