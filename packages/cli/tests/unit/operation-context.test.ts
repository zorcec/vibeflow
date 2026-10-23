/**
 * Authoritative read-backend resolution (ticket d7b9dc13).
 *
 * The ONE decision that says which store a read is authoritative for — pure
 * in, backend out — shared by the CLI read paths and the local MCP
 * operations. These tests pin the decision itself; the sentinel tests in
 * `remote-task-store.test.ts` and `operations-read-authoritative.test.ts`
 * prove the behaviour it produces.
 *
 * Mutation note: resolving the saas branch to the local adapter (or reading
 * credentials here instead of taking the already-resolved mode) turns every
 * test below red — which is exactly the phantom-record regression.
 */
import { describe, it, expect } from "vitest";
import {
  resolveReadBackend,
  resolveReadPorts,
} from "../../src/core/operation-context.js";
import { localTaskStore } from "../../src/core/task-store.js";
import { remoteTaskStore } from "../../src/core/remote-task-store.js";
import type { OperationContext } from "../../src/core/operations.js";

const localCtx: OperationContext = { projectDir: "/tmp/ctx-local", mode: "local" };
const saasCtx: OperationContext = { projectDir: "/tmp/ctx-saas", mode: "saas" };

describe("resolveReadBackend — the one authoritative-read decision", () => {
  it("local mode reads local", () => {
    expect(resolveReadBackend("local")).toBe("local");
  });

  it("saas mode reads remote (never the local files)", () => {
    expect(resolveReadBackend("saas")).toBe("remote");
  });
});

describe("resolveReadPorts — reads run against the authoritative store", () => {
  it("local ctx resolves to the shared file-backed adapter", () => {
    expect(resolveReadPorts(localCtx).store).toBe(localTaskStore);
  });

  it("saas ctx resolves to the remote read adapter, not the local files", () => {
    expect(resolveReadPorts(saasCtx).store).toBe(remoteTaskStore);
  });

  it("an explicitly injected store wins over the backend decision", () => {
    const fake = { marker: "injected" };
    const ports = resolveReadPorts({
      ...saasCtx,
      store: fake as unknown as OperationContext["store"],
    });
    expect(ports.store).toBe(fake);
  });

  it("artifacts stay local even for remote reads (there is no remote artifact store)", () => {
    expect(resolveReadPorts(saasCtx).artifacts).toBe(localTaskStore);
    expect(resolveReadPorts(localCtx).artifacts).toBe(localTaskStore);
  });
});
