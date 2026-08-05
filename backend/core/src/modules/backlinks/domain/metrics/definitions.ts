export const backlinkMetricDefinitionContractVersion =
  "backlink-metric-definition.v1" as const;

export const backlinkMetricKeys = Object.freeze([
  "draft_approval_count",
  "send_count",
  "reply_rate",
  "negotiation_conversion_rate",
  "link_acquisition_rate",
  "gained_placement_count",
  "active_placement_count",
  "suspected_lost_placement_count",
  "lost_placement_count",
  "recovered_placement_count",
] as const);

export type BacklinkMetricKey = (typeof backlinkMetricKeys)[number];

export type BacklinkMetricSource = Readonly<{
  kind: "IMMUTABLE_FACT" | "LIFECYCLE_EVENT";
  name: string;
  eventType?: string;
  contractVersion: string;
  businessTimeField: string;
  predicate: string;
  immutable: true;
}>;

export type BacklinkMetricDefinition = Readonly<{
  metricKey: BacklinkMetricKey;
  name: string;
  description: string;
  definitionVersion: `${BacklinkMetricKey}.v1`;
  valueType: "COUNT" | "RATE";
  sources: readonly BacklinkMetricSource[];
  businessTime: string;
  window: Readonly<{
    kind: "LOCAL_INTERVAL" | "COHORT" | "LOCAL_DAY_END";
    startBoundary: "INCLUSIVE";
    endBoundary: "EXCLUSIVE";
    asOfBoundary: "INCLUSIVE";
  }>;
  timezone: Readonly<{
    sourceTimestampZone: "UTC";
    reportingTimezoneSource: "WORKSPACE_IANA_TIMEZONE";
    browserTimezoneAllowed: false;
  }>;
  numerator: Readonly<{
    unit: string;
    rule: string;
  }>;
  denominator: Readonly<{
    unit: string;
    rule: string;
    zeroResult: null;
  }> | null;
  dedupeKey: readonly string[];
  allowedDimensions: readonly [
    "website_project_id",
    "keyword",
    "market",
    "collaboration_mode",
    "owner_id",
  ];
  lateData: Readonly<{
    preserveBusinessOccurredAt: true;
    openWindowAction: "RECOMPUTE";
    finalizedWindowAction: "APPEND_CORRECTION_REVISION";
    inPlaceResultMutationAllowed: false;
  }>;
  placementSuccessPolicy?: Readonly<{
    requiredLifecycleEvent: "placement.confirmed";
    candidateCountsTowardSuccess: false;
  }>;
}>;

const allowedDimensions = Object.freeze([
  "website_project_id",
  "keyword",
  "market",
  "collaboration_mode",
  "owner_id",
] as const);

const timezone = Object.freeze({
  sourceTimestampZone: "UTC" as const,
  reportingTimezoneSource: "WORKSPACE_IANA_TIMEZONE" as const,
  browserTimezoneAllowed: false as const,
});

const lateData = Object.freeze({
  preserveBusinessOccurredAt: true as const,
  openWindowAction: "RECOMPUTE" as const,
  finalizedWindowAction: "APPEND_CORRECTION_REVISION" as const,
  inPlaceResultMutationAllowed: false as const,
});

const localInterval = Object.freeze({
  kind: "LOCAL_INTERVAL" as const,
  startBoundary: "INCLUSIVE" as const,
  endBoundary: "EXCLUSIVE" as const,
  asOfBoundary: "INCLUSIVE" as const,
});

const cohort = Object.freeze({
  ...localInterval,
  kind: "COHORT" as const,
});

const localDayEnd = Object.freeze({
  ...localInterval,
  kind: "LOCAL_DAY_END" as const,
});

const placementSuccessPolicy = Object.freeze({
  requiredLifecycleEvent: "placement.confirmed" as const,
  candidateCountsTowardSuccess: false as const,
});

function immutableFact(
  name: string,
  contractVersion: string,
  businessTimeField: string,
  predicate: string,
): BacklinkMetricSource {
  return Object.freeze({
    kind: "IMMUTABLE_FACT",
    name,
    contractVersion,
    businessTimeField,
    predicate,
    immutable: true,
  });
}

function lifecycleEvent(
  eventType: string,
  contractVersion: string,
  businessTimeField: string,
  predicate: string,
): BacklinkMetricSource {
  return Object.freeze({
    kind: "LIFECYCLE_EVENT",
    name: "backlink_lifecycle_events",
    eventType,
    contractVersion,
    businessTimeField,
    predicate,
    immutable: true,
  });
}

function defineMetric(
  definition: Omit<
    BacklinkMetricDefinition,
    "allowedDimensions" | "lateData" | "timezone"
  >,
): BacklinkMetricDefinition {
  return Object.freeze({
    ...definition,
    allowedDimensions,
    timezone,
    lateData,
  });
}

const successfulSendSources = Object.freeze([
  immutableFact(
    "backlink_send_attempts",
    "migration-0024",
    "completed_at",
    "status = PROVIDER_ACCEPTED",
  ),
  immutableFact(
    "backlink_send_reconciliations",
    "migration-0025",
    "reconciled_at",
    "outcome = PROVIDER_ACCEPTED",
  ),
]);

const validHumanReplySources = Object.freeze([
  lifecycleEvent(
    "reply.assignment.recorded",
    "reply-assignment-fact.v1",
    "after_state.occurredAt",
    "matchAuthority in [AUTO, MANUAL]",
  ),
  immutableFact(
    "backlink_reply_classification_versions",
    "migration-0027",
    "classified_at",
    "latest version by as-of has classification_code in [POSITIVE, NEGATIVE, QUESTION]",
  ),
]);

const placementConfirmedSource = lifecycleEvent(
  "placement.confirmed",
  "event-schema.v1",
  "created_at",
  "aggregate_type = placement",
);

const placementStatusDecisionSource = lifecycleEvent(
  "placement.monitoring.status_decided",
  "placement.monitoring.status-decision.v1",
  "after_state.occurredAt",
  "contractVersion = placement.monitoring.status-decision.v1",
);

const placementStateSources = Object.freeze([
  placementConfirmedSource,
  placementStatusDecisionSource,
]);

export const backlinkMetricDefinitions = Object.freeze([
  defineMetric({
    metricKey: "draft_approval_count",
    name: "Draft approval count",
    description:
      "Unique immutable Draft Versions approved during the reporting interval.",
    definitionVersion: "draft_approval_count.v1",
    valueType: "COUNT",
    sources: Object.freeze([
      lifecycleEvent(
        "draft.approval.recorded",
        "draft-approval-fact.v1",
        "after_state.occurredAt",
        "nextStatus = approved and approvedVersionId is present",
      ),
    ]),
    businessTime: "Draft approval fact occurredAt.",
    window: localInterval,
    numerator: Object.freeze({
      unit: "draft_version",
      rule:
        "Distinct approvedVersionId from draft.approval.recorded inside the local interval.",
    }),
    denominator: null,
    dedupeKey: Object.freeze(["approved_version_id"]),
  }),
  defineMetric({
    metricKey: "send_count",
    name: "Provider-accepted send count",
    description:
      "Unique SendIntents whose delivery was accepted by the provider.",
    definitionVersion: "send_count.v1",
    valueType: "COUNT",
    sources: successfulSendSources,
    businessTime:
      "Terminal provider acceptance time from completed_at or reconciled_at.",
    window: localInterval,
    numerator: Object.freeze({
      unit: "send_intent",
      rule:
        "Distinct SendIntent with a PROVIDER_ACCEPTED Attempt or PROVIDER_ACCEPTED reconciliation inside the local interval.",
    }),
    denominator: null,
    dedupeKey: Object.freeze(["send_intent_id"]),
  }),
  defineMetric({
    metricKey: "reply_rate",
    name: "Valid human reply rate",
    description:
      "Share of first-contacted provider threads with a valid human reply by as-of.",
    definitionVersion: "reply_rate.v1",
    valueType: "RATE",
    sources: Object.freeze([
      ...successfulSendSources,
      ...validHumanReplySources,
    ]),
    businessTime:
      "Cohort membership uses first provider acceptance; reply qualification uses assignment occurredAt and classification available by as-of.",
    window: cohort,
    numerator: Object.freeze({
      unit: "provider_thread",
      rule:
        "Cohort provider thread with at least one assigned reply classified POSITIVE, NEGATIVE, or QUESTION by as-of; OUT_OF_OFFICE and UNKNOWN are excluded.",
    }),
    denominator: Object.freeze({
      unit: "provider_thread",
      rule:
        "Unique provider thread whose first provider-accepted outbound SendIntent occurred inside the local cohort interval.",
      zeroResult: null,
    }),
    dedupeKey: Object.freeze(["provider_thread_id"]),
  }),
  defineMetric({
    metricKey: "negotiation_conversion_rate",
    name: "Negotiation conversion rate",
    description:
      "Share of Opportunities with a first valid human reply that entered negotiation by as-of.",
    definitionVersion: "negotiation_conversion_rate.v1",
    valueType: "RATE",
    sources: Object.freeze([
      ...validHumanReplySources,
      lifecycleEvent(
        "opportunity.business_stage.transitioned",
        "event-schema.v1",
        "created_at",
        "after_state.businessStage = NEGOTIATING",
      ),
    ]),
    businessTime:
      "Cohort membership uses first valid reply assignment occurredAt; conversion uses the first transition to NEGOTIATING by as-of.",
    window: cohort,
    numerator: Object.freeze({
      unit: "opportunity",
      rule:
        "Cohort Opportunity with at least one immutable transition into NEGOTIATING by as-of.",
    }),
    denominator: Object.freeze({
      unit: "opportunity",
      rule:
        "Unique Opportunity whose first valid human reply occurred inside the local cohort interval.",
      zeroResult: null,
    }),
    dedupeKey: Object.freeze(["opportunity_id"]),
  }),
  defineMetric({
    metricKey: "link_acquisition_rate",
    name: "Link acquisition rate",
    description:
      "Share of first-contacted Opportunities with a confirmed Placement by as-of.",
    definitionVersion: "link_acquisition_rate.v1",
    valueType: "RATE",
    sources: Object.freeze([
      ...successfulSendSources,
      lifecycleEvent(
        "placement.confirmed",
        "event-schema.v1",
        "created_at",
        "aggregate_type = placement",
      ),
    ]),
    businessTime:
      "Cohort membership uses first provider-accepted INITIAL_OUTREACH time; acquisition uses placement.confirmed time by as-of.",
    window: cohort,
    numerator: Object.freeze({
      unit: "opportunity",
      rule:
        "Cohort Opportunity with at least one promoted Placement carrying placement.confirmed by as-of.",
    }),
    denominator: Object.freeze({
      unit: "opportunity",
      rule:
        "Unique Opportunity whose first provider-accepted INITIAL_OUTREACH SendIntent occurred inside the local cohort interval.",
      zeroResult: null,
    }),
    dedupeKey: Object.freeze(["opportunity_id"]),
    placementSuccessPolicy,
  }),
  defineMetric({
    metricKey: "gained_placement_count",
    name: "Gained Placement count",
    description:
      "Unique promoted Placements first confirmed during the reporting interval.",
    definitionVersion: "gained_placement_count.v1",
    valueType: "COUNT",
    sources: Object.freeze([placementConfirmedSource]),
    businessTime: "placement.confirmed created_at.",
    window: localInterval,
    numerator: Object.freeze({
      unit: "placement",
      rule:
        "Distinct Placement carrying its first placement.confirmed event inside the local interval.",
    }),
    denominator: null,
    dedupeKey: Object.freeze(["placement_id"]),
    placementSuccessPolicy,
  }),
  defineMetric({
    metricKey: "active_placement_count",
    name: "Active Placement count",
    description:
      "Unique confirmed Placements whose reconstructed local day-end health status is active.",
    definitionVersion: "active_placement_count.v1",
    valueType: "COUNT",
    sources: placementStateSources,
    businessTime:
      "Fold confirmed and monitoring decision facts through the local day-end as-of.",
    window: localDayEnd,
    numerator: Object.freeze({
      unit: "placement",
      rule:
        "Distinct confirmed Placement whose latest status fact by local day-end has nextHealthStatus = active.",
    }),
    denominator: null,
    dedupeKey: Object.freeze(["placement_id"]),
    placementSuccessPolicy,
  }),
  defineMetric({
    metricKey: "suspected_lost_placement_count",
    name: "Suspected-lost Placement count",
    description:
      "Unique confirmed Placements reconstructed as suspected_lost at local day-end.",
    definitionVersion: "suspected_lost_placement_count.v1",
    valueType: "COUNT",
    sources: placementStateSources,
    businessTime:
      "Fold confirmed and monitoring decision facts through the local day-end as-of.",
    window: localDayEnd,
    numerator: Object.freeze({
      unit: "placement",
      rule:
        "Distinct confirmed Placement whose latest status fact by local day-end has nextHealthStatus = suspected_lost.",
    }),
    denominator: null,
    dedupeKey: Object.freeze(["placement_id"]),
    placementSuccessPolicy,
  }),
  defineMetric({
    metricKey: "lost_placement_count",
    name: "Lost Placement count",
    description:
      "Unique confirmed Placements reconstructed as lost at local day-end.",
    definitionVersion: "lost_placement_count.v1",
    valueType: "COUNT",
    sources: placementStateSources,
    businessTime:
      "Fold confirmed and monitoring decision facts through the local day-end as-of.",
    window: localDayEnd,
    numerator: Object.freeze({
      unit: "placement",
      rule:
        "Distinct confirmed Placement whose latest status fact by local day-end has nextHealthStatus = lost.",
    }),
    denominator: null,
    dedupeKey: Object.freeze(["placement_id"]),
    placementSuccessPolicy,
  }),
  defineMetric({
    metricKey: "recovered_placement_count",
    name: "Recovered Placement count",
    description:
      "Confirmed Placement recovery decisions recorded during the reporting interval.",
    definitionVersion: "recovered_placement_count.v1",
    valueType: "COUNT",
    sources: placementStateSources,
    businessTime: "Monitoring status decision occurredAt.",
    window: localInterval,
    numerator: Object.freeze({
      unit: "monitoring_status_decision",
      rule:
        "Monitoring decision inside the local interval with previousHealthStatus in [lost, suspected_lost] and nextHealthStatus = active.",
    }),
    denominator: null,
    dedupeKey: Object.freeze(["monitor_run_id"]),
    placementSuccessPolicy,
  }),
] satisfies readonly BacklinkMetricDefinition[]);
