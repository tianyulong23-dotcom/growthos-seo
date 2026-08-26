import { Agent, fetch as undiciFetch } from "undici";

export type AiProviderProxyMode = "direct" | "inherit";

const directDispatcher = new Agent();

const directProviderFetch: typeof globalThis.fetch = async (input, init) =>
  await undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: directDispatcher,
    },
  ) as unknown as Response;

export const selectAiProviderFetch = (
  proxyMode: AiProviderProxyMode,
  dependencies: Readonly<{
    directFetch?: typeof globalThis.fetch;
    inheritedFetch?: typeof globalThis.fetch;
  }> = {},
): typeof globalThis.fetch =>
  proxyMode === "inherit"
    ? dependencies.inheritedFetch ?? globalThis.fetch
    : dependencies.directFetch ?? directProviderFetch;
