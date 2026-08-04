import { describe, expect, it, vi } from "vitest";
import {
  enforceNetworkPolicy, NetworkPolicyError, networkPolicyReasons,
  type HostnameResolver, type ResolvedAddress,
} from "../../src/modules/backlinks/adapters/http/network-policy.js";
import { enforceUrlPolicy } from "../../src/modules/backlinks/adapters/http/url-policy.js";
import { safeFetchFailureCodes } from "../../src/modules/backlinks/ports/safe-fetch.port.js";

const approvedDomain = () => enforceUrlPolicy("https://example.com/contact");
const fixedResolver = (...addresses: ResolvedAddress[]): HostnameResolver =>
  async () => addresses;

describe("BL-AI-067 network policy", () => {
  it.each([
    ["https://8.8.8.8/", "8.8.8.8", 4],
    ["https://[2606:4700:4700::1111]/", "2606:4700:4700::1111", 6],
  ] as const)("accepts public IP literal %s without DNS", async (url, address, family) => {
    const resolver = vi.fn<HostnameResolver>();
    const decision = await enforceNetworkPolicy(enforceUrlPolicy(url), resolver);
    expect(decision).toEqual({
      hostname: enforceUrlPolicy(url).hostname, addresses: [{ address, family }],
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("accepts and freezes every public DNS result", async () => {
    const decision = await enforceNetworkPolicy(
      approvedDomain(),
      fixedResolver(
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ),
    );
    expect(decision.addresses).toHaveLength(2);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.addresses)).toBe(true);
    expect(decision.addresses.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    ["0.0.0.0", 4], ["10.0.0.1", 4], ["100.64.0.1", 4],
    ["127.0.0.1", 4], ["169.254.1.1", 4], ["169.254.169.254", 4],
    ["172.16.0.1", 4], ["192.0.0.192", 4], ["192.0.2.1", 4],
    ["192.168.1.1", 4], ["198.18.0.1", 4], ["224.0.0.1", 4],
    ["240.0.0.1", 4], ["100.100.100.200", 4], ["168.63.129.16", 4],
    ["::", 6], ["::1", 6], ["::ffff:127.0.0.1", 6],
    ["64:ff9b::7f00:1", 6], ["100::1", 6], ["2001:db8::1", 6],
    ["2002:7f00:1::", 6], ["fc00::1", 6], ["fd00:ec2::254", 6],
    ["fe80::1", 6], ["fec0::1", 6], ["ff02::1", 6],
  ] satisfies readonly (readonly [string, 4 | 6])[])(
    "rejects blocked address %s",
    async (address, family) => {
      await expect(
        enforceNetworkPolicy(approvedDomain(), fixedResolver({ address, family })),
      ).rejects.toMatchObject({
        name: "NetworkPolicyError",
        code: safeFetchFailureCodes.networkBlocked,
        reason: networkPolicyReasons.blockedAddress,
        address,
        retryable: false,
      });
    },
  );

  it("rejects the whole hostname when one DNS result is blocked", async () => {
    await expect(
      enforceNetworkPolicy(
        approvedDomain(),
        fixedResolver({ address: "8.8.8.8", family: 4 }, {
          address: "127.0.0.1", family: 4,
        }),
      ),
    ).rejects.toMatchObject({ address: "127.0.0.1" });
  });

  it.each([
    [{ address: "999.1.1.1", family: 4 }],
    [{ address: "8.8.8.8", family: 6 }],
  ] as const)("fails closed for invalid DNS address %#", async (record) => {
    await expect(
      enforceNetworkPolicy(approvedDomain(), fixedResolver(record as ResolvedAddress)),
    ).rejects.toMatchObject({
      code: safeFetchFailureCodes.networkBlocked,
      reason: networkPolicyReasons.invalidAddress,
      retryable: false,
    });
  });

  it.each([
    ["resolver failure", async () => Promise.reject(new Error("offline"))],
    ["empty answer", async () => []],
  ] satisfies readonly (readonly [string, HostnameResolver])[])(
    "reports retryable DNS failure for %s",
    async (_label, resolver) => {
      const attempt = enforceNetworkPolicy(approvedDomain(), resolver);
      await expect(attempt).rejects.toBeInstanceOf(NetworkPolicyError);
      await expect(attempt).rejects.toMatchObject({
        code: safeFetchFailureCodes.dnsResolutionFailed,
        retryable: true,
      });
    },
  );

  it("revalidates DNS on every policy decision", async () => {
    let invocation = 0;
    const resolver: HostnameResolver = async () =>
      invocation++ === 0
        ? [{ address: "8.8.8.8", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    await expect(enforceNetworkPolicy(approvedDomain(), resolver)).resolves
      .toBeDefined();
    await expect(enforceNetworkPolicy(approvedDomain(), resolver)).rejects
      .toMatchObject({ address: "127.0.0.1" });
  });
});
