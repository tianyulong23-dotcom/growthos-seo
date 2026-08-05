import { createRequire } from "node:module";

type PgColumnBuilder<
  TName extends string,
  TDataType extends string,
  TColumnType extends string,
  TData,
  TDriverParam,
  THasDefault extends boolean,
> = {
  readonly _: {
    readonly brand: "ColumnBuilder";
    readonly name: TName;
    readonly dataType: TDataType;
    readonly columnType: TColumnType;
    readonly data: TData;
    readonly driverParam: TDriverParam;
    readonly notNull: true;
    readonly hasDefault: THasDefault;
    readonly enumValues: undefined;
    readonly identity: unknown;
    readonly generated: unknown;
    readonly dialect: "pg";
  };
  readonly config: {
    readonly name: string;
    readonly columnType: string;
    readonly notNull: boolean;
    readonly hasDefault: boolean;
    readonly default: unknown;
    readonly withTimezone?: boolean;
  };
};

type UuidColumn<TName extends string> = PgColumnBuilder<
  TName,
  "string",
  "PgUUID",
  string,
  string,
  false
>;
type TextColumn<TName extends string> = PgColumnBuilder<
  TName,
  "string",
  "PgText",
  string,
  string,
  false
>;
type TimestampColumn<TName extends string, THasDefault extends boolean> =
  PgColumnBuilder<
    TName,
    "date",
    "PgTimestamp",
    Date,
    string,
    THasDefault
  >;
type IntegerColumn<TName extends string, THasDefault extends boolean> =
  PgColumnBuilder<
    TName,
    "number",
    "PgInteger",
    number,
    number | string,
    THasDefault
  >;

const require = createRequire(import.meta.url);
const { uuid } = require("drizzle-orm/pg-core/columns/uuid") as {
  readonly uuid: <TName extends string>(
    name: TName,
  ) => { notNull(): UuidColumn<TName> };
};
const { text } = require("drizzle-orm/pg-core/columns/text") as {
  readonly text: <TName extends string>(
    name: TName,
  ) => { notNull(): TextColumn<TName> };
};
const { timestamp } = require("drizzle-orm/pg-core/columns/timestamp") as {
  readonly timestamp: <TName extends string>(
    name: TName,
    config: { readonly mode: "date"; readonly withTimezone: true },
  ) => {
    notNull(): TimestampColumn<TName, false> & {
      defaultNow(): TimestampColumn<TName, true>;
    };
  };
};
const { integer } = require("drizzle-orm/pg-core/columns/integer") as {
  readonly integer: <TName extends string>(
    name: TName,
  ) => {
    notNull(): IntegerColumn<TName, false> & {
      default(value: number): IntegerColumn<TName, true>;
    };
  };
};

export function projectIdentityColumns() {
  return {
    organizationId: uuid("organization_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    websiteProjectId: uuid("website_project_id").notNull(),
  };
}

export function projectAuditColumns() {
  return {
    ...projectIdentityColumns(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  };
}

export function versionedProjectAuditColumns() {
  return {
    ...projectAuditColumns(),
    version: integer("version").notNull().default(1),
  };
}
