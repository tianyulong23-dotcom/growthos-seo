import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const readSource = (path: string) =>
  readFileSync(resolve(repositoryRoot, path), "utf8");

describe("LOCAL-REAL-001 frontend project authority", () => {
  it("loads Website Projects from the public Gateway without a static fallback", () => {
    const projectContext = readSource("frontend/src/app/project-context.tsx");
    const projectWorkspace = readSource(
      "frontend/src/features/projects/project-workspace.tsx",
    );

    expect(projectContext).toContain("requestPlatform(");
    expect(projectContext).toContain('"platformListWebsiteProjectsV1"');
    expect(projectContext).not.toContain("apiRequest<");
    expect(projectContext).not.toContain("baseProjects");
    expect(projectWorkspace).not.toContain("initialProjects");
    expect(projectWorkspace).not.toContain("静态交互预览");
  });

  it("does not expose demo tasks, notifications, or mock provider state", () => {
    const appShell = readSource("frontend/src/app/app-shell.tsx");
    const settingsPage = readSource("frontend/src/pages/settings-page.tsx");
    const productSources = `${appShell}\n${settingsPage}`;

    for (const forbidden of [
      "publisher-live002.example.invalid",
      "live001-canary.example.invalid",
      "qq.com",
      "watchwise.io",
      "streamscope.co",
      "livingroomlab.com",
      "streamerfocus.com",
      "Mock 已连接",
      "Mock 数据源",
      "Mock 任务状态",
    ]) {
      expect(productSources).not.toContain(forbidden);
    }
  });

  it("keeps website, contact email, and task fields separated", () => {
    const opportunities = readSource(
      "frontend/src/features/outreach/opportunities/opportunities-workspace.tsx",
    );
    const draftPage = readSource(
      "frontend/src/features/outreach/drafts/draft-page.tsx",
    );
    const appShell = readSource("frontend/src/app/app-shell.tsx");

    expect(opportunities).toContain("domain={item.targetHostAscii}");
    expect(opportunities).toContain("email={item.contactEmail}");
    expect(draftPage).toContain("recipient?.normalizedEmail");
    expect(appShell).toContain("暂无服务端任务");
  });
});
