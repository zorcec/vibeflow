/**
 * MCP Auth Middleware
 *
 * For local mode: loopback-only by default.
 * For SaaS: validates Bearer token from ~/.vibeflow/auth.json.
 */
import type { Request, Response, NextFunction } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Reads the CLI auth token from ~/.vibeflow/auth.json.
 * No caching — per-request readFileSync of a small file is negligible,
 * and avoids stale-token issues after `vibeflow login`.
 */
function readAuthToken(): string | null {
  try {
    const authPath = join(homedir(), ".vibeflow", "auth.json");
    if (!existsSync(authPath)) return null;
    const content = readFileSync(authPath, "utf-8");
    const auth = JSON.parse(content) as { token?: string };
    return auth.token ?? null;
  } catch {
    return null;
  }
}

/** Constant-time token comparison via SHA-256 digest. */
function tokensEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * MCP auth middleware.
 * - If no token is configured (local mode), allows loopback requests only.
 * - If a token is configured, validates Bearer token from Authorization header.
 */
export function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  // Check if request is from loopback
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  const isLoopback =
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1";

  const token = readAuthToken();

  if (!token) {
    // No token configured: allow loopback only
    if (isLoopback) {
      next();
      return;
    }
    res.status(401).json({
      error: "Unauthorized",
      message: "MCP requires authentication for non-loopback connections",
    });
    return;
  }

  // Token configured: validate Bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Missing or invalid Authorization header",
    });
    return;
  }

  const providedToken = authHeader.slice(7);
  if (!tokensEqual(providedToken, token)) {
    res.status(403).json({
      error: "Forbidden",
      message: "Invalid authentication token",
    });
    return;
  }

  next();
}
