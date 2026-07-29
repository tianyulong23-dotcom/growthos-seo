import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";

const TEMPORAL_IMAGE =
  "temporalio/temporal:1.8.1@sha256:59561b9ef060eaeb1f46cb6a1842d6cbdd8a393eb3b6d315ecef5fe2f0b1d7a6";
const TEMPORAL_PORT = 7233;
const TEMPORAL_NAMESPACE = "growthos-test";

export type BacklinksTemporalHarness = Readonly<{
  image: string;
  address: string;
  namespace: string;
  stop(): Promise<void>;
}>;

export async function startBacklinksTemporalHarness():
  Promise<BacklinksTemporalHarness> {
  let container: StartedTestContainer | undefined;
  try {
    container = await new GenericContainer(TEMPORAL_IMAGE)
      .withCommand([
        "server", "start-dev", "--ip", "0.0.0.0", "--headless",
        "--namespace", TEMPORAL_NAMESPACE,
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
