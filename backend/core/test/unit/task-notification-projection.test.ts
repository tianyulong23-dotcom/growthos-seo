import { describe, expect, it } from "vitest";

import {
  buildTaskNotificationProjection,
  recordNotificationRead,
} from "../../src/modules/backlinks/domain/metrics/task-notification-projection.js";

const base = {
  organizationId: "organization-170",
  workspaceId: "workspace-170",
  websiteProjectId: "project-170",
  occurredAt: new Date("2026-07-29T02:00:00.000Z"),
  payload: {},
};

describe("BL-AI-170 Task/Notification Projection", () => {
  it("rebuilds deterministically and deduplicates one rule occurrence per fact", () => {
    const events = [{
      ...base,
      eventId: "event-lost",
      eventType: "placement.monitoring.status_decided",
      payload: {
        placementId: "placement-170",
        nextStatus: "lost",
      },
    }, {
      ...base,
      eventId: "event-export",
      eventType: "report.export.completed",
      payload: {
        exportId: "export-170",
        reportKey: "weekly-performance",
      },
    }];
    const lostEvent = events.find(({ eventId }) => eventId === "event-lost");
    const exportEvent = events.find(({ eventId }) => eventId === "event-export");
    if (lostEvent === undefined || exportEvent === undefined) {
      throw new Error("Projection fixtures are incomplete.");
    }

    const first = buildTaskNotificationProjection([
      exportEvent,
      lostEvent,
      lostEvent,
    ]);
    const replay = buildTaskNotificationProjection(events);

    expect(first).toEqual(replay);
    expect(first.tasks).toMatchObject([{
      occurrenceKey: "placement-health-review:event-lost",
      sourceEventId: "event-lost",
      status: "open",
    }]);
    expect(first.notifications.map(({ occurrenceKey }) => occurrenceKey))
      .toEqual([
        "placement-health-alert:event-lost",
        "report-export-ready:event-export",
      ]);
  });

  it("records user read state without changing the source notification", () => {
    const projection = buildTaskNotificationProjection([{
      ...base,
      eventId: "event-reply",
      eventType: "reply.assignment.recorded",
      payload: { opportunityId: "opportunity-170" },
    }]);
    const notification = projection.notifications[0];
    if (notification === undefined) {
      throw new Error("Reply assignment notification was not projected.");
    }
    const before = structuredClone(notification);
    const read = recordNotificationRead({
      notification,
      userId: "user-170",
      readAt: new Date("2026-07-29T02:10:00.000Z"),
      expectedVersion: null,
    });

    expect(read).toEqual({
      notificationOccurrenceKey: notification.occurrenceKey,
      userId: "user-170",
      readAt: new Date("2026-07-29T02:10:00.000Z"),
      version: 1,
    });
    expect(notification).toEqual(before);
  });
});
