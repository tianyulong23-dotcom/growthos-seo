import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateSourceManifest } from "../../scripts/check-source-manifest.js";

const commit = "0123456789abcdef0123456789abcdef01234567";
const sha256 = "a".repeat(64);
const baseRecord: Record<string, unknown> = {
  id: "OSS-TEST-01",
  project: "Fixture",
  repository: "https://example.com/fixture",
  license: "MIT",
  packageVersion: "1.2.3",
  auditedCommit: commit,
  sourceFiles: ["src/index.ts"],
  upstreamTests: ["test/index.test.ts"],
  targetFiles: ["backend/core/src/fixture.ts"],
  adoption: "direct-dependency",
  allowedReuse: ["fixture behavior"],
  forbiddenReuse: ["fixture secrets"],
  adr: "backend/core/docs/adr/ADR-BL-0002-runtime-stack.md",
};
function manifest(...sources: Record<string, unknown>[]): unknown {
  return { schemaVersion: "1.0", sources };
}
describe("validateSourceManifest", () => {
  it("accepts the committed source manifest", () => {
    const path = new URL(
      "../../src/modules/backlinks/third-party/source-manifest.json",
      import.meta.url,
    );
    const contents = readFileSync(path, "utf8");
    expect(validateSourceManifest(JSON.parse(contents))).toEqual([]);
  });
  it("pins the BL-AI-143 placement references and reuse boundaries", () => {
    const path = new URL(
      "../../src/modules/backlinks/third-party/source-manifest.json",
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      sources: Array<Record<string, unknown>>;
    };
    const byId = new Map(manifest.sources.map((source) => [source.id, source]));

    expect(byId.get("OSS-PLC-01")).toEqual({
      id: "OSS-PLC-01",
      project: "Cybokron Backlink Checker",
      repository: "https://github.com/ercanatay/cybokron-backlink-checker",
      license: "MIT",
      packageVersion: "v2.1.7",
      auditedCommit: "f71c66d5b8520ecba3e61ca96a8d1d0383f91c23",
      sourceFiles: [
        "src/Services/BacklinkAnalyzerService.php",
        "src/Services/HttpClient.php",
        "src/Domain/Url/LinkClassifier.php",
        "src/Domain/Url/UrlNormalizer.php",
      ],
      sourceFileHashes: {
        "src/Services/BacklinkAnalyzerService.php":
          "a9e374f8571d53893db6d8b89ac6fb3a167fba5470d4e6ea8728829b1eb18c5e",
        "src/Services/HttpClient.php":
          "c72b180dda03aa95d7b5e94ae3140ff71595323b6d08edcbd4dc8bd448911fad",
        "src/Domain/Url/LinkClassifier.php":
          "5bd7437b17559819fa1d343942390233fce7c090d7bb9280edef75b21331765f",
        "src/Domain/Url/UrlNormalizer.php":
          "8055731e8600cfc90dc7929fed07f91527e1ef6b4dfb260d27615b357413fecf",
      },
      upstreamTests: [
        "tests/Unit/LinkClassifierTest.php",
        "tests/Unit/UrlNormalizerTest.php",
        "tests/Unit/BacklinkAnalyzerSsrfTest.php",
      ],
      targetFiles: [
        "backend/core/src/modules/backlinks/third-party/cybokron/link-classifier.ts",
        "backend/core/src/modules/backlinks/third-party/cybokron/url-normalizer-vectors.ts",
        "backend/core/src/modules/backlinks/third-party/cybokron/ssrf-vectors.ts",
      ],
      adoption: "ported-source",
      allowedReuse: [
        "rel classification and strongest-link selection semantics",
        "host equivalence, redirect evidence, and SSRF test vectors",
      ],
      forbiddenReuse: [
        "Upstream HTTP client as a replacement for GrowthOS SafeFetch",
        "Upstream application, database, scheduler, tasks, pages, or business-state writes",
      ],
      adr: "backend/core/docs/adr/ADR-BL-0002-runtime-stack.md",
    });

    expect(byId.get("OSS-PLC-02")).toEqual({
      id: "OSS-PLC-02",
      project: "SEOnaut",
      repository: "https://github.com/StJudeWasHere/seonaut",
      license: "MIT",
      auditedCommit: "880b312c28fab8b0bf7fe4f9449dc4746dbb82ff",
      sourceFiles: [
        "internal/services/parser.go",
        "internal/services/html_parser.go",
        "internal/issues/page/canonical.go",
        "internal/issues/errors/errors.go",
        "internal/repository/pagereport.go",
        "internal/urlutils/absoluteurl.go",
      ],
      sourceFileHashes: {
        "internal/services/parser.go":
          "dfa5aff937932de14cc7648ee37ceaa977fb28847def630a834035df180ee3ab",
        "internal/services/html_parser.go":
          "5b7184862cd6f03011f8b02b2665497c677c45ce06916dc78d211d18e6527c39",
        "internal/issues/page/canonical.go":
          "ca9d9fc924ba5d09801b9daed1e78d47273355706ae568051a0ef292a9445a3e",
        "internal/issues/errors/errors.go":
          "5885a29254b8362c9db5c82c18237d1d4c3d51d8fecfc56035472b5f6d805ee5",
        "internal/repository/pagereport.go":
          "eb700da3de24940f94a050e75ebd44c963e5cfc4d5ff0eb5825a326dede93cbf",
        "internal/urlutils/absoluteurl.go":
          "cf6206c4ca8fb78f72c2b3ec0f1e18f52b7cbda46f2950d2c1415a9871d47f70",
      },
      upstreamTests: [
        "internal/services/html_parser_test.go",
        "internal/issues/page/canonical_test.go",
      ],
      targetFiles: [
        "backend/core/src/modules/backlinks/third-party/seonaut/canonical-parser.ts",
        "backend/core/src/modules/backlinks/third-party/seonaut/robots-directive-parser.ts",
        "backend/core/src/modules/backlinks/third-party/seonaut/fixtures",
      ],
      adoption: "ported-source",
      allowedReuse: [
        "HTML and HTTP canonical parsing semantics, including relative and multiple canonicals",
        "Meta and X-Robots-Tag directives plus page-level nofollow test semantics",
      ],
      forbiddenReuse: [
        "Upstream crawler, repository, issue state, data models, or URL business decisions",
        "Unverified upstream branches or direct placement-state writes",
      ],
      adr: "backend/core/docs/adr/ADR-BL-0002-runtime-stack.md",
    });
  });
  it("pins the BL-AI-112 MailComposer source and reuse boundary", () => {
    const path = new URL(
      "../../src/modules/backlinks/third-party/source-manifest.json",
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      sources: Array<Record<string, unknown>>;
    };
    const source = manifest.sources.find((entry) => entry.id === "OSS-MAIL-01");

    expect(source).toEqual({
      id: "OSS-MAIL-01",
      project: "Nodemailer MailComposer",
      repository: "https://github.com/nodemailer/nodemailer",
      license: "MIT-0",
      packageVersion: "9.0.3",
      packageIntegrity:
        "sha512-n+YP+NKwR5zRWa60k3GiQ6Q3B4KXCoAw40dAKeCtYn020iNN74aWK2liXIC3ZEATeGql7we3tE3t8QwhY0eskw==",
      sourceFiles: [
        "lib/mail-composer/index.js",
        "lib/mime-node/index.js",
        "lib/mime-funcs/index.js",
        "lib/addressparser/index.js",
      ],
      upstreamTests: [],
      targetFiles: [
        "backend/core/src/modules/backlinks/adapters/gmail/message-builder.ts",
      ],
      adoption: "direct-dependency",
      allowedReuse: ["MailComposer RFC 5322 and MIME serialization only"],
      forbiddenReuse: [
        "Nodemailer SMTP, sendmail, SES, stream, or JSON transports",
        "OAuth, token handling, network delivery, DKIM signing, or provider retries",
      ],
      adr: "backend/core/docs/adr/ADR-BL-0002-runtime-stack.md",
    });
  });
  it("pins the BL-AI-131 PostalMime source and reuse boundary", () => {
    const path = new URL(
      "../../src/modules/backlinks/third-party/source-manifest.json",
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      sources: Array<Record<string, unknown>>;
    };
    const source = manifest.sources.find((entry) => entry.id === "OSS-MAIL-02");

    expect(source).toEqual({
      id: "OSS-MAIL-02",
      project: "PostalMime",
      repository: "https://github.com/postalsys/postal-mime",
      license: "MIT-0",
      packageVersion: "2.7.5",
      packageIntegrity:
        "sha512-GNEXKvWFQnbgO5NlrGzVa0FmWzBZ24PersAWErttSg1Hjpf0ATxTwS5DOMGaOpTG6bUh5cTr7xi0jAD942wCJA==",
      auditedSourceCommit: "a70ee5ca7bdd1867574518f1ea8329782245f3f9",
      sourceFiles: [
        "src/postal-mime.js",
        "src/mime-node.js",
        "src/decode-strings.js",
        "src/address-parser.js",
      ],
      upstreamTests: [],
      targetFiles: [
        "backend/core/src/modules/backlinks/adapters/gmail/message-parser.ts",
      ],
      adoption: "direct-dependency",
      allowedReuse: [
        "Parsing raw RFC 5322 and MIME input inside the Gmail adapter boundary",
        "Decoding headers, body parts, and attachment data for later Core-owned mapping",
      ],
      forbiddenReuse: [
        "MailMessage mapping, thread or reply matching, business-state writes, or provider calls",
        "Trusting or rendering HTML, loading remote resources, executing attachments, or sending mail",
      ],
      adr: "backend/core/docs/adr/ADR-BL-0002-runtime-stack.md",
    });
  });
  it("parses the BL-AI-131 MIME contract fixtures", async () => {
    const { default: PostalMime } = await import("postal-mime");
    const parse = async (name: string) =>
      PostalMime.parse(
        readFileSync(new URL(`../fixtures/mail/${name}`, import.meta.url)),
      );

    const complex = await parse("complex-multipart.eml");
    expect(complex.subject).toContain("Quarterly");
    expect(complex.text).toContain("Plain body");
    expect(complex.html).toContain("<strong>HTML body</strong>");
    expect(complex.attachments).toEqual([
      expect.objectContaining({
        filename: "rates.txt",
        mimeType: "text/plain",
      }),
    ]);

    const nested = await parse("nested-message.eml");
    expect(nested.subject).toBe("Outer message");
    expect(nested.text).toContain("Outer body");

    const malformed = await parse("malformed-boundary.eml");
    expect(malformed.subject).toBe("Malformed boundary");
  });
  it("pins the BL-AI-133 sanitizer source and runtime boundaries", () => {
    const path = new URL(
      "../../src/modules/backlinks/third-party/source-manifest.json",
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      sources: Array<Record<string, unknown>>;
    };

    expect(
      manifest.sources.find((entry) => entry.id === "OSS-MAIL-03"),
    ).toEqual({
      id: "OSS-MAIL-03",
      project: "isomorphic-dompurify",
      repository: "https://github.com/kkomelin/isomorphic-dompurify",
      license: "MIT",
      packageVersion: "3.18.0",
      packageIntegrity:
        "sha512-ajp0D8laIHeoYlhBTevpE2HUhqWaqLXFk6K/wV3Ok8kDraBZpZsifwVWaY8IfJntMRIo1VSksgKV+lXyet9Q7A==",
      auditedSourceCommit: "1d5745c69d4c7dd2ec76dc7fa2ab3ccfdf3fc0ee",
      resolvedRuntime: {
        package: "dompurify",
        version: "3.4.12",
        license: "(MPL-2.0 OR Apache-2.0)",
        packageIntegrity:
          "sha512-zQvGet8Z2sWbQhCmfFz/T5QWH2oBmjnqK3qvOjaqaNLrLEF912WamU+ohnTp0TCep/MFVHpdJuCZEdFOdTnEFg==",
      },
      sourceFiles: ["src/index.ts", "src/browser.ts"],
      upstreamTests: [],
      targetFiles: [
        "backend/core/src/modules/backlinks/adapters/gmail/sanitizer.ts",
      ],
      adoption: "direct-dependency",
      allowedReuse: [
        "Constructing the approved server-side DOMPurify runtime and invoking sanitize inside the Gmail sanitizer boundary",
        "Returning only Core-owned sanitized HTML metadata after an explicit strict policy is applied",
      ],
      forbiddenReuse: [
        "Using DOMPurify default configuration as the GrowthOS email security policy",
        "Rendering raw HTML, allowing active content or remote tracking resources, or appending untrusted HTML after sanitization",
      ],
      adr: "backend/core/docs/adr/ADR-BL-0002-runtime-stack.md",
    });
    expect(
      manifest.sources.find((entry) => entry.id === "OSS-MAIL-04"),
    ).toEqual({
      id: "OSS-MAIL-04",
      project: "jsdom",
      repository: "https://github.com/jsdom/jsdom",
      license: "MIT",
      packageVersion: "29.1.1",
      packageIntegrity:
        "sha512-ECi4Fi2f7BdJtUKTflYRTiaMxIB0O6zfR1fX0GXpUrf6flp8QIYn1UT20YQqdSOfk2dfkCwS8LAFoJDEppNK5Q==",
      auditedSourceCommit: "9b9ea7e10b7842cd38c61458a38774cc3b60c24c",
      sourceFiles: [
        "lib/api.js",
        "lib/jsdom/browser/Window.js",
        "lib/jsdom/living/nodes/Document-impl.js",
      ],
      upstreamTests: [],
      targetFiles: [
        "backend/core/src/modules/backlinks/adapters/gmail/sanitizer.ts",
      ],
      adoption: "direct-dependency",
      allowedReuse: [
        "Providing the server-side DOM environment required by the approved DOMPurify wrapper",
      ],
      forbiddenReuse: [
        "Loading remote resources, executing scripts, emulating a browser worker, or making jsdom a business-state authority",
      ],
      adr: "backend/core/docs/adr/ADR-BL-0002-runtime-stack.md",
    });
  });
  it("accepts hashed ported source and disabled conditional fixtures", () => {
    const ported = {
      ...baseRecord,
      adoption: "ported-source",
      sourceFileHashes: { "src/index.ts": sha256 },
    };
    const conditional = {
      ...baseRecord,
      id: "OSS-TEST-02",
      adoption: "conditional",
      defaultEnabled: false,
    };
    expect(validateSourceManifest(manifest(ported, conditional))).toEqual([]);
  });
  it("rejects a fixture with a missing required field", () => {
    const invalid = { ...baseRecord };
    Reflect.deleteProperty(invalid, "license");
    expect(validateSourceManifest(manifest(invalid))).toContain(
      "sources[0].license must be a non-empty string",
    );
  });
  it("rejects ported source without a hash for every source file", () => {
    const invalid = {
      ...baseRecord,
      adoption: "ported-source",
      sourceFileHashes: {},
    };
    expect(validateSourceManifest(manifest(invalid))).toContain(
      "sources[0].sourceFileHashes[src/index.ts] must be a SHA-256 hash",
    );
  });
  it("rejects conditional sources that are enabled by default", () => {
    const invalid = {
      ...baseRecord,
      adoption: "conditional",
      defaultEnabled: true,
    };
    expect(validateSourceManifest(manifest(invalid))).toContain(
      "sources[0].defaultEnabled must be false for conditional sources",
    );
  });
});
