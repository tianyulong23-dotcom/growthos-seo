type DatabaseClientEvents = {
  on(event: "error", listener: (error: unknown) => void): unknown;
};

export type DatabasePoolEvents = DatabaseClientEvents & {
  on(event: "connect", listener: (client: DatabaseClientEvents) => void): unknown;
};

export function installDatabaseErrorHandlers(
  pool: DatabasePoolEvents,
  runtimeProcess: "api" | "worker",
  report: (entry: Readonly<Record<string, string>>) => void = console.error,
): void {
  const log = (scope: string) => (_error: unknown): void => {
    report({
      event: "BACKLINKS_DATABASE_CONNECTION_ERROR",
      process: runtimeProcess,
      scope,
    });
  };
  // pg rejects pending queries and discards disconnected clients on release.
  // Listen on checked-out clients as well as the pool (which covers idle ones).
  pool.on("error", log("pool"));
  pool.on("connect", (client) => {
    client.on("error", log("client"));
  });
}
