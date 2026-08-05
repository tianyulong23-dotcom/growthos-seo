import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeThirdPartyLicenses } from "../../scripts/check-third-party-licenses.js";

const base = new URL("../../", import.meta.url);
const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, base), "utf8"));
function fixture(license: unknown = "MIT"): [unknown, { packages: Record<string, unknown> }, unknown] {
  const dependencies = { fastify: "5.10.0" };
  return [
    { dependencies, devDependencies: {} },
    { packages: { "": { dependencies, devDependencies: {} }, "node_modules/fastify": { version: "5.10.0", license } } },
    { sources: [] },
  ];
}

describe("analyzeThirdPartyLicenses", () => {
  it("accepts the committed dependency tree and notice", () => {
    const result = analyzeThirdPartyLicenses(
      readJson("package.json"), readJson("package-lock.json"),
      readJson("src/modules/backlinks/third-party/source-manifest.json"),
    );
    const notice = readFileSync(
      new URL("src/modules/backlinks/third-party/THIRD_PARTY_NOTICES.md", base), "utf8",
    ).replaceAll("\r\n", "\n");
    expect(result.errors).toEqual([]);
    expect(result.notice).toBe(notice);
    expect(result.notice).toContain(
      "| OSS-SEO-02 | OpenSEO | `927e931e51f6024323ada746816aaa6a51ce83ef` | MIT | 9 |",
    );
    expect(result.notice).toContain(
      "Per-file SHA-256 values are authoritative in `source-manifest.json`.",
    );
    expect(result.notice).toContain(
      "| OSS-PLC-01 | Cybokron Backlink Checker | `f71c66d5b8520ecba3e61ca96a8d1d0383f91c23` | MIT | 4 |",
    );
    expect(result.notice).toContain(
      "| OSS-PLC-02 | SEOnaut | `880b312c28fab8b0bf7fe4f9449dc4746dbb82ff` | MIT | 6 |",
    );
    expect(result.notice).toContain(
      "| `nodemailer` | production | 9.0.3 | MIT-0 |",
    );
    expect(result.notice).toContain(
      "| `postal-mime` | production | 2.7.5 | MIT-0 |",
    );
    expect(result.notice).toContain(
      "| `isomorphic-dompurify` | production | 3.18.0 | MIT |",
    );
    expect(result.notice).toContain(
      "| `jsdom` | production | 29.1.1 | MIT |",
    );
    expect(result.notice).toContain("MPL-2.0 OR Apache-2.0");
  });
  it("rejects a package with a missing license", () => {
    expect(analyzeThirdPartyLicenses(...fixture(null)).errors).toContain(
      "package-lock node_modules/fastify has no license",
    );
  });
  it("rejects changed and incompatible licenses", () => {
    expect(analyzeThirdPartyLicenses(...fixture("Apache-2.0")).errors).toContain(
      "dependencies.fastify license must equal MIT",
    );
    const [pkg, lock, manifest] = fixture();
    lock.packages["node_modules/example"] = { version: "1.0.0", license: "GPL-3.0-only" };
    expect(analyzeThirdPartyLicenses(pkg, lock, manifest).errors).toContain(
      "package-lock node_modules/example uses incompatible or unapproved license GPL-3.0-only",
    );
  });
});
