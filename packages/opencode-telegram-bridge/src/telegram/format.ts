/**
 * Telegram message formatting — converts markdown to MarkdownV2 and handles splitting.
 *
 * MarkdownV2 requires escaping these characters in non-code areas:
 * _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 */

const MAX_MSG_LENGTH = 4096;

/** Characters that must be escaped in MarkdownV2 (outside code/link elements) */
const MDV2_ESCAPE_RE = /([_*\[\]()~`>#+=|{}.!\\-])/g;

/**
 * Format opencode markdown response for Telegram MarkdownV2.
 * Handles code blocks, inline code, bold, strikethrough, and links.
 */
export function formatForTelegram(text: string): string {
  if (!text) return "";

  const parts = text.split(/(```[\s\S]*?```)/g);

  return parts
    .map((part) => {
      if (part.startsWith("```") && part.endsWith("```")) {
        return part;
      }

      let formatted = part;
      formatted = formatted.replace(/\*\*(.+?)\*\*/g, "*$1*");
      formatted = formatted.replace(/__(.+?)__/g, "<u>$1</u>");
      formatted = formatted.replace(/~~(.+?)~~/g, "~$1~");
      formatted = formatSegments(formatted);

      return formatted;
    })
    .join("");
}

function formatSegments(text: string): string {
  const tokens = text.split(/(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|~[^~]+~|<u>[^<]+<\/u>)/g);

  return tokens
    .map((token) => {
      if (token.startsWith("`") && token.endsWith("`")) return token;
      if (token.startsWith("[")) {
        const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          const linkText = linkMatch[1].replace(MDV2_ESCAPE_RE, "\\$1");
          return `[${linkText}](${linkMatch[2]})`;
        }
      }
      if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
        const inner = token.slice(1, -1).replace(MDV2_ESCAPE_RE, "\\$1");
        return `*${inner}*`;
      }
      if (token.startsWith("~") && token.endsWith("~") && token.length > 2) {
        const inner = token.slice(1, -1).replace(MDV2_ESCAPE_RE, "\\$1");
        return `~${inner}~`;
      }
      if (token.startsWith("<u>") && token.endsWith("</u>")) {
        const inner = token.slice(3, -4).replace(MDV2_ESCAPE_RE, "\\$1");
        return `<u>${inner}</u>`;
      }
      return token.replace(MDV2_ESCAPE_RE, "\\$1");
    })
    .join("");
}

/**
 * Split a message into chunks that fit Telegram's 4096 char limit.
 * Splits at natural boundaries (double newlines, single newlines, spaces).
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = -1;

    const doubleNl = remaining.lastIndexOf("\n\n", MAX_MSG_LENGTH);
    if (doubleNl > MAX_MSG_LENGTH * 0.5) {
      splitIdx = doubleNl + 2;
    }

    if (splitIdx === -1) {
      const singleNl = remaining.lastIndexOf("\n", MAX_MSG_LENGTH);
      if (singleNl > MAX_MSG_LENGTH * 0.5) {
        splitIdx = singleNl + 1;
      }
    }

    if (splitIdx === -1) {
      const space = remaining.lastIndexOf(" ", MAX_MSG_LENGTH);
      if (space > MAX_MSG_LENGTH * 0.5) {
        splitIdx = space + 1;
      }
    }

    if (splitIdx === -1) {
      splitIdx = MAX_MSG_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  return chunks;
}
