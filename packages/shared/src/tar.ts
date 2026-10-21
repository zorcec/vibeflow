/**
 * Barrel for the in-repo ustar (POSIX tar) codec: writer + reader in ONE place.
 *
 * The writer builds export archives; the reader unpacks them. Keeping both
 * behind this subpath guarantees the two sides can never drift apart.
 *
 * Deliberately NOT re-exported from `./index`: the reader imports
 * `node:stream`, and the shared barrel is imported by browser bundles.
 */
export * from "./tar-read";
export * from "./tar-write";
