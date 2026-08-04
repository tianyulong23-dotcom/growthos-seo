import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBacklinksSbom, scanSensitiveFields } from "../../scripts/build-backlinks-sbom.js";

const base = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, base), "utf8");
const provenance = {
  node: "v24.14.1",
  npm: "11.11.0",
  os: "test-os",
  cpuArchitecture: "test-cpu",
};
function committedSbom(): Record<string, unknown> {
  return buildBacklinksSbom(
    read("package.json"),
    read("package-lock.json"),
    read("src/modules/backlinks/third-party/source-manifest.json"),
    provenance,
  );
}
describe("buildBacklinksSbom", () => {
  it("emits CycloneDX with exact locked versions, provenance, and no sensitive fields", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const bom = committedSbom();
    const components = bom.components as Array<{ name: string; version: string }>;
    const versions = new Map(components.map(({ name, version }) => [name, version]));
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.7");
    expect(components.every(({ version }) => /^\d+\.\d+\.\d+/.test(version))).toBe(true);
    for (const [name, version] of Object.entries({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    })) {
      expect(versions.get(name)).toBe(version);
    }
    expect(JSON.stringify(bom)).toContain("growthos:provenance:package-lock-sha256");
    expect(scanSensitiveFields(bom)).toEqual([]);
  });
  it("detects sensitive fields without credential fixtures", () => {
    expect(scanSensitiveFields({ metadata: { authorization: "redacted" } })).toEqual([
      "$.metadata.authorization is a sensitive field",
    ]);
  });
});
