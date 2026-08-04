import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";

export type ReportExportScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type ReportExportFormat = "csv" | "xlsx" | "pdf";
export type StoredReportExportStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";
export type ReportExportStatus = StoredReportExportStatus | "expired";

export type ReportExportObjectReference = Readonly<{
  objectKey: string;
  contentType: string;
  contentLength: number;
  sha256: string;
  storagePolicyVersion: string;
}>;

export type ReportExportRecord = ReportExportScope & Readonly<{
  id: string;
  reportKey: string;
  reportRevisionId: string;
  format: ReportExportFormat;
  status: StoredReportExportStatus;
  requestedBy: string;
  correlationId: string;
  objectReference: ReportExportObjectReference | null;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
  failureCode: string | null;
}>;

export type ReportExportView = Omit<ReportExportRecord, "status"> & Readonly<{
  status: ReportExportStatus;
}>;

export type ReportExportRepository = Readonly<{
  create(record: ReportExportRecord): Promise<void>;
  get(
    scope: ReportExportScope,
    exportId: string,
  ): Promise<ReportExportRecord | null>;
  claim(
    scope: ReportExportScope,
    exportId: string,
  ): Promise<ReportExportRecord | null>;
  complete(input: Readonly<{
    scope: ReportExportScope;
    exportId: string;
    objectReference: ReportExportObjectReference;
    completedAt: Date;
    expiresAt: Date;
  }>): Promise<ReportExportRecord>;
  fail(input: Readonly<{
    scope: ReportExportScope;
    exportId: string;
    failedAt: Date;
    failureCode: string;
  }>): Promise<ReportExportRecord>;
}>;

export type ReportExportWorkflow = ReturnType<
  typeof createReportExportWorkflow
>;

type RenderedReportExport = Readonly<{
  body: Uint8Array;
  contentType: string;
  filename: string;
}>;

type ReportExportRequestInput = Readonly<{
  scope: ReportExportScope;
  reportKey: string;
  reportRevisionId: string;
  format: ReportExportFormat;
  requestedBy: string;
  correlationId: string;
}>;

function assertNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} is required.`);
  }
}

function unavailable(code: "BACKLINK_ACCESS_DENIED" | "BACKLINK_NOT_FOUND") {
  return new BacklinkError({
    code:
      code === "BACKLINK_ACCESS_DENIED"
        ? backlinkErrorCodes.accessDenied
        : backlinkErrorCodes.notFound,
    message:
      code === "BACKLINK_ACCESS_DENIED"
        ? "The export is not available to this actor."
        : "The export is not available.",
  });
}

function viewAt(record: ReportExportRecord, now: Date): ReportExportView {
  if (
    record.status === "completed"
    && record.expiresAt !== null
    && record.expiresAt.getTime() <= now.getTime()
  ) {
    return { ...record, status: "expired" };
  }
  return record;
}

export function createReportExportWorkflow(dependencies: Readonly<{
  repository: ReportExportRepository;
  queue: Readonly<{
    enqueue(input: Readonly<{
      scope: ReportExportScope;
      exportId: string;
      correlationId: string;
    }>): Promise<void>;
  }>;
  renderers: Partial<Record<
    ReportExportFormat,
    Readonly<{
      render(input: Readonly<{
        scope: ReportExportScope;
        reportKey: string;
        reportRevisionId: string;
        exportId: string;
      }>): Promise<RenderedReportExport>;
    }>
  >>;
  storage: Readonly<{
    putPrivate(input: Readonly<{
      scope: ReportExportScope;
      exportId: string;
      rendered: RenderedReportExport;
    }>): Promise<ReportExportObjectReference>;
    authorizeDownload(input: Readonly<{
      scope: ReportExportScope;
      objectReference: ReportExportObjectReference;
      actorId: string;
    }>): Promise<Readonly<{ url: string; expiresAt: Date }>>;
  }>;
  access: Readonly<{
    canRead(input: Readonly<{
      record: ReportExportRecord;
      actorId: string;
    }>): boolean;
  }>;
  newId(): string;
  now(): Date;
  expiryMilliseconds: number;
}>) {
  if (
    !Number.isInteger(dependencies.expiryMilliseconds)
    || dependencies.expiryMilliseconds <= 0
  ) {
    throw new TypeError("Export expiry must be a positive integer.");
  }

  const loadAuthorized = async (
    scope: ReportExportScope,
    exportId: string,
    actorId: string,
  ) => {
    const record = await dependencies.repository.get(scope, exportId);
    if (record === null) {
      throw unavailable("BACKLINK_NOT_FOUND");
    }
    if (!dependencies.access.canRead({ record, actorId })) {
      throw unavailable("BACKLINK_ACCESS_DENIED");
    }
    return record;
  };

  return {
    async request(input: ReportExportRequestInput): Promise<ReportExportView> {
      assertNonBlank(input.reportKey, "reportKey");
      assertNonBlank(input.reportRevisionId, "reportRevisionId");
      assertNonBlank(input.requestedBy, "requestedBy");
      assertNonBlank(input.correlationId, "correlationId");
      const record: ReportExportRecord = {
        id: dependencies.newId(),
        ...input.scope,
        reportKey: input.reportKey,
        reportRevisionId: input.reportRevisionId,
        format: input.format,
        status: "queued",
        requestedBy: input.requestedBy,
        correlationId: input.correlationId,
        objectReference: null,
        createdAt: dependencies.now(),
        completedAt: null,
        expiresAt: null,
        failureCode: null,
      };
      await dependencies.repository.create(record);
      await dependencies.queue.enqueue({
        scope: input.scope,
        exportId: record.id,
        correlationId: input.correlationId,
      });
      return record;
    },

    async run(input: Readonly<{
      scope: ReportExportScope;
      exportId: string;
    }>): Promise<ReportExportView> {
      const record = await dependencies.repository.claim(
        input.scope,
        input.exportId,
      );
      if (record === null) {
        throw unavailable("BACKLINK_NOT_FOUND");
      }
      const renderer = dependencies.renderers[record.format];
      if (renderer === undefined) {
        return dependencies.repository.fail({
          scope: input.scope,
          exportId: input.exportId,
          failedAt: dependencies.now(),
          failureCode:
            record.format === "pdf"
              ? "PDF_EXPORT_DISABLED"
              : "REPORT_EXPORT_RENDERER_UNAVAILABLE",
        });
      }
      try {
        const rendered = await renderer.render({
          scope: input.scope,
          reportKey: record.reportKey,
          reportRevisionId: record.reportRevisionId,
          exportId: record.id,
        });
        const objectReference = await dependencies.storage.putPrivate({
          scope: input.scope,
          exportId: record.id,
          rendered,
        });
        const completedAt = dependencies.now();
        return dependencies.repository.complete({
          scope: input.scope,
          exportId: record.id,
          objectReference,
          completedAt,
          expiresAt: new Date(
            completedAt.getTime() + dependencies.expiryMilliseconds,
          ),
        });
      } catch (error) {
        await dependencies.repository.fail({
          scope: input.scope,
          exportId: record.id,
          failedAt: dependencies.now(),
          failureCode: "REPORT_EXPORT_FAILED",
        });
        throw error;
      }
    },

    async get(input: Readonly<{
      scope: ReportExportScope;
      exportId: string;
      actorId: string;
    }>): Promise<ReportExportView> {
      return viewAt(
        await loadAuthorized(input.scope, input.exportId, input.actorId),
        dependencies.now(),
      );
    },

    async authorizeDownload(input: Readonly<{
      scope: ReportExportScope;
      exportId: string;
      actorId: string;
    }>): Promise<Readonly<{ url: string; expiresAt: Date }>> {
      const record = await loadAuthorized(
        input.scope,
        input.exportId,
        input.actorId,
      );
      const view = viewAt(record, dependencies.now());
      if (view.status === "expired" || record.objectReference === null) {
        throw unavailable("BACKLINK_NOT_FOUND");
      }
      if (view.status !== "completed") {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message: "The export is not ready for download.",
        });
      }
      return dependencies.storage.authorizeDownload({
        scope: input.scope,
        objectReference: record.objectReference,
        actorId: input.actorId,
      });
    },
  };
}
