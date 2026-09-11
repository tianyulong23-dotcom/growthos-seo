import { Socket } from "node:net";

type ProxyEnvironmentName =
  | "http_proxy"
  | "HTTP_PROXY"
  | "https_proxy"
  | "HTTPS_PROXY";

type ProxyEndpoint = Readonly<{
  environmentName: ProxyEnvironmentName;
  host: string;
  port: number;
  displayUrl: string;
}>;

type ProxyConnector = (
  endpoint: Readonly<{ host: string; port: number }>,
  timeoutMs: number,
) => Promise<void>;

const proxyBackedCapabilityNames = [
  "GOOGLE_OAUTH_ENABLED",
  "GMAIL_SEND_ENABLED",
  "GMAIL_SYNC_ENABLED",
  "AI_PROVIDER_ENABLED",
  "BROWSER_PROVIDER_ENABLED",
  "DATAFORSEO_ENABLED",
] as const;

function readEffectiveProxy(
  environment: NodeJS.ProcessEnv,
  lowercaseName: "http_proxy" | "https_proxy",
  uppercaseName: "HTTP_PROXY" | "HTTPS_PROXY",
): Readonly<{ name: ProxyEnvironmentName; value: string }> | null {
  const lowercaseValue = environment[lowercaseName]?.trim();
  if (lowercaseValue) {
    return { name: lowercaseName, value: lowercaseValue };
  }
  const uppercaseValue = environment[uppercaseName]?.trim();
  if (uppercaseValue) {
    return { name: uppercaseName, value: uppercaseValue };
  }
  return null;
}

function parseProxyEndpoint(
  configured: Readonly<{ name: ProxyEnvironmentName; value: string }>,
): ProxyEndpoint {
  let url: URL;
  try {
    url = new URL(configured.value);
  } catch {
    throw new Error(
      `BACKLINKS_OUTBOUND_PROXY_URL_INVALID:${configured.name}`,
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.hostname.length === 0
  ) {
    throw new Error(
      `BACKLINKS_OUTBOUND_PROXY_URL_INVALID:${configured.name}`,
    );
  }
  const port = url.port.length > 0
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `BACKLINKS_OUTBOUND_PROXY_URL_INVALID:${configured.name}`,
    );
  }
  return {
    environmentName: configured.name,
    host: url.hostname,
    port,
    displayUrl: `${url.protocol}//${url.hostname}:${port}`,
  };
}

function connectToProxy(
  endpoint: Readonly<{ host: string; port: number }>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish());
    socket.once("timeout", () => finish(new Error("PROXY_CONNECT_TIMEOUT")));
    socket.once("error", (error) => finish(error));
    socket.connect(endpoint.port, endpoint.host);
  });
}

export async function assertBacklinksOutboundProxyReady(
  environment: NodeJS.ProcessEnv = process.env,
  connector: ProxyConnector = connectToProxy,
  timeoutMs = 2_000,
): Promise<void> {
  if (
    environment.NODE_USE_ENV_PROXY !== "1"
    || !proxyBackedCapabilityNames.some(
      (name) => environment[name] === "true",
    )
  ) {
    return;
  }

  const configuredProxies = [
    readEffectiveProxy(environment, "http_proxy", "HTTP_PROXY"),
    readEffectiveProxy(environment, "https_proxy", "HTTPS_PROXY"),
  ].filter((value) => value !== null);
  const checked = new Set<string>();
  for (const configured of configuredProxies) {
    const endpoint = parseProxyEndpoint(configured);
    const key = `${endpoint.host}:${endpoint.port}`;
    if (checked.has(key)) continue;
    checked.add(key);
    try {
      await connector(endpoint, timeoutMs);
    } catch {
      throw new Error(
        `BACKLINKS_OUTBOUND_PROXY_UNREACHABLE:${endpoint.displayUrl}`,
      );
    }
  }
}
