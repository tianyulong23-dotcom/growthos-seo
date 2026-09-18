// Both arguments are static SQL expressions owned by the repository, never user input.
export function observedContactPageSql(scope: string, reason: string): string {
  return `SELECT page.observed_page_url
    FROM backlinks.backlink_contact_enrichment_jobs page_job
    JOIN backlinks.backlink_contact_enrichment_pages page
      ON (page.organization_id,page.workspace_id,page.website_project_id,page.job_id)=
         (page_job.organization_id,page_job.workspace_id,page_job.website_project_id,page_job.id)
   WHERE (page_job.organization_id,page_job.workspace_id,page_job.website_project_id,
          page_job.recommendation_context_version_id,page_job.prospect_id,page_job.recommendation_id)=
         (${scope}.organization_id,${scope}.workspace_id,${scope}.website_project_id,
          ${scope}.recommendation_context_version_id,${scope}.prospect_id,${scope}.recommendation_id)
     AND page_job.completed_at IS NOT NULL
     AND page_job.terminal_reason_code=${reason}
     AND page.contact_page_kind=page_job.terminal_reason_code
     AND page.observed_page_url IS NOT NULL
   ORDER BY page_job.completed_at DESC,page.observed_at DESC,page.id
   LIMIT 1`;
}
