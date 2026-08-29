/** Semantic CLI exit codes following POSIX conventions. */
export const ExitCode = {
  /** Success */
  SUCCESS: 0,
  /** General/unexpected error */
  GENERAL: 1,
  /** Usage or argument error (missing flags, invalid values) */
  USAGE: 2,
  /** Not found (task, comment, file missing) */
  NOT_FOUND: 3,
  /** Auth failure (login required, token invalid) */
  AUTH: 4,
  /** Conflict (already exists, version mismatch) */
  CONFLICT: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
