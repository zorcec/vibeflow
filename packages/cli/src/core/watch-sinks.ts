import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WatchEvent } from "./watch-events.js";

export type SinkFactory = (sink: WatchSink) => void;

export interface WatchSink {
  emit(event: WatchEvent): void;
  close?(): void;
}

/** JSONL to stdout. */
export function stdoutJsonSink(): WatchSink {
  return {
    emit(event: WatchEvent) {
      process.stdout.write(JSON.stringify(event) + "\n");
    },
  };
}

/** Append JSONL to a file. */
export function fileSink(path: string): WatchSink {
  return {
    emit(event: WatchEvent) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
      } catch (err) {
        console.error("[watch] Failed to write to file:", path, err);
      }
    },
  };
}

/** POST each event to a webhook URL. Fire-and-forget with 1 retry. */
export function webhookSink(url: string): WatchSink {
  return {
    emit(event: WatchEvent) {
      postWebhook(url, event, 1).catch((err) => {
        console.error("[watch] Webhook failed:", err?.message ?? err);
      });
    },
  };
}

async function postWebhook(
  url: string,
  event: WatchEvent,
  retriesLeft: number,
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok && retriesLeft > 0) {
      await postWebhook(url, event, retriesLeft - 1);
    }
  } catch (err) {
    if (retriesLeft > 0) {
      await postWebhook(url, event, retriesLeft - 1);
    } else {
      throw err;
    }
  }
}

/**
 * Create a composite sink that fans out to all requested sinks.
 * Sinks are optional; if none are provided, no events are emitted (--once with no sink is a no-op).
 */
export function createSink(opts: {
  json?: boolean;
  output?: string;
  webhook?: string;
}): WatchSink {
  const sinks: WatchSink[] = [];

  if (opts.json) {
    sinks.push(stdoutJsonSink());
  }

  if (opts.output) {
    sinks.push(fileSink(opts.output));
  }

  if (opts.webhook) {
    sinks.push(webhookSink(opts.webhook));
  }

  // If no sinks specified, use stdout as default
  if (sinks.length === 0) {
    sinks.push(stdoutJsonSink());
  }

  return {
    emit(event: WatchEvent) {
      for (const sink of sinks) {
        sink.emit(event);
      }
    },
    close() {
      for (const sink of sinks) {
        sink.close?.();
      }
    },
  };
}
