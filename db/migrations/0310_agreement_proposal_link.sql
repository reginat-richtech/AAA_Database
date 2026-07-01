-- 0310_agreement_proposal_link.sql
-- Deterministic proposal → agreement link.
--
-- The Project Tracker's "+ Upload agreement" button on a proposal-only card now
-- carries that proposal's id into Data Upload, and the saved agreement records it
-- here. The tracker then attaches the agreement to exactly that proposal by id,
-- instead of guessing via contract-number / customer-name matching (which failed
-- when a proposal had no contract number and the PDF's extracted name differed).
--
-- Nullable + ON DELETE SET NULL so agreements uploaded outside the proposal flow
-- (or whose proposal is later removed) still work; contract/name matching remains
-- the fallback.

alter table ops.legal_agreement
  add column if not exists proposal_id uuid references ops.project_proposal(id) on delete set null;

create index if not exists legal_agreement_proposal_id_idx
  on ops.legal_agreement(proposal_id);
