import { randomBytes } from "node:crypto";

import { Connection } from "@temporalio/client";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";

const TEMPORAL_IMAGE =
  "temporalio/temporal:1.8.1@sha256:59561b9ef060eaeb1f46cb6a1842d6cbdd8a393eb3b6d315ecef5fe2f0b1d7a6";
const TEMPORAL_PORT = 7233;
const TEMPORAL_NAMESPACE = "growthos-test";
const EXTERNAL_TEMPORAL_ADDRESS_ENV = "BACKLINKS_TEST_TEMPORAL_ADDRESS";

export type BacklinksTemporalHarness = Readonly<{
  image: string;
  address: string;
  namespace: string;
  stop(): Promise<void>;
}>;

async function startExternalTemporalHarness(
  address: string,
): Promise<BacklinksTemporalHarness> {
  const namespace = `${TEMPORAL_NAMESPACE}-${randomBytes(8).toString("hex")}`;
  const connection = await Connection.connect({ address });
  try {
    await connection.workflowService.registerNamespace({
      namespace,
      workflowExecutionRetentionPeriod: { seconds: 86_400 },
    });
    await connection.workflowService.describeNamespace({ namespace });
  } finally {
    await connection.close();
  }

  let stopped = false;
  return Object.freeze({
    image: "external-temporal",
    address,
    namespace,
    async stop() {
      if (stopped) return;
      stopped = true;
      const cleanup = await Connection.connect({ address });
      try {
        await cleanup.operatorService.deleteNamespace({ namespace });
      } finally {
        await cleanup.close();
      }
    },
  });
}

export async function startBacklinksTemporalHarness(): Promise<BacklinksTemporalHarness> {
  const externalAddress = process.env[EXTERNAL_TEMPORAL_ADDRESS_ENV]?.trim();
  if (externalAddress) {
    return startExternalTemporalHarness(externalAddress);
  }

  let container: StartedTestContainer | undefined;
  try {
    container = await new GenericContainer(TEMPORAL_IMAGE)
      .withCommand([
        "server",
        "start-dev",
        "--ip",
        "0.0.0.0",
        "--headless",
        "--namespace",
        TEMPORAL_NAMESPACE,
      ])
      .withExposedPorts(TEMPORAL_PORT)
      .withWaitStrategy(
        Wait.forLogMessage(/Temporal Server:\s+0\.0\.0\.0:7233/),
      )
      .withStartupTimeout(90_000)
      .start();

    let stopped = false;
    return Object.freeze({
      image: TEMPORAL_IMAGE,
      address: `${container.getHost()}:${container.getMappedPort(TEMPORAL_PORT)}`,
      namespace: TEMPORAL_NAMESPACE,
      async stop() {
        if (stopped) return;
        stopped = true;
        await container.stop();
      },
    });
  } catch (error) {
    await container?.stop().catch(() => undefined);
    throw error;
  }
}
