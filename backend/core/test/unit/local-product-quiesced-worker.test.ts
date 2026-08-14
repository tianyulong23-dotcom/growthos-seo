import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  resolveWorkerExecutionMode,
} from "../../scripts/local-product-quiesced-worker.mjs";

const quiescedWorkerSource = readFileSync(
  new URL("../../scripts/local-product-quiesced-worker.mjs", import.meta.url),
  "utf8",
);
const processSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Invoke-LocalProductProcess.ps1",
    import.meta.url,
  ),
  "utf8",
);
const startSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Start-GrowthOS-LocalProduct.ps1",
    import.meta.url,
  ),
  "utf8",
);
const statusSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Status-GrowthOS-LocalProduct.ps1",
    import.meta.url,
  ),
  "utf8",
);
const quiescedStartIndex = startSource.indexOf(
  'if ($WorkerExecutionMode -eq "quiesced")',
);
const quiescedStartSource = startSource.slice(
  quiescedStartIndex,
  startSource.indexOf("Invoke-LocalProductAlembicUpgrade", quiescedStartIndex),
);
const maintenanceStatusSource = statusSource.slice(
  statusSource.indexOf("$maintenanceReady = ("),
  statusSource.indexOf("$result = [pscustomobject]"),
);

describe("LOCAL_PRODUCT quiesced Worker", () => {
  it("defaults to the existing normal mode", () => {
    expect(resolveWorkerExecutionMode({
      BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT",
    })).toBe("normal");
    expect(processSource).toContain('@("dist/index.js", "worker")');
  });

  it("allows quiesced mode only for LOCAL_PRODUCT", () => {
    expect(resolveWorkerExecutionMode({
      BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT",
      BACKLINKS_WORKER_EXECUTION_MODE: "quiesced",
    })).toBe("quiesced");
    expect(() => resolveWorkerExecutionMode({
      BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT_ACCEPTANCE",
      BACKLINKS_WORKER_EXECUTION_MODE: "quiesced",
    })).toThrow("BACKLINKS_WORKER_QUIESCED_MODE_REQUIRES_LOCAL_PRODUCT");
    expect(() => resolveWorkerExecutionMode({
      BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT",
      BACKLINKS_WORKER_EXECUTION_MODE: "paused",
    })).toThrow("BACKLINKS_WORKER_EXECUTION_MODE_UNSUPPORTED");
  });

  it("loads production composition without starting business consumers", () => {
    expect(quiescedWorkerSource).toContain(
      "await runtime.createWorkerRegistrations",
    );
    expect(quiescedWorkerSource).not.toContain("startBacklinksWorker");
    expect(quiescedWorkerSource).not.toContain("backgroundService.start");
    expect(quiescedWorkerSource).not.toContain("worker.run");
    expect(quiescedWorkerSource).toContain(
      "const keepAlive = setInterval",
    );
    expect(quiescedWorkerSource).toContain("clearInterval(keepAlive)");
    expect(quiescedWorkerSource).toContain(
      'businessConsumersRunning: false',
    );
  });

  it("reports build and infrastructure readiness in maintenance status", () => {
    expect(quiescedWorkerSource).toContain(
      "assertLocalProductRuntimeBuildIdentity",
    );
    expect(quiescedWorkerSource).toContain("postgresReady: true");
    expect(quiescedWorkerSource).toContain("temporalReady: true");
    expect(startSource).toContain(
      '$WorkerExecutionMode -eq "quiesced"',
    );
    expect(startSource).toContain(
      'if ($finalStatus.status -eq "maintenance_ready")',
    );
    expect(statusSource).toContain("apiBuildId = $apiBuildId");
    expect(statusSource).toContain("workerBuildId = $workerBuildId");
    expect(statusSource).toContain(
      "workerExecutionMode = $workerExecutionMode",
    );
    expect(statusSource).toContain(
      "businessConsumersRunning = $businessConsumersRunning",
    );
    expect(statusSource).toContain("postgresReady = $postgresReady");
    expect(statusSource).toContain("temporalReady = $temporalReady");
  });

  it("keeps the user-facing stack available without business consumers", () => {
    expect(quiescedStartSource).toContain(
      '$state.fastApiGroupPid = Start-Component',
    );
    expect(quiescedStartSource).toContain(
      '$state.frontendGroupPid = Start-Component',
    );
    expect(quiescedStartSource).toContain(
      'Wait-HttpReady "http://127.0.0.1:7200/ready"',
    );
    expect(quiescedStartSource).toContain(
      'Wait-HttpAvailable "http://127.0.0.1:5173"',
    );
    expect(quiescedStartSource).toContain("if ($EnableBrowser)");
    expect(quiescedStartSource).toContain(
      '$state.browserGroupPid = Start-Component',
    );
    expect(maintenanceStatusSource).toContain(
      "$processes.fastApi.running",
    );
    expect(maintenanceStatusSource).toContain(
      "$processes.frontend.running",
    );
    expect(maintenanceStatusSource).toContain(
      "$fastApiStatus -eq 200",
    );
    expect(maintenanceStatusSource).toContain(
      "$frontendStatus -eq 200",
    );
    expect(maintenanceStatusSource).not.toContain(
      "-not $processes.fastApi.running",
    );
    expect(maintenanceStatusSource).not.toContain(
      "-not $processes.frontend.running",
    );
  });
});
