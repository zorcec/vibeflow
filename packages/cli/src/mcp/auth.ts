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

// Token cache for performance
let cachedToken: string | null = null;
let tokenCacheTime = 0;
const TOKEN_CACHE_TTL = 30_000; // 30 seconds

/**
 * Reads the CLI auth token from ~/.vibeflow/auth.json
 */
function readAuthToken(): string | null {
  const now = Date.now();
  if (cachedToken && now - tokenCacheTime < TOKEN_CACHE_TTL) {
    return cachedToken;
  }

  try {
    const authPath = join(homedir(), ".vibeflow", "auth.json");
    if (!existsSync(authPath)) return null;
    const content = readFileSync(authPath, "utf-8");
    const auth = JSON.parse(content) as { token?: string };
    cachedToken = auth.token ?? null;
    tokenCacheTime = now;
    return cachedToken;
  } catch {
    return null;
  }
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
    ip === "::ffff:127.0.0.1" ||
    ip.includes("localhost");

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
  if (providedToken !== token) {
    res.status(403).json({
      error: "Forbidden",
      message: "Invalid authentication token",
    });
    return;
  }

  next();
}
