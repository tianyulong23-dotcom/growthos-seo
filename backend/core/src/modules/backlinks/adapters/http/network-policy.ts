import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import {
  SafeFetchError,
  safeFetchFailureCodes,
} from "../../ports/safe-fetch.port.js";
import type { ApprovedUrl } from "./url-policy.js";

export type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type HostnameResolver =
  (hostname: string) => Promise<readonly ResolvedAddress[]>;
export type ApprovedNetwork = Readonly<{
  hostname: string;
  addresses: readonly ResolvedAddress[];
}>;

export const networkPolicyReasons = {
  dnsResolutionFailed: "dns_resolution_failed",
  noAddresses: "no_addresses",
  invalidAddress: "invalid_address",
  blockedAddress: "blocked_address",
} as const;
type NetworkPolicyReason =
  (typeof networkPolicyReasons)[keyof typeof networkPolicyReasons];

export class NetworkPolicyError extends SafeFetchError {
  readonly hostname: string;
  readonly reason: NetworkPolicyReason;
  readonly address: string | undefined;
  constructor(
    url: ApprovedUrl,
    reason: NetworkPolicyReason,
    address?: string,
    options?: ErrorOptions,
  ) {
    const dnsFailure = reason === networkPolicyReasons.dnsResolutionFailed ||
      reason === networkPolicyReasons.noAddresses;
    super({
      code: dnsFailure
        ? safeFetchFailureCodes.dnsResolutionFailed
        : safeFetchFailureCodes.networkBlocked,
      requestedUrl: url.requestedUrl,
      message: `Network rejected by policy: ${reason}.`,
      retryable: dnsFailure,
    }, options);
    this.name = "NetworkPolicyError";
    this.hostname = url.hostname;
    this.reason = reason;
    this.address = address;
  }
}

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4");
}
blockedV4.addAddress("168.63.129.16", "ipv4");

const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 32], ["2001:2::", 48], ["2001:10::", 28],
  ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16],
] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6");
}

export const resolveHostname: HostnameResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(
    ({ address, family }) => ({ address, family: family as 4 | 6 }),
  );
function ipLiteral(hostname: string): ResolvedAddress | undefined {
  const address = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  const family = isIP(address);
  return family === 4 || family === 6 ? { address, family } : undefined;
}
function isBlocked(address: string, family: 4 | 6): boolean {
  return family === 4
    ? blockedV4.check(address, "ipv4")
    : !publicV6.check(address, "ipv6") || blockedV6.check(address, "ipv6");
}

export async function enforceNetworkPolicy(
  url: ApprovedUrl,
  resolver: HostnameResolver = resolveHostname,
): Promise<ApprovedNetwork> {
  const literal = ipLiteral(url.hostname);
  let resolved: readonly ResolvedAddress[];
  try {
    resolved = literal === undefined ? await resolver(url.hostname) : [literal];
  } catch (cause) {
    throw new NetworkPolicyError(
      url, networkPolicyReasons.dnsResolutionFailed, undefined, { cause },
    );
  }
  if (resolved.length === 0) {
    throw new NetworkPolicyError(url, networkPolicyReasons.noAddresses);
  }
  const addresses: ResolvedAddress[] = [];
  const seen = new Set<string>();
  for (const record of resolved) {
    if (isIP(record.address) !== record.family) {
      throw new NetworkPolicyError(
        url, networkPolicyReasons.invalidAddress, record.address,
      );
    }
    if (isBlocked(record.address, record.family)) {
      throw new NetworkPolicyError(
        url, networkPolicyReasons.blockedAddress, record.address,
      );
    }
    const key = `${record.family}:${record.address.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      addresses.push(Object.freeze({
        address: record.address, family: record.family,
      }));
    }
  }
  return Object.freeze({ hostname: url.hostname, addresses: Object.freeze(addresses) });
}
