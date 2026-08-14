BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE OR REPLACE FUNCTION backlink_apply_inventory_monitor_policy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  computed_tier text;
  computed_interval integer;
  computed_jitter integer;
  direct_monitoring_eligible boolean;
BEGIN
  direct_monitoring_eligible :=
    NEW.source_type = 'USER_IMPORTED'
    OR NEW.placement_id IS NOT NULL
    OR NEW.pinned
    OR NEW.managed;
  computed_tier := CASE
    WHEN NEW.placement_id IS NOT NULL
      OR NEW.pinned
      OR NEW.managed
      OR NEW.provider_status = 'lost'
      THEN 'A'
    WHEN COALESCE(NEW.rank, 0) >= 60 THEN 'B'
    ELSE 'C'
  END;
  computed_interval := CASE computed_tier
    WHEN 'A' THEN 86400
    WHEN 'B' THEN 604800
    ELSE 2592000
  END;
  computed_jitter := CASE computed_tier
    WHEN 'A' THEN 3600
    WHEN 'B' THEN 21600
    ELSE 86400
  END;

  INSERT INTO backlink_inventory_monitor_policies (
    id, organization_id, workspace_id, website_project_id,
    inventory_item_id, tier, importance, monitoring_status,
    policy_version, normal_interval_seconds,
    suspected_recheck_interval_seconds, jitter_window_seconds,
    browser_fallback_enabled, next_check_at, provider_only_reason,
    created_at, updated_at, created_by, updated_by
  )
  VALUES (
    NEW.id, NEW.organization_id, NEW.workspace_id, NEW.website_project_id,
    NEW.id, computed_tier,
    CASE WHEN NEW.pinned THEN 'important' ELSE 'normal' END,
    CASE
      WHEN direct_monitoring_eligible THEN 'enabled'
      ELSE 'provider_only'
    END,
    'inventory-monitoring-v1', computed_interval,
    3600, computed_jitter, false,
    CASE WHEN direct_monitoring_eligible THEN now() ELSE NULL END,
    CASE
      WHEN direct_monitoring_eligible THEN NULL
      ELSE 'provider_inventory_requires_pin_or_management'
    END,
    now(), now(), NEW.created_by, NEW.updated_by
  )
  ON CONFLICT (
    organization_id, workspace_id, website_project_id,
    inventory_item_id, policy_version
  ) DO UPDATE SET
    tier=CASE
      WHEN backlink_inventory_monitor_policies.importance = 'important'
        THEN 'A'
      ELSE EXCLUDED.tier
    END,
    normal_interval_seconds=CASE
      WHEN backlink_inventory_monitor_policies.importance = 'important'
        THEN 86400
      ELSE EXCLUDED.normal_interval_seconds
    END,
    jitter_window_seconds=CASE
      WHEN backlink_inventory_monitor_policies.importance = 'important'
        THEN 3600
      ELSE EXCLUDED.jitter_window_seconds
    END,
    monitoring_status=CASE
      WHEN direct_monitoring_eligible THEN
        CASE
          WHEN backlink_inventory_monitor_policies.monitoring_status =
            'provider_only'
            THEN 'enabled'
          ELSE backlink_inventory_monitor_policies.monitoring_status
        END
      ELSE 'provider_only'
    END,
    next_check_at=CASE
      WHEN NOT direct_monitoring_eligible THEN NULL
      WHEN backlink_inventory_monitor_policies.monitoring_status =
        'provider_only'
        THEN now()
      WHEN backlink_inventory_monitor_policies.monitoring_status = 'enabled'
        THEN LEAST(
          backlink_inventory_monitor_policies.next_check_at,
          now()
        )
      ELSE backlink_inventory_monitor_policies.next_check_at
    END,
    provider_only_reason=CASE
      WHEN direct_monitoring_eligible THEN NULL
      ELSE 'provider_inventory_requires_pin_or_management'
    END,
    updated_at=now(),
    updated_by=EXCLUDED.updated_by,
    version=backlink_inventory_monitor_policies.version+1;

  RETURN NEW;
END;
$function$;

ALTER TABLE backlink_inventory_monitor_policies
  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_inventory_items
  NO FORCE ROW LEVEL SECURITY;

UPDATE backlink_inventory_monitor_policies policy
   SET monitoring_status='provider_only',
       next_check_at=NULL,
       provider_only_reason='provider_inventory_requires_pin_or_management',
       updated_at=now(),
       updated_by='migration-0053',
       version=policy.version+1
  FROM backlink_inventory_items inventory
 WHERE (
       inventory.organization_id,
       inventory.workspace_id,
       inventory.website_project_id,
       inventory.id
     )=(
       policy.organization_id,
       policy.workspace_id,
       policy.website_project_id,
       policy.inventory_item_id
     )
   AND inventory.source_type='DATAFORSEO'
   AND inventory.placement_id IS NULL
   AND NOT inventory.pinned
   AND NOT inventory.managed
   AND policy.monitoring_status<>'provider_only';

ALTER TABLE backlink_inventory_monitor_policies
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_inventory_items
  FORCE ROW LEVEL SECURITY;

COMMIT;
