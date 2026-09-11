import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";

const historiesUrl = new URL(
  "../fixtures/temporal/recommendation-pool-v2/",
  import.meta.url,
);
const workflowsPath = fileURLToPath(
  new URL(
    "../../src/modules/backlinks/workflows/definitions/index.ts",
    import.meta.url,
  ),
);

describe("recommendation pool V2 Temporal replay contract", () => {
  it("replays every captured recommendation-pool V2 history", async () => {
    const historyFiles = (
      await readdir(historiesUrl).catch(() => [] as string[])
    )
      .filter((file) => file.endsWith(".json"))
      .sort();

    expect(
      historyFiles,
      "Capture at least one active V2 workflow history before changing control flow.",
    ).not.toHaveLength(0);

    for (const historyFile of historyFiles) {
      const history = JSON.parse(
        await readFile(new URL(historyFile, historiesUrl), "utf8"),
      ) as Record<string, unknown>;
      await Worker.runReplayHistory({ workflowsPath }, history);
    }
  }, 30_000);
});
