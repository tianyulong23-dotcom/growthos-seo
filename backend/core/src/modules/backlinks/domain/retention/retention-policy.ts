export const retentionCategories = [
  "raw_html",
  "contact_evidence",
  "provider_raw_response",
  "seo_snapshot",
  "provider_usage",
  "audit",
  "lifecycle",
  "gmail_token",
  "project_data",
  "suppression",
] as const;

export type RetentionCategory = (typeof retentionCategories)[number];

export type RetentionPolicy = Readonly<{
  id: string;
  version: number;
  rules: Readonly<Record<
    RetentionCategory,
    Readonly<{ retainForMilliseconds: number }>
  >>;
}>;

export type RetentionRecord = Readonly<{
  id: string;
  category: RetentionCategory;
  retainedFrom: Date;
  legalHold: boolean;
  suppressionActive: boolean;
}>;

export function selectExpiredRetentionCandidates(input: Readonly<{
  now: Date;
  policy: RetentionPolicy;
  records: readonly RetentionRecord[];
}>) {
  const selected: RetentionRecord[] = [];
  const excluded: Array<Readonly<{
    id: string;
    category: RetentionCategory;
    reason:
      | "not_expired"
      | "legal_hold"
      | "audit_record"
      | "lifecycle_record"
      | "active_suppression";
  }>> = [];

  for (const record of input.records) {
    let reason:
      | "not_expired"
      | "legal_hold"
      | "audit_record"
      | "lifecycle_record"
      | "active_suppression"
      | null = null;
    if (record.legalHold) {
      reason = "legal_hold";
    } else if (record.category === "audit") {
      reason = "audit_record";
    } else if (record.category === "lifecycle") {
      reason = "lifecycle_record";
    } else if (
      record.category === "suppression"
      && record.suppressionActive
    ) {
      reason = "active_suppression";
    } else {
      const retainFor =
        input.policy.rules[record.category].retainForMilliseconds;
      if (
        !Number.isSafeInteger(retainFor)
        || retainFor < 0
        || record.retainedFrom.getTime() + retainFor > input.now.getTime()
      ) {
        reason = "not_expired";
      }
    }
    if (reason === null) {
      selected.push(record);
    } else {
      excluded.push({
        id: record.id,
        category: record.category,
        reason,
      });
    }
  }

  return {
    policyId: input.policy.id,
    policyVersion: input.policy.version,
    selected: selected.sort((left, right) => left.id.localeCompare(right.id)),
    excluded: excluded.sort((left, right) => left.id.localeCompare(right.id)),
  } as const;
}
