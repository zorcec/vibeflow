/**
 * MCP stdio transport (model1-mcp plan §W4).
 *
 * An MCP client (Claude Desktop, Cursor, …) spawns `vibeflow mcp --project
 * <dir>` once per project. stdin/stdout are the JSON-RPC channel, so stdout
 * must carry protocol frames ONLY — every human-facing line (the project-root
 * announcement, refusals, notices) belongs on stderr, at the CLI boundary in
 * `src/index.ts`, never in this module.
 *
 * Clean exit: when the client closes stdin the transport's close handler
 * ends the process, so a detached or crashing client never leaves a spawned
 * server behind.
 *
 * Inbound framing is done HERE, not by the SDK (ticket eb77a4df297eb443f3839ce4876939):
 * stdin is split into frames by {@link pumpStdin} and only frames within
 * {@link MAX_INBOUND_FRAME_BYTES} reach the transport, so an oversized frame
 * can be ANSWERED instead of being fatal — see the constant for why.
 */
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

/**
 * Decision (owner rule "unfinished work must FAIL loudly", ticket
 * eb77a4df297eb443f3839ce4876939, 2026-11-20): cap in bytes on ONE inbound
 * JSON-RPC frame. The SDK's ReadBuffer throws at its own 10 MB default, the
 * transport closes on that throw and this module's onclose exits the process —
 * so one oversized frame used to kill the server silently (exit 0, no frame,
 * nothing on stderr) and strand the client. Over the cap the frame is dropped
 * and its request answered with a JSON-RPC error instead: 16 MiB is 4× the old
 * ceiling ≈ a 12 MB file after base64 inflation, which covers the screenshots
 * and reports `attach_file` exists for while bounding one frame's buffer.
 */
export const MAX_INBOUND_FRAME_BYTES = 16 * 1024 * 1024;

/** Bytes of an oversized frame kept back so its request id can still be answered. */
const OVERSIZE_HEAD_BYTES = 8 * 1024;

export async function runStdioMcp(
  projectDir: string,
  mode: "local" | "saas",
): Promise<void> {
  const server = createMcpServer(projectDir, mode);
  // The transport reads THIS stream, never process.stdin directly: pumpStdin
  // owns the framing and can refuse a frame the SDK must never see.
  const inbound = new PassThrough();
  const transport = new StdioServerTransport(inbound, process.stdout, {
    // +1: a frame this module accepts still carries its trailing newline, and
    // the SDK's own limit is `> maxBufferSize` — anything the pump lets through
    // must therefore fit in maxBufferSize + 1, never trip it, never close.
    maxBufferSize: MAX_INBOUND_FRAME_BYTES + 1,
  });
  // stdin EOF (client closed us) → the transport closes; exit explicitly so
  // no lingering handle keeps a spawned per-project process alive.
  transport.onclose = () => {
    process.exit(0);
  };
  await server.connect(transport);
  pumpStdin(inbound, transport);
}

/**
 * Split process.stdin into newline-delimited JSON-RPC frames and hand the
 * ones within the cap to the transport.
 *
 * WHY NOT LET THE SDK READ STDIN: `StdioServerTransport._ondata` reacts to an
 * oversized frame by clearing its read buffer and THROWING, `close()` runs and
 * the onclose above exits the process — a silent death with no answer for the
 * in-flight request, which is exactly the "client waits forever" failure this
 * ticket exists for. Owning the framing turns that into a loud, answered
 * refusal while the session keeps serving.
 *
 * Frames are buffered as chunk slices and concatenated once, on delivery, so
 * a large accepted frame costs one copy rather than one per incoming chunk.
 */
function pumpStdin(
  inbound: PassThrough,
  transport: StdioServerTransport,
): void {
  /** Bytes of the frame currently being assembled (newline included once seen). */
  let parts: Buffer[] = [];
  let buffered = 0;
  /** True while the tail of an oversized frame is being discarded. */
  let dropping = false;
  /** First bytes of the oversized frame — enough to recover its `"id"`. */
  let head: Buffer[] = [];
  let headBytes = 0;

  const keepHead = (...chunks: Buffer[]): void => {
    for (const chunk of chunks) {
      if (headBytes >= OVERSIZE_HEAD_BYTES) return;
      const slice = chunk.subarray(0, OVERSIZE_HEAD_BYTES - headBytes);
      head.push(slice);
      headBytes += slice.length;
    }
  };

  const rejectOversized = (): void => {
    const raw = Buffer.concat(head).toString("utf8");
    head = [];
    headBytes = 0;
    const message =
      `Inbound JSON-RPC frame exceeded ${MAX_INBOUND_FRAME_BYTES} bytes and was dropped — ` +
      `split the payload, or move large bytes out of the tool arguments ` +
      "(attach_file contentB64 → `vibeflow tasks --attach <path>`)";
    // stderr is the human channel: this must be visible even for a client
    // that only ever reads stdout frames.
    process.stderr.write(`✗ ${message}\n`);
    const id = recoverRequestId(raw);
    if (id !== null) {
      transport
        .send({ jsonrpc: "2.0", id, error: { code: -32000, message } })
        .catch(() => {
          /* the client is already gone — nothing left to answer */
        });
    }
  };

  const deliver = (): void => {
    const frame = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    parts = [];
    buffered = 0;
    if (!inbound.write(frame)) process.stdin.pause();
  };

  const consume = (chunk: Buffer): void => {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) break;
      const line = chunk.subarray(start, nl + 1);
      start = nl + 1;
      if (dropping) {
        keepHead(line);
        dropping = false;
        rejectOversized();
        continue;
      }
      if (buffered + line.length > MAX_INBOUND_FRAME_BYTES) {
        keepHead(...parts, line);
        parts = [];
        buffered = 0;
        rejectOversized();
        continue;
      }
      parts.push(line);
      buffered += line.length;
      deliver();
    }
    const rest = chunk.subarray(start);
    if (rest.length === 0) return;
    if (dropping) {
      keepHead(rest);
      return;
    }
    if (buffered + rest.length > MAX_INBOUND_FRAME_BYTES) {
      // Over the cap but not yet terminated: keep the head for the id, drop
      // the rest, and wait for the newline that ends this frame.
      keepHead(...parts, rest);
      parts = [];
      buffered = 0;
      dropping = true;
      return;
    }
    parts.push(rest);
    buffered += rest.length;
  };

  inbound.on("drain", () => process.stdin.resume());
  // The transport installs its own handlers on `inbound`, never on
  // process.stdin — an unhandled 'error' event on stdin would throw and take
  // the server down, so the broken-channel case is answered here.
  process.stdin.on("error", (error: Error) => {
    process.stderr.write(`✗ mcp stdin error: ${error.message}\n`);
    process.exit(0);
  });
  process.stdin.on("data", consume);
}

/**
 * Pull the JSON-RPC request id out of the first bytes of a frame too large to
 * keep. The id travels near the front of any `{"jsonrpc":"2.0","id":…,…}`
 * request, so the 8 KB head is enough; null means "no id to answer" (a
 * notification, or an id the head never reached) and the caller only logs.
 */
function recoverRequestId(raw: string): string | number | null {
  const match = raw.match(/"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")/);
  if (!match) return null;
  if (match[1].startsWith('"')) {
    try {
      return JSON.parse(match[1]) as string;
    } catch {
      return null;
    }
  }
  return Number(match[1]);
}
