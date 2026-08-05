export type BacklinkTenantContext = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;
export type BacklinkTransactionQueryResult = Readonly<{
  rows: Record<string, unknown>[];
  rowCount: number | null;
}>;

export type BacklinkTransactionClient = {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<BacklinkTransactionQueryResult>;
};

export type BacklinkTenantPoolClient = BacklinkTransactionClient & {
  release(): void;
};
export type BacklinkTenantPool = { connect(): Promise<BacklinkTenantPoolClient> };

export async function withBacklinkTenantTransaction<T>(
  pool: BacklinkTenantPool,
  context: BacklinkTenantContext,
  work: (transaction: BacklinkTransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    try {
      await client.query(
        `SELECT set_config('app.current_organization_id', $1, true),
                set_config('app.current_workspace_id', $2, true),
                set_config('app.current_website_project_id', $3, true)`,
        [
          context.organizationId,
          context.workspaceId,
          context.websiteProjectId,
        ],
      );
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}
