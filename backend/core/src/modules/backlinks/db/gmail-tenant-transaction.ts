import type {
  BacklinkTenantPool,
  BacklinkTransactionClient,
} from "./tenant-transaction.js";

export type GmailTenantContext = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export async function withGmailTenantTransaction<Result>(
  pool: BacklinkTenantPool,
  context: GmailTenantContext,
  work: (transaction: BacklinkTransactionClient) => Promise<Result>,
): Promise<Result> {
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
