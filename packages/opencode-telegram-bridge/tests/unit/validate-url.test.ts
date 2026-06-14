import { describe, it, expect } from "vitest";
import { validateUrl } from "../../src/validate-url.js";

describe("validateUrl", () => {
  // ── Valid URLs ────────────────────────────────────────────────────────────

  it("allows http URLs", () => {
    expect(() => validateUrl("http://example.com", "TEST")).not.toThrow();
  });

  it("allows https URLs", () => {
    expect(() => validateUrl("https://example.com", "TEST")).not.toThrow();
  });

  it("allows localhost (for local dev)", () => {
    expect(() => validateUrl("http://localhost:9001", "TEST")).not.toThrow();
  });

  it("allows localhost with https", () => {
    expect(() => validateUrl("https://localhost:8443", "TEST")).not.toThrow();
  });

  // ── Invalid protocols ─────────────────────────────────────────────────────

  it("blocks ftp protocol", () => {
    expect(() => validateUrl("ftp://example.com", "TEST")).toThrow("not allowed");
  });

  it("blocks file protocol", () => {
    expect(() => validateUrl("file:///etc/passwd", "TEST")).toThrow("not allowed");
  });

  it("blocks javascript protocol", () => {
    expect(() => validateUrl("javascript:alert(1)", "TEST")).toThrow("not allowed");
  });

  it("blocks data protocol", () => {
    expect(() => validateUrl("data:text/html,<h1>hi</h1>", "TEST")).toThrow("not allowed");
  });

  // ── Invalid URLs ──────────────────────────────────────────────────────────

  it("blocks invalid URLs", () => {
    expect(() => validateUrl("not-a-url", "TEST")).toThrow("not a valid URL");
  });

  it("blocks empty string", () => {
    expect(() => validateUrl("", "TEST")).toThrow("not a valid URL");
  });

  // ── Cloud metadata endpoints ──────────────────────────────────────────────

  it("blocks AWS metadata endpoint", () => {
    expect(() => validateUrl("http://169.254.169.254/latest/meta-data/", "TEST")).toThrow("not allowed");
  });

  it("blocks Google metadata endpoint", () => {
    expect(() => validateUrl("http://metadata.google.internal/computeMetadata/v1/", "TEST")).toThrow("not allowed");
  });

  it("blocks instance-data endpoint", () => {
    expect(() => validateUrl("http://instance-data/latest/meta-data/", "TEST")).toThrow("not allowed");
  });

  // ── IPv4 private ranges ───────────────────────────────────────────────────

  it("blocks 10.x.x.x (private Class A)", () => {
    expect(() => validateUrl("http://10.0.0.1:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks 10.255.255.255 (private Class A)", () => {
    expect(() => validateUrl("http://10.255.255.255:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks 172.16.0.1 (private Class B start)", () => {
    expect(() => validateUrl("http://172.16.0.1:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks 172.31.255.255 (private Class B end)", () => {
    expect(() => validateUrl("http://172.31.255.255:8080", "TEST")).toThrow("private/reserved");
  });

  it("allows 172.15.255.255 (just below private range)", () => {
    expect(() => validateUrl("http://172.15.255.255:8080", "TEST")).not.toThrow();
  });

  it("allows 172.32.0.1 (just above private range)", () => {
    expect(() => validateUrl("http://172.32.0.1:8080", "TEST")).not.toThrow();
  });

  it("blocks 192.168.0.1 (private Class C)", () => {
    expect(() => validateUrl("http://192.168.0.1:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks 192.168.255.255 (private Class C)", () => {
    expect(() => validateUrl("http://192.168.255.255:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks 127.0.0.1 (loopback)", () => {
    expect(() => validateUrl("http://127.0.0.1:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks 127.255.255.255 (loopback)", () => {
    expect(() => validateUrl("http://127.255.255.255:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks 0.0.0.0 (current network)", () => {
    expect(() => validateUrl("http://0.0.0.0:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks 169.254.0.1 (link-local)", () => {
    expect(() => validateUrl("http://169.254.0.1:8080", "TEST")).toThrow("private/reserved");
  });

  it("allows 8.8.8.8 (public DNS)", () => {
    expect(() => validateUrl("http://8.8.8.8:8080", "TEST")).not.toThrow();
  });

  it("allows 1.1.1.1 (public DNS)", () => {
    expect(() => validateUrl("http://1.1.1.1:8080", "TEST")).not.toThrow();
  });

  // ── IPv6 private ranges ───────────────────────────────────────────────────

  it("blocks ::1 (IPv6 loopback)", () => {
    expect(() => validateUrl("http://[::1]:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks :: (IPv6 unspecified)", () => {
    expect(() => validateUrl("http://[::]:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks fc00::1 (IPv6 ULA)", () => {
    expect(() => validateUrl("http://[fc00::1]:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks fd00::1 (IPv6 ULA)", () => {
    expect(() => validateUrl("http://[fd00::1]:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks fe80::1 (IPv6 link-local)", () => {
    expect(() => validateUrl("http://[fe80::1]:8080", "TEST")).toThrow("private/reserved");
  });

  it("blocks ::ffff:127.0.0.1 (IPv4-mapped IPv6 loopback)", () => {
    expect(() => validateUrl("http://[::ffff:127.0.0.1]:8080", "TEST")).toThrow("private/reserved");
  });

  it("allows 2001:db8::1 (IPv6 documentation range, not blocked)", () => {
    expect(() => validateUrl("http://[2001:db8::1]:8080", "TEST")).not.toThrow();
  });

  it("allows 2606:4700::1 (Cloudflare, public)", () => {
    expect(() => validateUrl("http://[2606:4700::1]:8080", "TEST")).not.toThrow();
  });

  // ── Error label ───────────────────────────────────────────────────────────

  it("includes label in error message", () => {
    expect(() => validateUrl("ftp://x", "SENSEVOICE_URL")).toThrow("SENSEVOICE_URL");
  });
});
