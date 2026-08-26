import { describe, expect, it, vi } from "vitest";

import {
  createDraftEditingRepository,
  type DraftGenerationQueryClient,
} from "../../src/modules/backlinks/application/repositories/draft-generation.repository.js";

describe("Draft editing repository", () => {
  it("rejects approval of a historical version containing internal metadata", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        subjectText: "Partnership idea",
        bodyText:
          "Audience fit. [contact:confirmed, profile:current]",
      }],
    });
    const repository = createDraftEditingRepository({
      query,
    } satisfies DraftGenerationQueryClient);

    const result = await repository.approve({
      organizationId: "organization-1",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      draftId: "018f0000-0000-7000-8000-000000000001",
      expectedVersion: 2,
      actorId: "user-1",
      recordedAt: new Date("2026-08-24T09:00:00.000Z"),
    });

    expect(result).toEqual({ state: "invalid_content" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
