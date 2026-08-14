import {
  BacklinkError,
  backlinkErrorCodes,
} from "../errors/backlink-error.js";
import {
  createRecommendationDomainKey,
} from "../recommendations/domain-key.js";

export type ProjectSettingsScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type ProjectSettingsValues = Readonly<{
  reportingTimezone: string;
  reportLookbackDays: number;
  exportExpiryHours: number;
  discoveryTargetAudiences?: readonly string[];
  discoveryPartnershipGoals?: readonly string[];
  discoveryExplicitCompetitorDomains?: readonly string[];
}>;

export type ProjectSettingsVersion = ProjectSettingsScope & Readonly<{
  id: string;
  version: number;
  values: ProjectSettingsValues;
  createdAt: Date;
  createdBy: string;
}>;

export type ProjectSettingsRepository = Readonly<{
  getCurrent(scope: ProjectSettingsScope): Promise<ProjectSettingsVersion | null>;
  append(input: Readonly<{
    id: string;
    scope: ProjectSettingsScope;
    expectedVersion: number;
    values: ProjectSettingsValues;
    createdAt: Date;
    createdBy: string;
  }>): Promise<ProjectSettingsVersion>;
}>;

function assertValues(values: ProjectSettingsValues): void {
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: values.reportingTimezone,
    }).format(0);
  } catch {
    throw new TypeError("reportingTimezone must be a valid IANA timezone.");
  }
  if (
    !Number.isInteger(values.reportLookbackDays)
    || values.reportLookbackDays < 1
    || values.reportLookbackDays > 366
  ) {
    throw new TypeError("reportLookbackDays must be between 1 and 366.");
  }
  if (
    !Number.isInteger(values.exportExpiryHours)
    || values.exportExpiryHours < 1
    || values.exportExpiryHours > 168
  ) {
    throw new TypeError("exportExpiryHours must be between 1 and 168.");
  }
  for (const [name, items] of [
    ["discoveryTargetAudiences", values.discoveryTargetAudiences ?? []],
    ["discoveryPartnershipGoals", values.discoveryPartnershipGoals ?? []],
  ] as const) {
    if (
      items.length > 100
      || items.some((item) =>
        item.trim().length === 0 || item.trim().length > 2_048
      )
    ) {
      throw new TypeError(`${name} must contain bounded non-blank strings.`);
    }
  }
  const competitors = values.discoveryExplicitCompetitorDomains ?? [];
  if (competitors.length > 100) {
    throw new TypeError(
      "discoveryExplicitCompetitorDomains must contain at most 100 domains.",
    );
  }
  for (const competitor of competitors) {
    try {
      createRecommendationDomainKey(competitor);
    } catch {
      throw new TypeError(
        "discoveryExplicitCompetitorDomains contains an invalid domain.",
      );
    }
  }
}

export function createProjectSettingsService(dependencies: Readonly<{
  repository: ProjectSettingsRepository;
  newId(): string;
  now(): Date;
}>) {
  return {
    async getCurrent(scope: ProjectSettingsScope) {
      return dependencies.repository.getCurrent(scope);
    },

    async update(input: Readonly<{
      scope: ProjectSettingsScope;
      expectedVersion: number;
      values: ProjectSettingsValues;
      actorId: string;
    }>) {
      assertValues(input.values);
      const current = await dependencies.repository.getCurrent(input.scope);
      if (
        current === null
        || current.version !== input.expectedVersion
      ) {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message: "Settings version conflict.",
        });
      }
      return dependencies.repository.append({
        id: dependencies.newId(),
        scope: input.scope,
        expectedVersion: input.expectedVersion,
        values: input.values,
        createdAt: dependencies.now(),
        createdBy: input.actorId,
      });
    },

    async bindAtJobStart(scope: ProjectSettingsScope) {
      const current = await dependencies.repository.getCurrent(scope);
      if (current === null) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Project settings are not configured.",
        });
      }
      return {
        settingsVersionId: current.id,
        settingsVersion: current.version,
        values: current.values,
      } as const;
    },
  };
}
