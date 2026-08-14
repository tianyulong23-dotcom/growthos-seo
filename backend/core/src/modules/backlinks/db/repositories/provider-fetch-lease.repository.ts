export type ProviderFetchLeaseQueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<
    Readonly<{ rows: readonly Record<string, unknown>[] }>
  >;
}>;

export type ProviderFetchLeaseState = Readonly<{
  acquired: boolean;
  status: "acquired" | "completed" | "failed" | "expired" | "unknown_charge";
  ownerRequestId: string;
  leaseExpiresAt: Date;
}>;

export function createProviderFetchLeaseRepository(
  client: ProviderFetchLeaseQueryClient,
) {
  return {
    async acquire(input: Readonly<{
      artifactFingerprint: string;
      ownerRequestId: string;
      acquiredAt: Date;
      leaseExpiresAt: Date;
    }>): Promise<ProviderFetchLeaseState> {
      const result = await client.query(`
        WITH attempted AS (
          INSERT INTO provider_fetch_leases (
            artifact_fingerprint,status,owner_request_id,lease_expires_at,
            heartbeat_at,created_at,updated_at
          ) VALUES ($1,'acquired',$2,$4,$3,$3,$3)
          ON CONFLICT (artifact_fingerprint) DO UPDATE SET
            status='acquired',
            owner_request_id=EXCLUDED.owner_request_id,
            lease_expires_at=EXCLUDED.lease_expires_at,
            heartbeat_at=EXCLUDED.heartbeat_at,
            attempt_count=provider_fetch_leases.attempt_count+1,
            failure_code=NULL,
            updated_at=EXCLUDED.updated_at
          WHERE provider_fetch_leases.status IN (
              'completed', 'failed', 'expired'
            )
             OR (
               provider_fetch_leases.status='acquired'
               AND provider_fetch_leases.lease_expires_at<=EXCLUDED.heartbeat_at
             )
          RETURNING true AS acquired,status,owner_request_id,lease_expires_at
        )
        SELECT acquired,status,owner_request_id AS "ownerRequestId",
          lease_expires_at AS "leaseExpiresAt"
        FROM attempted
        UNION ALL
        SELECT false,status,owner_request_id,lease_expires_at
        FROM provider_fetch_leases
        WHERE artifact_fingerprint=$1 AND NOT EXISTS (SELECT 1 FROM attempted)
        LIMIT 1
      `, [
        input.artifactFingerprint,
        input.ownerRequestId,
        input.acquiredAt,
        input.leaseExpiresAt,
      ]);
      const row = result.rows[0] ?? (await client.query(`
        SELECT false AS acquired,status,
          owner_request_id AS "ownerRequestId",
          lease_expires_at AS "leaseExpiresAt"
        FROM provider_fetch_leases WHERE artifact_fingerprint=$1
      `, [input.artifactFingerprint])).rows[0];
      if (row === undefined) {
        throw new Error("DATAFORSEO_LEASE_STATE_MISSING");
      }
      return {
        acquired: row.acquired === true,
        status: row.status as ProviderFetchLeaseState["status"],
        ownerRequestId: String(row.ownerRequestId),
        leaseExpiresAt: new Date(String(row.leaseExpiresAt)),
      };
    },

    async read(artifactFingerprint: string):
    Promise<Omit<ProviderFetchLeaseState, "acquired"> | null> {
      const result = await client.query(`
        SELECT status,owner_request_id AS "ownerRequestId",
          lease_expires_at AS "leaseExpiresAt"
        FROM provider_fetch_leases WHERE artifact_fingerprint=$1
      `, [artifactFingerprint]);
      const row = result.rows[0];
      return row === undefined ? null : {
        status: row.status as ProviderFetchLeaseState["status"],
        ownerRequestId: String(row.ownerRequestId),
        leaseExpiresAt: new Date(String(row.leaseExpiresAt)),
      };
    },

    async heartbeat(input: Readonly<{
      artifactFingerprint: string;
      ownerRequestId: string;
      heartbeatAt: Date;
      leaseExpiresAt: Date;
    }>): Promise<boolean> {
      const result = await client.query(`
        UPDATE provider_fetch_leases SET heartbeat_at=$3,lease_expires_at=$4,
          updated_at=$3
        WHERE artifact_fingerprint=$1 AND owner_request_id=$2
          AND status='acquired' AND lease_expires_at>$3
        RETURNING artifact_fingerprint
      `, [
        input.artifactFingerprint,
        input.ownerRequestId,
        input.heartbeatAt,
        input.leaseExpiresAt,
      ]);
      return result.rows[0] !== undefined;
    },

    async fail(input: Readonly<{
      artifactFingerprint: string;
      ownerRequestId: string;
      status: "failed" | "unknown_charge";
      failureCode: string;
      failedAt: Date;
    }>): Promise<void> {
      await client.query(`
        UPDATE provider_fetch_leases SET status=$3,failure_code=$4,
          heartbeat_at=$5,lease_expires_at=$5,updated_at=$5
        WHERE artifact_fingerprint=$1 AND owner_request_id=$2
          AND status='acquired'
      `, [
        input.artifactFingerprint,
        input.ownerRequestId,
        input.status,
        input.failureCode,
        input.failedAt,
      ]);
    },
  };
}
