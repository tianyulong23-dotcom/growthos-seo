import { describe, expect, it } from "vitest";

import {
  backlinkInventoryQuerySchema,
} from "../../src/modules/backlinks/application/schemas/backlink-profile.schema.js";

describe("backlink inventory query schema", () => {
  it.each(["all", "referring_domains", "new", "lost"] as const)(
    "accepts the %s inventory view",
    (view) => {
      expect(backlinkInventoryQuerySchema.parse({ view })).toMatchObject({
        page: 1,
        pageSize: 25,
        view,
        sort: "last_seen_desc",
      });
    },
  );

  it("keeps omitted view compatible with the full inventory list", () => {
    expect(backlinkInventoryQuerySchema.parse({})).toMatchObject({
      page: 1,
      pageSize: 25,
      view: "all",
      sort: "last_seen_desc",
    });
  });

  it("rejects unsupported inventory views", () => {
    expect(
      backlinkInventoryQuerySchema.safeParse({ view: "failed" }).success,
    ).toBe(false);
  });
});
