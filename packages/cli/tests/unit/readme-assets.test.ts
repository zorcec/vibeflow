import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the README demo image that sat broken on npmjs.com:
 * GitHub and npm render README markdown through camo, which rejects any upstream
 * response longer than CAMO_LENGTH_LIMIT (5242880 B) with `404 Content length
 * exceeded`. Nothing in the CLI's own tests or `npm pack` can see that, so these
 * tests exercise the guard that can: scripts/check-readme-assets.mjs.
 */
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(PACKAGE_DIR, "scripts", "check-readme-assets.mjs");
const README = path.join(PACKAGE_DIR, "README.md");
const CAMO_LIMIT_BYTES = 5_242_880;

type ScriptResult = { status: number; stdout: string; stderr: string; json: any };

/**
 * Async on purpose: the fixture server below runs on this worker's event loop, so
 * a blocking spawnSync would starve it and every probe would time out.
 */
function runScript(args: string[]): Promise<ScriptResult> {
  return new Promise((resolve) => {
    execFile("node", [SCRIPT, ...args], { cwd: PACKAGE_DIR, encoding: "utf8" }, (error, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      const status = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ status, stdout, stderr, json });
    });
  });
}

let server: Server;
let origin = "";
let tmpDir = "";

/** HEAD/GET with a declared image size, so nothing large is ever actually sent. */
function serveSize(bytes: number) {
  return (_req: unknown, res: any) => {
    res.writeHead(200, { "content-type": "image/gif", "content-length": String(bytes) });
    res.end();
  };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "readme-assets-"));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/small.gif") return serveSize(1024)(req, res);
    if (url.pathname === "/big.gif") return serveSize(7_419_132)(req, res);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function writeReadme(name: string, body: string): string {
  const file = path.join(tmpDir, name);
  writeFileSync(file, body);
  return file;
}

describe("check-readme-assets — the real README", () => {
  it("references only absolute https images (no relative paths, no http)", async () => {
    const { status, json } = await runScript(["--readme", README, "--skip-pack", "--json"]);
    expect(json, "expected JSON output").toBeTruthy();
    expect(json.assets.images.length).toBeGreaterThanOrEqual(2);
    for (const image of json.assets.images) {
      expect(image.kind, `${image.url} should be a remote https asset`).toBe("remote");
    }
    expect(status).toBe(0);
  });

  it("documents both README image slots with distinct files", async () => {
    const { json } = await runScript(["--readme", README, "--skip-pack", "--json"]);
    const urls = json.assets.images.map((i: { url: string }) => i.url);
    expect(new Set(urls).size, "the same demo file in both slots is the bug this guards").toBe(urls.length);
  });
});

describe("check-readme-assets — size guard", () => {
  it("fails when an image is above camo's content-length limit", async () => {
    const readme = writeReadme("big.md", `# x\n\n![demo](${origin}/big.gif)\n`);
    const { status, json } = await runScript(["--readme", readme, "--online", "--allow-http", "--skip-pack", "--json"]);
    expect(status).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.assets.errors.join(" ")).toContain(String(CAMO_LIMIT_BYTES));
    expect(json.assets.images[0].contentLength).toBe(7_419_132);
  });

  it("passes when the image is comfortably under the limit", async () => {
    const readme = writeReadme("small.md", `# x\n\n![demo](${origin}/small.gif)\n`);
    const { status, json } = await runScript(["--readme", readme, "--online", "--allow-http", "--skip-pack", "--json"]);
    expect(status).toBe(0);
    expect(json.assets.errors).toEqual([]);
  });

  it("fails on a relative image path, which npm cannot resolve", async () => {
    const readme = writeReadme("relative.md", "# x\n\n![demo](docs/demo/showcase.gif)\n");
    const { status, json } = await runScript(["--readme", readme, "--skip-pack", "--json"]);
    expect(status).toBe(1);
    expect(json.assets.errors.join(" ")).toContain("relative path");
  });

  it("fails on a plain http image", async () => {
    const readme = writeReadme("insecure.md", "# x\n\n![demo](http://example.com/demo.gif)\n");
    const { status, json } = await runScript(["--readme", readme, "--skip-pack", "--json"]);
    expect(status).toBe(1);
    expect(json.assets.errors.join(" ")).toContain("https");
  });

  it("fails on a protocol-relative image URL", async () => {
    const readme = writeReadme("protocol-relative.md", "# x\n\n![demo](//example.com/demo.gif)\n");
    const { status, json } = await runScript(["--readme", readme, "--skip-pack", "--json"]);
    expect(status).toBe(1);
    expect(json.assets.errors.join(" ")).toContain("protocol-relative");
  });

  it("parses HTML img tags as well as markdown images", async () => {
    const readme = writeReadme("html.md", `<img src="${origin}/small.gif" width="200" />\n`);
    const { json, status } = await runScript(["--readme", readme, "--online", "--allow-http", "--skip-pack", "--json"]);
    expect(json.assets.images).toHaveLength(1);
    expect(json.assets.images[0].syntax).toBe("html");
    expect(status).toBe(0);
  });
});

describe("check-readme-assets — package size guard", () => {
  const writePack = (name: string, payload: unknown) => {
    const file = path.join(tmpDir, name);
    writeFileSync(file, JSON.stringify(Array.isArray(payload) ? payload : [payload]));
    return file;
  };

  it("passes a tarball made of ordinary dist files", async () => {
    const pack = writePack("pack-ok.json", {
      size: 1_078_950,
      unpackedSize: 3_729_218,
      entryCount: 2,
      files: [
        { path: "dist/index.js", size: 866_000 },
        { path: "README.md", size: 12_000 },
      ],
    });
    const { status, json } = await runScript(["--readme", README, "--pack-json", pack, "--json"]);
    expect(status).toBe(0);
    expect(json.pack.errors).toEqual([]);
  });

  it("fails when demo media sneaks back into the tarball", async () => {
    const pack = writePack("pack-media.json", {
      size: 28_100_000,
      unpackedSize: 31_000_000,
      entryCount: 3,
      files: [
        { path: "dist/index.js", size: 866_000 },
        { path: "docs/demo/showcase.gif", size: 7_419_132 },
      ],
    });
    const { status, json } = await runScript(["--readme", README, "--pack-json", pack, "--json"]);
    expect(status).toBe(1);
    expect(json.pack.errors.join(" ")).toContain("demo media");
    expect(json.pack.errors.join(" ")).toContain("budget");
  });

  it("fails when a single shipped file grows past its budget", async () => {
    const pack = writePack("pack-fat-file.json", {
      size: 2_000_000,
      unpackedSize: 4_000_000,
      entryCount: 1,
      files: [{ path: "dist/chunk-huge.js", size: 4_500_000 }],
    });
    const { status, json } = await runScript(["--readme", README, "--pack-json", pack, "--json"]);
    expect(status).toBe(1);
    expect(json.pack.errors.join(" ")).toContain("dist/chunk-huge.js");
  });
});
