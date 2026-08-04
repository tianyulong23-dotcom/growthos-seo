import { describe, expect, it } from "vitest";

import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../../src/modules/backlinks/domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "../../../src/modules/backlinks/api/problem-details.js";

const statusMappings = [
  [backlinkErrorCodes.invalidRequest, 400, false],
  [backlinkErrorCodes.authenticationRequired, 401, false],
  [backlinkErrorCodes.accessDenied, 403, false],
  [backlinkErrorCodes.notFound, 404, false],
  [backlinkErrorCodes.conflict, 409, false],
  [backlinkErrorCodes.rateLimited, 429, true],
  [backlinkErrorCodes.internal, 500, false],
] as const;

describe("backlinks Problem Details", () => {
  it.each(statusMappings)(
    "maps %s to HTTP %i",
    (code, expectedStatus, retryable) => {
      const problem = toBacklinkProblemDetails(
        new BacklinkError({
          code,
          message: "Mapped error",
          retryable,
        }),
        "request-1",
      );
      const expectedMessage =
        code === backlinkErrorCodes.internal
          ? "An unexpected error occurred."
          : "Mapped error";

      expect(problem).toMatchObject({
        status: expectedStatus,
        code,
        detail: expectedMessage,
        message: expectedMessage,
        requestId: "request-1",
        retryable,
      });
      expect(problem.type).toMatch(/^urn:growthos:problem:backlinks:/);
      expect(problem.title.length).toBeGreaterThan(0);
      expect(backlinkProblemDetailsSchema.parse(problem)).toEqual(problem);
    },
  );

  it("preserves field errors and rejects unknown response properties", () => {
    const problem = toBacklinkProblemDetails(
      new BacklinkError({
        code: backlinkErrorCodes.invalidRequest,
        message: "Request validation failed",
        fieldErrors: [{ field: "websiteProjectKey", message: "Required" }],
      }),
      "request-2",
    );

    expect(problem.fieldErrors).toEqual([
      { field: "websiteProjectKey", message: "Required" },
    ]);
    expect(
      backlinkProblemDetailsSchema.safeParse({
        ...problem,
        providerError: "must not escape",
      }).success,
    ).toBe(false);
  });

  it("sanitizes unknown errors as a non-retryable 500 response", () => {
    const problem = toBacklinkProblemDetails(
      new Error("provider token secret"),
      "request-3",
    );

    expect(problem).toMatchObject({
      status: 500,
      code: backlinkErrorCodes.internal,
      detail: "An unexpected error occurred.",
      message: "An unexpected error occurred.",
      requestId: "request-3",
      retryable: false,
    });
    expect(JSON.stringify(problem)).not.toContain("provider token secret");
    expect(backlinkProblemContentType).toBe("application/problem+json");
  });
});
