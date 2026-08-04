import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateDependencyAllowlist } from "../../scripts/check-dependency-allowlist.js";
function fixture(
  dependencies: Record<string, string>,
  extraPackages: Record<string, unknown> = {},
): readonly [unknown, unknown] {
  const installed = Object.fromEntries(
    Object.entries(dependencies).map(([name, version]) => [
      `node_modules/${name}`, { version },
    ]),
  );
  return [
    { dependencies, devDependencies: {} },
    {
      packages: {
        "": { dependencies, devDependencies: {} },
        ...installed,
        ...extraPackages,
      },
    },
  ];
}
describe("validateDependencyAllowlist", () => {
  it("accepts the committed package and lockfile", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const packageLock = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    );
    expect(validateDependencyAllowlist(packageJson, packageLock)).toEqual([]);
  });
  it("pins Nodemailer to the BL-AI-112 approved version", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const packageLock = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    ) as {
      packages?: Record<string, { version?: string; integrity?: string }>;
    };

    expect(packageJson.dependencies?.nodemailer).toBe("9.0.3");
    expect(packageLock.packages?.["node_modules/nodemailer"]).toMatchObject({
      version: "9.0.3",
      integrity:
        "sha512-n+YP+NKwR5zRWa60k3GiQ6Q3B4KXCoAw40dAKeCtYn020iNN74aWK2liXIC3ZEATeGql7we3tE3t8QwhY0eskw==",
    });
  });
  it("pins PostalMime to the BL-AI-131 approved version", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const packageLock = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    ) as {
      packages?: Record<string, { version?: string; integrity?: string }>;
    };

    expect(packageJson.dependencies?.["postal-mime"]).toBe("2.7.5");
    expect(packageLock.packages?.["node_modules/postal-mime"]).toMatchObject({
      version: "2.7.5",
      integrity:
        "sha512-GNEXKvWFQnbgO5NlrGzVa0FmWzBZ24PersAWErttSg1Hjpf0ATxTwS5DOMGaOpTG6bUh5cTr7xi0jAD942wCJA==",
    });
  });
  it("pins the BL-AI-133 sanitizer runtime and its DOMPurify engine", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const packageLock = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    ) as {
      packages?: Record<
        string,
        {
          version?: string;
          integrity?: string;
          license?: string;
          dependencies?: Record<string, string>;
        }
      >;
    };

    expect(packageJson.dependencies?.["isomorphic-dompurify"]).toBe("3.18.0");
    expect(packageJson.dependencies?.jsdom).toBe("29.1.1");
    expect(
      packageLock.packages?.["node_modules/isomorphic-dompurify"],
    ).toMatchObject({
      version: "3.18.0",
      integrity:
        "sha512-ajp0D8laIHeoYlhBTevpE2HUhqWaqLXFk6K/wV3Ok8kDraBZpZsifwVWaY8IfJntMRIo1VSksgKV+lXyet9Q7A==",
      license: "MIT",
      dependencies: {
        dompurify: "^3.4.11",
        jsdom: "^29.1.1",
      },
    });
    expect(packageLock.packages?.["node_modules/jsdom"]).toMatchObject({
      version: "29.1.1",
      integrity:
        "sha512-ECi4Fi2f7BdJtUKTflYRTiaMxIB0O6zfR1fX0GXpUrf6flp8QIYn1UT20YQqdSOfk2dfkCwS8LAFoJDEppNK5Q==",
      license: "MIT",
    });
    expect(packageLock.packages?.["node_modules/dompurify"]).toMatchObject({
      version: "3.4.12",
      integrity:
        "sha512-zQvGet8Z2sWbQhCmfFz/T5QWH2oBmjnqK3qvOjaqaNLrLEF912WamU+ohnTp0TCep/MFVHpdJuCZEdFOdTnEFg==",
      license: "(MPL-2.0 OR Apache-2.0)",
    });
  });
  it("rejects BullMQ as a direct production dependency", () => {
    const [packageJson, packageLock] = fixture({
      bullmq: "5.80.5",
      fastify: "5.10.0",
    });
    expect(validateDependencyAllowlist(packageJson, packageLock)).toContain(
      "dependencies.bullmq is explicitly rejected",
    );
  });
  it("rejects n8n anywhere in the lockfile dependency tree", () => {
    const [packageJson, packageLock] = fixture(
      { fastify: "5.10.0" },
      { "node_modules/example/node_modules/n8n": { version: "1.0.0" } },
    );
    expect(validateDependencyAllowlist(packageJson, packageLock)).toContain(
      "package-lock dependency tree contains rejected n8n",
    );
  });
  it("rejects floating versions", () => {
    const [packageJson, packageLock] = fixture({ fastify: "^5.10.0" });
    expect(validateDependencyAllowlist(packageJson, packageLock)).toContain(
      "dependencies.fastify must not use floating version ^5.10.0",
    );
  });
});
