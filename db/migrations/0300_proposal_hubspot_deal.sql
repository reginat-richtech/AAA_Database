-- =====================================================================
-- AAA_Database :: connect a HubSpot deal to a project at Step 1 (proposal)
-- Target: PostgreSQL 16+   Depends on 0170_project_proposal.
--
-- The Project Tracker's entry point (ops.project_proposal) can now be linked to a
-- HubSpot deal. Connecting a deal also pulls its customer (company + primary
-- contact) from HubSpot into deal_customer, so the CRM is the source of truth for
-- who the project is for. Additive + idempotent.
-- =====================================================================
ALTER TABLE ops.project_proposal ADD COLUMN IF NOT EXISTS deal_id        text;        -- HubSpot deal objectId
ALTER TABLE ops.project_proposal ADD COLUMN IF NOT EXISTS deal_name      text;        -- cached deal name
ALTER TABLE ops.project_proposal ADD COLUMN IF NOT EXISTS deal_amount    numeric(16,2);
ALTER TABLE ops.project_proposal ADD COLUMN IF NOT EXISTS deal_customer  jsonb;       -- {company:{...}, contact:{...}} pulled from HubSpot
ALTER TABLE ops.project_proposal ADD COLUMN IF NOT EXISTS deal_linked_at timestamptz;

CREATE INDEX IF NOT EXISTS ix_project_proposal_deal ON ops.project_proposal (deal_id);
