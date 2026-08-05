import { z } from "zod";

const positiveIntegerStringSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());

const postgresConnectionStringSchema = z
  .url()
  .refine(
    (value) => {
      const protocol = new URL(value).protocol;
      return protocol === "postgres:" || protocol === "postgresql:";
    },
    { message: "resolved secret must be a PostgreSQL connection string" },
  );

export const backlinksDatabaseConfigSchema = z
  .object({
    DATABASE_URL_SECRET_REF: z.string().trim().min(1),
    BACKLINK_DB_STATEMENT_TIMEOUT_MS: positiveIntegerStringSchema,
    BACKLINK_DB_LOCK_TIMEOUT_MS: positiveIntegerStringSchema,
  })
  .strict();

export type BacklinksDatabaseConfig = z.output<
  typeof backlinksDatabaseConfigSchema
>;
export type BacklinksDatabaseProcess = "api" | "worker";

export type BacklinksDatabaseRoleContract = {
  readonly process: BacklinksDatabaseProcess;
  readonly privilegeRole: "growthos_backlinks_writer";
  readonly schema: "backlinks";
  readonly superuser: false;
  readonly bypassRls: false;
};

export type BacklinksNodePostgresPoolConfig = {
  readonly connectionString: string;
  readonly application_name: `growthos-backlinks-${BacklinksDatabaseProcess}`;
  readonly options: "-c search_path=backlinks,pg_catalog";
  readonly statement_timeout: number;
  readonly lock_timeout: number;
};

export type BacklinksDatabaseConnectionConfig = {
  readonly role: BacklinksDatabaseRoleContract;
  readonly pool: BacklinksNodePostgresPoolConfig;
};

export type BacklinksDatabaseClient<TPool, TDrizzleDatabase> = {
  readonly role: BacklinksDatabaseRoleContract;
  readonly pool: TPool;
  readonly drizzle: TDrizzleDatabase;
};

export function createBacklinksDatabaseConnectionConfig(
  process: BacklinksDatabaseProcess,
  config: BacklinksDatabaseConfig,
  resolvedConnectionString: string,
): BacklinksDatabaseConnectionConfig {
  const connectionString = postgresConnectionStringSchema.parse(
    resolvedConnectionString,
  );

  return {
    role: {
      process,
      privilegeRole: "growthos_backlinks_writer",
      schema: "backlinks",
      superuser: false,
      bypassRls: false,
    },
    pool: {
      connectionString,
      application_name: `growthos-backlinks-${process}`,
      options: "-c search_path=backlinks,pg_catalog",
      statement_timeout: config.BACKLINK_DB_STATEMENT_TIMEOUT_MS,
      lock_timeout: config.BACKLINK_DB_LOCK_TIMEOUT_MS,
    },
  };
}
