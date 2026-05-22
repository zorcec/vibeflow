/**
 * error-recorder — intercepts console.error / console.warn and global error events,
 * stores up to MAX_ENTRIES in a ring buffer.
 *
 * When the user submits a Bug report, call getRecordedLogs() to append the
 * captured entries to the task description.
 */

const MAX_ENTRIES = 50;
const IGNORED_PATTERNS: RegExp[] = [
  /Error evaluating Node\.js code/i,
  /nextjs-portal/i,
];

interface LogEntry {
  level: 'error' | 'warn';
  message: string;
  timestamp: string;
}

const buffer: LogEntry[] = [];
let recording = false;

function addEntry(level: LogEntry['level'], args: unknown[]): void {
  const message = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ')
    .slice(0, 500);

  if (!message || IGNORED_PATTERNS.some((pattern) => pattern.test(message))) return;

  buffer.push({ level, message, timestamp: new Date().toISOString() });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
}

/** Start intercepting console.error, console.warn, and global errors.
 *  Safe to call multiple times — only starts recording once. */
export function startRecording(): void {
  if (recording) return;
  recording = true;

  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    addEntry('error', args);
    origError(...args);
  };

  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    addEntry('warn', args);
    origWarn(...args);
  };

  window.addEventListener('error', (e: ErrorEvent) => {
    const loc = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '';
    addEntry('error', [`${e.message}${loc}`]);
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const msg =
      e.reason instanceof Error
        ? e.reason.message
        : String(e.reason ?? 'Unhandled promise rejection');
    addEntry('error', [`Unhandled rejection: ${msg}`]);
  });
}

/** Returns a markdown-formatted string of the captured log entries,
 *  or an empty string when nothing was recorded. */
export function getRecordedLogs(): string {
  if (buffer.length === 0) return '';

  const lines = buffer.map((e) => {
    const icon = e.level === 'error' ? '🔴' : '🟡';
    const time = e.timestamp.slice(11, 19); // HH:MM:SS
    return `- ${icon} \`${time}\` ${e.message}`;
  });

  return `\n\n---\n**Console logs** (${buffer.length} entr${buffer.length === 1 ? 'y' : 'ies'})\n${lines.join('\n')}`;
}
