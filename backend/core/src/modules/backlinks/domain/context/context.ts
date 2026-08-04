export type ActorContext = Readonly<{
  userId: string;
  sessionId: string;
  roles: readonly string[];
}>;

export type TenantContext = Readonly<{
  organizationId: string;
  workspaceId: string;
}>;

export type ProjectContext = Readonly<{
  websiteProjectId: string;
  canonicalDomain: string;
  locale: string;
  countryCode: string;
  profileVersionId: string;
  promotionTargetVersionId: string;
}>;

function assertNonBlank(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}

export function createActorContext(input: ActorContext): ActorContext {
  assertNonBlank("userId", input.userId);
  assertNonBlank("sessionId", input.sessionId);

  return Object.freeze({
    ...input,
    roles: Object.freeze([...input.roles]),
  });
}

export function createTenantContext(input: TenantContext): TenantContext {
  assertNonBlank("organizationId", input.organizationId);
  assertNonBlank("workspaceId", input.workspaceId);

  return Object.freeze({ ...input });
}

export function createProjectContext(input: ProjectContext): ProjectContext {
  assertNonBlank("websiteProjectId", input.websiteProjectId);
  assertNonBlank("canonicalDomain", input.canonicalDomain);
  assertNonBlank("locale", input.locale);
  assertNonBlank("countryCode", input.countryCode);
  assertNonBlank("profileVersionId", input.profileVersionId);
  assertNonBlank("promotionTargetVersionId", input.promotionTargetVersionId);

  return Object.freeze({ ...input });
}
