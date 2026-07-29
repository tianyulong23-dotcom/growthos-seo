export type ProjectionFact = Readonly<{
  eventId: string;
  eventType: string;
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  occurredAt: Date;
  payload: Readonly<Record<string, unknown>>;
}>;

type ProjectionItem = Readonly<{
  occurrenceKey: string;
  sourceEventId: string;
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  occurredAt: Date;
  title: string;
}>;

export type TaskProjection = ProjectionItem & Readonly<{
  taskType: string;
  status: "open";
}>;

export type NotificationProjection = ProjectionItem & Readonly<{
  notificationType: string;
}>;

export type NotificationReadState = Readonly<{
  notificationOccurrenceKey: string;
  userId: string;
  readAt: Date;
  version: number;
}>;

function placementHealthProjection(
  fact: ProjectionFact,
): Readonly<{
  task: TaskProjection;
  notification: NotificationProjection;
}> | null {
  if (
    fact.eventType !== "placement.monitoring.status_decided"
    || fact.payload.nextStatus !== "lost"
  ) {
    return null;
  }
  const common = {
    sourceEventId: fact.eventId,
    organizationId: fact.organizationId,
    workspaceId: fact.workspaceId,
    websiteProjectId: fact.websiteProjectId,
    occurredAt: fact.occurredAt,
  };
  return {
    task: {
      ...common,
      occurrenceKey: `placement-health-review:${fact.eventId}`,
      taskType: "placement_health_review",
      status: "open",
      title: "Review lost placement evidence",
    },
    notification: {
      ...common,
      occurrenceKey: `placement-health-alert:${fact.eventId}`,
      notificationType: "placement_health_alert",
      title: "Placement monitoring detected a lost link",
    },
  };
}

function eventNotification(
  fact: ProjectionFact,
): NotificationProjection | null {
  const common = {
    sourceEventId: fact.eventId,
    organizationId: fact.organizationId,
    workspaceId: fact.workspaceId,
    websiteProjectId: fact.websiteProjectId,
    occurredAt: fact.occurredAt,
  };
  if (fact.eventType === "report.export.completed") {
    return {
      ...common,
      occurrenceKey: `report-export-ready:${fact.eventId}`,
      notificationType: "report_export_ready",
      title: "Report export is ready",
    };
  }
  if (fact.eventType === "reply.assignment.recorded") {
    return {
      ...common,
      occurrenceKey: `reply-assignment:${fact.eventId}`,
      notificationType: "reply_assignment",
      title: "A reply requires review",
    };
  }
  return null;
}

export function buildTaskNotificationProjection(
  facts: readonly ProjectionFact[],
): Readonly<{
  tasks: readonly TaskProjection[];
  notifications: readonly NotificationProjection[];
}> {
  const uniqueFacts = [...new Map(
    [...facts]
      .sort((left, right) => left.eventId.localeCompare(right.eventId))
      .map((fact) => [fact.eventId, fact]),
  ).values()];
  const tasks = new Map<string, TaskProjection>();
  const notifications = new Map<string, NotificationProjection>();

  for (const fact of uniqueFacts) {
    const placement = placementHealthProjection(fact);
    if (placement !== null) {
      tasks.set(placement.task.occurrenceKey, placement.task);
      notifications.set(
        placement.notification.occurrenceKey,
        placement.notification,
      );
    }
    const notification = eventNotification(fact);
    if (notification !== null) {
      notifications.set(notification.occurrenceKey, notification);
    }
  }

  return {
    tasks: [...tasks.values()].sort((left, right) =>
      left.occurrenceKey.localeCompare(right.occurrenceKey)
    ),
    notifications: [...notifications.values()].sort((left, right) =>
      left.occurrenceKey.localeCompare(right.occurrenceKey)
    ),
  };
}

export function recordNotificationRead(input: Readonly<{
  notification: NotificationProjection;
  userId: string;
  readAt: Date;
  expectedVersion: number | null;
}>): NotificationReadState {
  if (input.userId.trim().length === 0) {
    throw new TypeError("userId is required.");
  }
  return {
    notificationOccurrenceKey: input.notification.occurrenceKey,
    userId: input.userId,
    readAt: input.readAt,
    version: (input.expectedVersion ?? 0) + 1,
  };
}
