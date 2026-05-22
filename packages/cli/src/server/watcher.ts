import { watch, type FSWatcher } from "chokidar";

export interface FileWatcherEvents {
  onChange: (filePath: string) => void;
  onAdd?: (filePath: string) => void;
  onUnlink?: (filePath: string) => void;
}

export function createFileWatcher(
  paths: string | string[],
  events: FileWatcherEvents,
): FSWatcher {
  const watcher = watch(paths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on("change", (filePath) => {
    events.onChange(filePath);
  });

  if (events.onAdd) {
    watcher.on("add", events.onAdd);
  }

  if (events.onUnlink) {
    watcher.on("unlink", events.onUnlink);
  }

  return watcher;
}

/** Watches the .proto/tasks/ directory for external task file changes and
 *  calls the appropriate callback with the file path that changed. */
export function createTaskWatcher(
  tasksDir: string,
  callbacks: {
    onChanged: (filePath: string) => void;
    onDeleted: (filePath: string) => void;
  },
): FSWatcher {
  return createFileWatcher(tasksDir, {
    onChange: callbacks.onChanged,
    onAdd: callbacks.onChanged,
    onUnlink: callbacks.onDeleted,
  });
}
