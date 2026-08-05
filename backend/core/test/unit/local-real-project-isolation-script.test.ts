import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const script = readFileSync(
  resolve(
    repositoryRoot,
    "ops/local-product/Isolate-GrowthOS-LocalProductProjectData.ps1",
  ),
  "utf8",
);

describe("LOCAL-REAL-001 project data isolation", () => {
  it("backs up and validates PostgreSQL before changing project authority", () => {
    expect(script).toContain("pg_dump");
    expect(script).toContain("--format=custom");
    expect(script).toContain("pg_restore");
    expect(script.indexOf("pg_dump")).toBeLessThan(
      script.indexOf("UPDATE platform.projects"),
    );
  });

  it("archives the canary graph and creates a clean project identity", () => {
    expect(script).toContain("LIVE-001 Canary Archive");
    expect(script).toContain("live001-canary.example.invalid");
    expect(script).toContain("[guid]::NewGuid()");
    expect(script).toContain("local-real-001-project-isolation");
    expect(script).toContain("LOCAL_REAL_001_NEW_PROJECT_NOT_CLEAN");
  });

  it("does not call real providers during project isolation", () => {
    expect(script).not.toContain("Invoke-WebRequest");
    expect(script).not.toContain("Invoke-RestMethod");
    expect(script).not.toContain("dataforseo.com");
    expect(script).not.toContain("gmail.googleapis.com");
    expect(script).not.toContain("/chat/completions");
  });
});
