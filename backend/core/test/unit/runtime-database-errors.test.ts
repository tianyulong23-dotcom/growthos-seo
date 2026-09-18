import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { installDatabaseErrorHandlers } from "../../src/runtime-database-errors.js";

describe("database connection error boundary", () => {
  it.each(["api", "worker"] as const)(
    "handles idle and checked-out connection errors in %s without leaking data",
    (mode) => {
      const pool = new EventEmitter();
      const client = new EventEmitter();
      const report = vi.fn();
      installDatabaseErrorHandlers(pool, mode, report);
      pool.emit("connect", client);

      const error = new Error("Connection lost: secret connection string");
      expect(() => client.emit("error", error)).not.toThrow();
      expect(() => pool.emit("error", error, client)).not.toThrow();
      expect(report.mock.calls).toEqual([
        [{ event: "BACKLINKS_DATABASE_CONNECTION_ERROR", process: mode, scope: "client" }],
        [{ event: "BACKLINKS_DATABASE_CONNECTION_ERROR", process: mode, scope: "pool" }],
      ]);
      expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
    },
  );

  it("attaches handlers to replacement connections without removing other listeners", () => {
    const pool = new EventEmitter();
    const existing = vi.fn();
    pool.on("error", existing);
    installDatabaseErrorHandlers(pool, "worker", vi.fn());
    for (let i = 0; i < 2; i += 1) {
      const client = new EventEmitter();
      pool.emit("connect", client);
      expect(() => client.emit("error", new Error("Disconnected"))).not.toThrow();
    }
    pool.emit("error", new Error("Disconnected"));
    expect(existing).toHaveBeenCalledOnce();
  });
});
