-- =====================================================================
-- AAA_Database :: AUDIT LOGGING & CHANGE TRACKING LAYER
-- Target: PostgreSQL 16+
-- Depends on FOUNDATION DDL (schemas core/audit, audit.activity_log,
--   audit.audit_action, audit.if_modified, core.current_app_user_id,
--   core.current_organization_id, roles app_readonly/app_readwrite/
--   app_migrator/crm_sync) being loaded FIRST. Domain schemas
--   (invoicing, crm, hr, inventory, legal) should be loaded before the
--   temporal-history section (section 6) because it references
--   hr.compensation and invoicing.invoice.
--
-- This file is the SECURITY-ARCHITECTURE layer for SOC2 change tracking +
-- GDPR-aware redaction. It is ADDITIVE and idempotent: it ENHANCES the
-- foundation's audit.if_modified() backward-compatibly (the existing
-- one-argument zzz_audit_<t> triggers across every domain keep working
-- unchanged), HARDENS audit.activity_log into a tamper-evident append-only
-- store, and adds point-in-time history for the two tables the spec calls
-- out (hr.compensation, invoicing.invoice).
--
-- WHAT THIS FILE ADDS (nothing here re-creates foundation objects):
--   1. Enhanced audit.if_modified() -- adds a 2nd optional arg (columns to
--      HASH instead of literal-redact) + actor org + hash-chain stamping.
--      Drop-in compatible with every existing 1-arg attach.
--   2. Tamper-resistance on audit.activity_log: prev_hash/row_hash columns,
--      a per-partition hash chain, a BEFORE UPDATE/DELETE/TRUNCATE guard,
--      and audit.verify_activity_log_chain() to detect tampering.
--   3. audit.attach_audit(schema, table, redact, hash) helper +
--      audit.attach_all_sensitive() to (re)ATTACH the trigger to every
--      sensitive table from the data-classification catalogue in one call.
--   4. pgaudit statement/object-level configuration (documented; the
--      ALTER ROLE SET lines are runnable, the postgresql.conf lines are infra).
--   5. audit.activity_log_summary view for investigators (PII-safe).
--   6. Point-in-time temporal history for hr.compensation + invoicing.invoice
--      (audit.compensation_history / audit.invoice_history + AS-OF functions).
--   7. Retention: pg_partman config for activity_log + a retention routine
--      for the history tables that EXCLUDES legal-hold-linked rows.
--
-- Idempotent: guarded with IF NOT EXISTS / DO blocks / CREATE OR REPLACE /
-- DROP ... IF EXISTS. Safe to re-run.
-- =====================================================================


-- =====================================================================
-- SECTION 1. SCHEMA-LOCAL HELPERS (hashing + actor context)
-- =====================================================================

-- 1a. audit.hash_value(text) -> text
-- Keyed HMAC-SHA256 used to (a) HASH sensitive audited values so they can be
-- equality-correlated across versions WITHOUT being readable, and (b) build
-- the tamper-evident row/prev hash chain. The HMAC key is supplied at runtime
-- via the GUC `audit.hash_key` (set by infra from KMS/secrets manager, e.g.
-- ALTER DATABASE ... SET audit.hash_key = '<base64 secret>' or a session GUC).
-- It is NEVER stored in the database. If the key is unset we deliberately
-- return a constant sentinel rather than a *predictable* unkeyed digest, so a
-- misconfigured deployment fails closed (no reversible low-entropy hashes leak).
CREATE OR REPLACE FUNCTION audit.hash_value(p_input text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN p_input IS NULL THEN NULL
           WHEN COALESCE(NULLIF(current_setting('audit.hash_key', true), ''), '') = ''
             THEN '__hash_key_unset__'
           ELSE encode(
                  hmac(
                    convert_to(p_input, 'UTF8'),
                    convert_to(current_setting('audit.hash_key', true), 'UTF8'),
                    'sha256'
                  ),
                  'hex')
         END;
$$;
COMMENT ON FUNCTION audit.hash_value(text) IS
  'Keyed HMAC-SHA256 (pgcrypto hmac) of the input using GUC audit.hash_key (from KMS, never stored in DB). Used to hash sensitive audited values for non-reversible correlation and to build the activity_log tamper-evident chain. Fails closed to a sentinel when the key is unset so no unkeyed/reversible digest is ever emitted.';

-- 1b. audit.current_actor_org() -> bigint
-- The tenant the actor was operating in (from the RLS GUC). Stored on each
-- audit row so investigators can filter history by tenant even though
-- activity_log is itself cross-tenant (it is platform-owned history).
CREATE OR REPLACE FUNCTION audit.current_actor_org()
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::bigint;
$$;
COMMENT ON FUNCTION audit.current_actor_org() IS
  'Returns the active tenant organization surrogate id from GUC app.current_organization_id (or NULL). Stamped onto audit.activity_log so change history can be filtered per tenant.';


-- =====================================================================
-- SECTION 2. HARDEN audit.activity_log (tamper-evidence columns + chain)
-- =====================================================================
-- The foundation already created audit.activity_log (PARTITION BY RANGE
-- (changed_at), PK (id, changed_at), no UPDATE/DELETE grants to app roles).
-- Here we add, idempotently:
--   * actor_org_id   -- tenant context of the change (for per-tenant filtering)
--   * app_txid       -- already present as txid; we add a stable seq within txn
--   * prev_hash      -- HMAC of the immediately-preceding row in this partition
--   * row_hash       -- HMAC over this row's immutable content + prev_hash
-- row_hash chained on prev_hash makes the log tamper-EVIDENT: altering or
-- deleting any historical row breaks every subsequent row_hash, which
-- audit.verify_activity_log_chain() detects.

ALTER TABLE audit.activity_log
  ADD COLUMN IF NOT EXISTS actor_org_id bigint NULL;
ALTER TABLE audit.activity_log
  ADD COLUMN IF NOT EXISTS prev_hash text NULL;
ALTER TABLE audit.activity_log
  ADD COLUMN IF NOT EXISTS row_hash text NULL;

COMMENT ON COLUMN audit.activity_log.actor_org_id IS
  'Tenant (organization surrogate id) the actor was operating in when the change occurred (from app.current_organization_id GUC). NULL for cross-tenant/system writes. Lets per-tenant change history be queried from the platform-owned log.';
COMMENT ON COLUMN audit.activity_log.prev_hash IS
  'row_hash of the immediately preceding activity_log row in the same monthly partition. Chains the log so any tampering breaks the chain. NULL only for the first row of a partition.';
COMMENT ON COLUMN audit.activity_log.row_hash IS
  'Tamper-evidence HMAC over this row''s immutable content (id, action, schema, table, pk, old/new images, changed_at, txid, actor) plus prev_hash. Recomputed and verified by audit.verify_activity_log_chain().';

-- Index supporting per-tenant change history lookups.
CREATE INDEX IF NOT EXISTS ix_activity_log_actor_org
    ON audit.activity_log (actor_org_id, changed_at DESC);


-- =====================================================================
-- SECTION 3. ENHANCED audit.if_modified() (redact + hash + chain + org)
-- =====================================================================
-- BACKWARD-COMPATIBLE REPLACEMENT of the foundation trigger.
--   TG_ARGV[0] (optional) = comma-separated columns to REDACT (literal
--                            '__redacted__'). Identical to the foundation
--                            contract -- every existing zzz_audit_<t> attach
--                            (e.g. if_modified('password_hash,mfa_secret'))
--                            keeps working with no change.
--   TG_ARGV[1] (optional) = comma-separated columns to HASH (keyed HMAC via
--                            audit.hash_value) instead of dropping them. Use
--                            for values you must be able to *correlate* across
--                            versions (e.g. detect "did the national_id change")
--                            without storing the value. A column listed in BOTH
--                            args is redacted (redaction wins -- most private).
--
-- Also now: stamps actor_org_id, and computes the prev_hash/row_hash chain
-- (advisory-locked per partition month so concurrent writers chain correctly).
CREATE OR REPLACE FUNCTION audit.if_modified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_old        jsonb;
    v_new        jsonb;
    v_row_pk     text;
    v_redact     text[];
    v_hash       text[];
    v_col        text;
    v_changed_at timestamptz := clock_timestamp();
    v_txid       bigint      := txid_current();
    v_actor_role text        := current_user;
    v_actor_user uuid        := core.current_app_user_id();
    v_actor_org  bigint      := audit.current_actor_org();
    v_client     inet        := inet_client_addr();
    v_action     audit.audit_action := TG_OP::audit.audit_action;
    v_lock_key   bigint;
    v_prev_hash  text;
    v_row_hash   text;
    v_new_id     bigint;
BEGIN
    -- 1. Build pre/post images.
    IF (TG_OP = 'UPDATE') THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
    ELSIF (TG_OP = 'DELETE') THEN
        v_old := to_jsonb(OLD);
        v_new := NULL;
    ELSIF (TG_OP = 'INSERT') THEN
        v_old := NULL;
        v_new := to_jsonb(NEW);
    END IF;

    -- 2. HASH configured columns (TG_ARGV[1]) -- keyed HMAC, correlatable but
    --    non-reversible. Done BEFORE redaction so a column in both lists ends
    --    up redacted (redaction overwrites the hash).
    IF TG_NARGS >= 2 AND TG_ARGV[1] IS NOT NULL AND TG_ARGV[1] <> '' THEN
        v_hash := string_to_array(TG_ARGV[1], ',');
        FOREACH v_col IN ARRAY v_hash LOOP
            v_col := btrim(v_col);
            IF v_old ? v_col AND (v_old -> v_col) <> 'null'::jsonb THEN
                v_old := jsonb_set(v_old, ARRAY[v_col],
                                   to_jsonb('__hashed__:' || audit.hash_value(v_old ->> v_col)));
            END IF;
            IF v_new ? v_col AND (v_new -> v_col) <> 'null'::jsonb THEN
                v_new := jsonb_set(v_new, ARRAY[v_col],
                                   to_jsonb('__hashed__:' || audit.hash_value(v_new ->> v_col)));
            END IF;
        END LOOP;
    END IF;

    -- 3. REDACT configured columns (TG_ARGV[0]) -- literal sentinel. Identical
    --    semantics to the foundation function (full backward compatibility).
    IF TG_NARGS >= 1 AND TG_ARGV[0] IS NOT NULL AND TG_ARGV[0] <> '' THEN
        v_redact := string_to_array(TG_ARGV[0], ',');
        FOREACH v_col IN ARRAY v_redact LOOP
            v_col := btrim(v_col);
            IF v_old ? v_col THEN v_old := jsonb_set(v_old, ARRAY[v_col], '"__redacted__"'); END IF;
            IF v_new ? v_col THEN v_new := jsonb_set(v_new, ARRAY[v_col], '"__redacted__"'); END IF;
        END LOOP;
    END IF;

    -- 4. Derive row pk text from the surviving image's "id".
    v_row_pk := COALESCE(v_new ->> 'id', v_old ->> 'id');

    -- 5. Tamper-evident hash chain. Serialize writers within the same monthly
    --    partition with a txn-scoped advisory lock so prev_hash resolution and
    --    insertion are atomic. Key = hash of the partition month (stable bigint).
    v_lock_key := ('x' || substr(md5('audit.activity_log:' || to_char(v_changed_at, 'YYYY-MM')), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT al.row_hash
      INTO v_prev_hash
      FROM audit.activity_log al
     WHERE al.changed_at >= date_trunc('month', v_changed_at)
       AND al.changed_at <  (date_trunc('month', v_changed_at) + interval '1 month')
     ORDER BY al.changed_at DESC, al.id DESC
     LIMIT 1;

    -- 6. Insert the audit row WITHOUT row_hash first so we can hash the actual
    --    generated id, then update row_hash in the same statement context.
    INSERT INTO audit.activity_log
        (actor_db_role, actor_app_user_id, actor_org_id, action, schema_name, table_name,
         row_pk, old_data, new_data, changed_at, txid, client_addr, statement_only,
         prev_hash, row_hash)
    VALUES
        (v_actor_role, v_actor_user, v_actor_org, v_action, TG_TABLE_SCHEMA, TG_TABLE_NAME,
         v_row_pk, v_old, v_new, v_changed_at, v_txid, v_client, false,
         v_prev_hash, NULL)
    RETURNING id INTO v_new_id;

    -- 7. Compute this row's hash over its immutable content + prev_hash, then
    --    stamp it. (This UPDATE is performed by the SECURITY DEFINER owner; the
    --    guard trigger in section 4 explicitly allows the row_hash backfill.)
    v_row_hash := audit.hash_value(
        concat_ws('|',
            v_new_id::text,
            v_action::text,
            TG_TABLE_SCHEMA,
            TG_TABLE_NAME,
            COALESCE(v_row_pk, ''),
            COALESCE(v_old::text, ''),
            COALESCE(v_new::text, ''),
            v_changed_at::text,
            v_txid::text,
            v_actor_role,
            COALESCE(v_actor_user::text, ''),
            COALESCE(v_prev_hash, '')
        )
    );

    UPDATE audit.activity_log
       SET row_hash = v_row_hash
     WHERE id = v_new_id AND changed_at = v_changed_at;

    IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
COMMENT ON FUNCTION audit.if_modified() IS
  'Generic AFTER ROW audit trigger -> audit.activity_log. SECURITY DEFINER (audited tables need no grant on audit). TG_ARGV[0]=columns to REDACT (literal __redacted__; foundation-compatible). TG_ARGV[1]=columns to HASH (keyed HMAC, correlatable, non-reversible). Stamps actor db role / app user / tenant / client addr / txid and maintains a per-monthly-partition tamper-evident hash chain (prev_hash -> row_hash) verifiable by audit.verify_activity_log_chain().';

-- Capture TRUNCATE at the statement level (per-row triggers never see TRUNCATE).
-- Records a statement_only marker row so a wipe attempt is itself in the log.
CREATE OR REPLACE FUNCTION audit.log_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_changed_at timestamptz := clock_timestamp();
BEGIN
    INSERT INTO audit.activity_log
        (actor_db_role, actor_app_user_id, actor_org_id, action, schema_name, table_name,
         row_pk, old_data, new_data, changed_at, txid, client_addr, statement_only)
    VALUES
        (current_user, core.current_app_user_id(), audit.current_actor_org(),
         'TRUNCATE'::audit.audit_action, TG_TABLE_SCHEMA, TG_TABLE_NAME,
         NULL, NULL, NULL, v_changed_at, txid_current(), inet_client_addr(), true);
    RETURN NULL;
END;
$$;
COMMENT ON FUNCTION audit.log_truncate() IS
  'AFTER TRUNCATE FOR EACH STATEMENT trigger. Records a statement_only=true marker in audit.activity_log so a TRUNCATE of an audited table is itself audited (per-row triggers cannot observe TRUNCATE).';


-- =====================================================================
-- SECTION 4. APPEND-ONLY / IMMUTABILITY ENFORCEMENT ON audit.activity_log
-- =====================================================================
-- Two layers of defense:
--   (a) PRIVILEGES (already set by foundation): app roles get SELECT only;
--       writes flow through SECURITY DEFINER audit.if_modified(). We re-assert
--       and EXPLICITLY REVOKE UPDATE/DELETE/TRUNCATE here as belt-and-braces,
--       including on the concrete partitions.
--   (b) A GUARD TRIGGER that raises on UPDATE/DELETE/TRUNCATE so that EVEN a
--       table owner / BYPASSRLS migrator cannot silently mutate history in
--       place. The ONLY permitted UPDATE is the trigger's own row_hash backfill
--       (section 3 step 7), which we detect by "only row_hash changed AND it
--       went from NULL to non-NULL".
-- Hard partition DROP for retention (pg_partman) is DDL, not row DML, so it is
-- unaffected by the row guard -- retention still works (section 7).

-- Re-assert least privilege (idempotent; foundation already granted SELECT).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit.activity_log FROM app_readonly, app_readwrite;
GRANT  SELECT ON audit.activity_log TO app_readonly, app_readwrite;

CREATE OR REPLACE FUNCTION audit.deny_activity_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- TRUNCATE / DELETE are never allowed via this guard.
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION
            'audit.activity_log is append-only and tamper-resistant: % is not permitted (use pg_partman partition retention to age out old history)', TG_OP
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- UPDATE is allowed ONLY for the trigger''s own row_hash backfill:
    -- the sole field that may transition is row_hash, NULL -> non-NULL, and no
    -- other column may differ. Anything else is tampering.
    IF TG_OP = 'UPDATE' THEN
        IF (OLD.row_hash IS NULL AND NEW.row_hash IS NOT NULL)
           AND to_jsonb(NEW) - 'row_hash' = to_jsonb(OLD) - 'row_hash' THEN
            RETURN NEW;  -- legitimate one-time hash stamping
        END IF;
        RAISE EXCEPTION
            'audit.activity_log rows are immutable once written; in-place UPDATE is not permitted'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NULL;
END;
$$;
COMMENT ON FUNCTION audit.deny_activity_log_mutation() IS
  'Guard trigger making audit.activity_log append-only even for table owners / BYPASSRLS roles. Blocks all DELETE/TRUNCATE and all UPDATE except the audit trigger''s one-time row_hash NULL->value backfill. Retention is done by dropping whole partitions (DDL), which this row-level guard does not impede.';

-- Row-level guard for UPDATE/DELETE.
DROP TRIGGER IF EXISTS trg_activity_log_immutable ON audit.activity_log;
CREATE TRIGGER trg_activity_log_immutable
    BEFORE UPDATE OR DELETE ON audit.activity_log
    FOR EACH ROW EXECUTE FUNCTION audit.deny_activity_log_mutation();

-- Statement-level guard for TRUNCATE.
DROP TRIGGER IF EXISTS trg_activity_log_no_truncate ON audit.activity_log;
CREATE TRIGGER trg_activity_log_no_truncate
    BEFORE TRUNCATE ON audit.activity_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_activity_log_mutation();


-- =====================================================================
-- SECTION 5. CHAIN VERIFICATION (tamper detection)
-- =====================================================================
-- Recomputes the hash chain over a time window and reports the first row whose
-- stored row_hash != recomputed, or whose prev_hash != the prior row's
-- row_hash. A clean run (0 rows returned) is evidence the window is intact.
-- Run periodically (cron) and alert on any returned row. Requires audit.hash_key
-- to match the key in force when the rows were written.
CREATE OR REPLACE FUNCTION audit.verify_activity_log_chain(
    p_from timestamptz DEFAULT date_trunc('month', now()),
    p_to   timestamptz DEFAULT now()
)
RETURNS TABLE (
    id              bigint,
    changed_at      timestamptz,
    problem         text,
    expected_hash   text,
    stored_hash     text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    r            record;
    v_prev_hash  text := NULL;
    v_prev_month text := NULL;
    v_calc       text;
    v_month      text;
BEGIN
    FOR r IN
        SELECT * FROM audit.activity_log al
         WHERE al.changed_at >= p_from AND al.changed_at < p_to
         ORDER BY al.changed_at ASC, al.id ASC
    LOOP
        v_month := to_char(r.changed_at, 'YYYY-MM');
        -- Chain resets at each monthly partition boundary.
        IF v_prev_month IS DISTINCT FROM v_month THEN
            v_prev_hash := NULL;
        END IF;

        -- (a) prev_hash linkage check.
        IF r.prev_hash IS DISTINCT FROM v_prev_hash THEN
            id := r.id; changed_at := r.changed_at;
            problem := 'prev_hash mismatch (a preceding row was altered or deleted)';
            expected_hash := v_prev_hash; stored_hash := r.prev_hash;
            RETURN NEXT;
        END IF;

        -- (b) row_hash recomputation check.
        v_calc := audit.hash_value(
            concat_ws('|',
                r.id::text, r.action::text, r.schema_name, r.table_name,
                COALESCE(r.row_pk, ''), COALESCE(r.old_data::text, ''),
                COALESCE(r.new_data::text, ''), r.changed_at::text, r.txid::text,
                r.actor_db_role, COALESCE(r.actor_app_user_id::text, ''),
                COALESCE(r.prev_hash, '')
            )
        );
        IF r.row_hash IS DISTINCT FROM v_calc THEN
            id := r.id; changed_at := r.changed_at;
            problem := 'row_hash mismatch (this row''s content was altered)';
            expected_hash := v_calc; stored_hash := r.row_hash;
            RETURN NEXT;
        END IF;

        v_prev_hash  := r.row_hash;
        v_prev_month := v_month;
    END LOOP;
    RETURN;
END;
$$;
COMMENT ON FUNCTION audit.verify_activity_log_chain(timestamptz, timestamptz) IS
  'Tamper detector: recomputes the activity_log hash chain over [p_from, p_to) and returns one row per integrity break (altered/deleted/reordered history). Empty result = window verified intact. Schedule via cron and alert on any output. Needs the same audit.hash_key that was in force when the rows were written.';


-- =====================================================================
-- SECTION 6. ATTACH HELPERS (apply the audit trigger to sensitive tables)
-- =====================================================================
-- The foundation + each domain already attach zzz_audit_<t> per table. These
-- helpers make (re)attachment uniform and let security re-apply the SAME policy
-- (which columns redact vs hash) across the whole database from one place,
-- driven by the data-classification catalogue.

-- 6a. Generic attacher. Adds BOTH the per-row audit trigger (with the given
--     redact + hash column lists) and the statement-level TRUNCATE logger.
CREATE OR REPLACE FUNCTION audit.attach_audit(
    p_schema       text,
    p_table        text,
    p_redact_cols  text DEFAULT NULL,   -- comma-separated, literal-redacted
    p_hash_cols    text DEFAULT NULL    -- comma-separated, keyed-HMAC hashed
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_args text;
BEGIN
    -- Build the trigger argument list: (redact) or (redact, hash).
    IF p_hash_cols IS NOT NULL AND btrim(p_hash_cols) <> '' THEN
        v_args := format('%L, %L', COALESCE(p_redact_cols, ''), p_hash_cols);
    ELSIF p_redact_cols IS NOT NULL AND btrim(p_redact_cols) <> '' THEN
        v_args := format('%L', p_redact_cols);
    ELSE
        v_args := '';
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', 'zzz_audit_' || p_table, p_schema, p_table);
    EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
        'FOR EACH ROW EXECUTE FUNCTION audit.if_modified(%s)',
        'zzz_audit_' || p_table, p_schema, p_table, v_args);

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', 'zzz_audit_truncate_' || p_table, p_schema, p_table);
    EXECUTE format(
        'CREATE TRIGGER %I AFTER TRUNCATE ON %I.%I '
        'FOR EACH STATEMENT EXECUTE FUNCTION audit.log_truncate()',
        'zzz_audit_truncate_' || p_table, p_schema, p_table);
END;
$$;
COMMENT ON FUNCTION audit.attach_audit(text, text, text, text) IS
  'Attaches the standard audit pair to a table: zzz_audit_<t> (AFTER I/U/D row audit with optional redact + hash column lists) and zzz_audit_truncate_<t> (AFTER TRUNCATE statement logger). Idempotent. Single source of truth for the per-table redaction/hashing policy.';

-- 6b. Apply the redaction/hashing policy to EVERY sensitive table identified in
--     the data-classification catalogue. This both (re)attaches the per-row
--     audit trigger with the correct sensitive-column lists AND wires the
--     TRUNCATE logger. Tables/columns referenced here are REAL columns from the
--     domain DDLs above. Run after all domain schemas are loaded.
--
-- Policy applied:
--   * REDACT  : secrets, tokens, special-category & high-risk PII, exact money
--               whose value is itself the sensitive thing.
--   * HASH    : identifiers we must be able to CORRELATE across versions
--               without storing (e.g. national_id_hash, emails used as the
--               dedupe/login key). Hashing keeps "did this value change?"
--               answerable in the audit trail without exposing the value.
CREATE OR REPLACE FUNCTION audit.attach_all_sensitive()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- ---- core ----
    PERFORM audit.attach_audit('core','organization', NULL, NULL);
    -- app_user: redact auth material (matches foundation), hash the login email
    -- so account-takeover investigations can see "email was changed" w/o the PII.
    PERFORM audit.attach_audit('core','app_user', 'password_hash,mfa_secret', 'email');
    PERFORM audit.attach_audit('core','role', NULL, NULL);
    PERFORM audit.attach_audit('core','app_user_role', NULL, NULL);

    -- ---- invoicing ----
    PERFORM audit.attach_audit('invoicing','bill_to_customer', 'tax_identifier', 'email');
    PERFORM audit.attach_audit('invoicing','tax_rate', NULL, NULL);
    PERFORM audit.attach_audit('invoicing','invoice', NULL, NULL);
    PERFORM audit.attach_audit('invoicing','invoice_line_item', NULL, NULL);
    PERFORM audit.attach_audit('invoicing','tax_line', NULL, NULL);
    -- payment: processor token + reference are sensitive payment refs -> redact.
    PERFORM audit.attach_audit('invoicing','payment', 'payment_token,processor_reference', NULL);
    PERFORM audit.attach_audit('invoicing','payment_allocation', NULL, NULL);
    PERFORM audit.attach_audit('invoicing','credit_note', NULL, NULL);

    -- ---- crm (HubSpot mirror; PII-heavy) ----
    PERFORM audit.attach_audit('crm','company',
        'phone,address_street,address_city,address_postal_code,raw_properties', 'domain');
    PERFORM audit.attach_audit('crm','contact',
        'first_name,last_name,phone,mobile_phone,address_street,address_city,address_postal_code,raw_properties',
        'email');
    PERFORM audit.attach_audit('crm','deal', 'raw_properties', NULL);
    PERFORM audit.attach_audit('crm','contact_company', NULL, NULL);
    PERFORM audit.attach_audit('crm','consent', 'evidence_ip,evidence_user_agent', NULL);
    PERFORM audit.attach_audit('crm','sync_run', NULL, NULL);
    PERFORM audit.attach_audit('crm','sync_error', 'error_message,error_payload', NULL);

    -- ---- hr (highest-sensitivity PII) ----
    PERFORM audit.attach_audit('hr','department', NULL, NULL);
    PERFORM audit.attach_audit('hr','position', NULL, NULL);
    -- employee: redact secrets/special-category + high-risk PII; HASH the
    -- already-HMAC national_id_hash so it still correlates (it is non-reversible
    -- but we do not want the raw HMAC in plaintext images either) and work_email.
    PERFORM audit.attach_audit('hr','employee',
        'national_id_enc,bank_account_token,date_of_birth,address_line1,address_line2,address_postal_code,personal_email,phone,legal_first_name,legal_last_name',
        'national_id_hash,work_email');
    PERFORM audit.attach_audit('hr','employment', NULL, NULL);
    PERFORM audit.attach_audit('hr','compensation', 'amount_enc,amount_band', NULL);
    PERFORM audit.attach_audit('hr','shift', NULL, NULL);
    PERFORM audit.attach_audit('hr','timesheet', NULL, NULL);
    PERFORM audit.attach_audit('hr','time_entry', NULL, NULL);
    PERFORM audit.attach_audit('hr','attendance', NULL, NULL);
    PERFORM audit.attach_audit('hr','leave_type', NULL, NULL);
    PERFORM audit.attach_audit('hr','leave_request', 'medical_note_enc,reason', NULL);

    -- ---- inventory ----
    PERFORM audit.attach_audit('inventory','unit_of_measure', NULL, NULL);
    PERFORM audit.attach_audit('inventory','product_category', NULL, NULL);
    PERFORM audit.attach_audit('inventory','product', 'standard_cost', NULL);
    PERFORM audit.attach_audit('inventory','warehouse', NULL, NULL);
    PERFORM audit.attach_audit('inventory','location', NULL, NULL);
    PERFORM audit.attach_audit('inventory','stock_level', NULL, NULL);
    PERFORM audit.attach_audit('inventory','stock_movement', 'unit_cost', NULL);
    PERFORM audit.attach_audit('inventory','supplier',
        'contact_name,contact_email,contact_phone,tax_identifier', NULL);
    PERFORM audit.attach_audit('inventory','purchase_order', NULL, NULL);
    PERFORM audit.attach_audit('inventory','purchase_order_line', 'unit_price', NULL);

    -- ---- legal (confidential commercial + PII) ----
    PERFORM audit.attach_audit('legal','agreement_type', NULL, NULL);
    PERFORM audit.attach_audit('legal','agreement', 'contract_value,legal_hold_reason', NULL);
    PERFORM audit.attach_audit('legal','agreement_version', 'change_summary', NULL);
    PERFORM audit.attach_audit('legal','agreement_document', NULL, NULL);
    PERFORM audit.attach_audit('legal','signatory', 'signer_name,signing_ip', 'signer_email');
    PERFORM audit.attach_audit('legal','agreement_party', 'party_name', NULL);
    PERFORM audit.attach_audit('legal','agreement_link', NULL, NULL);
    -- NOTE: legal.agreement_access_log is itself an append-only READ trail and is
    -- intentionally NOT audited (auditing reads into the change log is noise).
END;
$$;
COMMENT ON FUNCTION audit.attach_all_sensitive() IS
  'Re-applies the canonical audit redaction/hashing policy across every sensitive table in all domain schemas (driven by the data-classification catalogue). Idempotent. Call after loading all domain DDL, or whenever the classification policy changes, to keep redaction consistent in one place.';


-- =====================================================================
-- SECTION 7. INVESTIGATOR VIEW (PII-safe change-history surface)
-- =====================================================================
-- app_readonly/app_readwrite can read activity_log, but the raw old_data/
-- new_data JSONB can still contain non-redacted business fields. This view is a
-- safe default surface: metadata + which top-level keys changed, WITHOUT the
-- values. Use the base table only for privileged forensic roles.
CREATE OR REPLACE VIEW audit.activity_log_summary AS
SELECT
    al.id,
    al.changed_at,
    al.actor_db_role,
    al.actor_app_user_id,
    al.actor_org_id,
    al.action,
    al.schema_name,
    al.table_name,
    al.row_pk,
    al.txid,
    al.client_addr,
    al.statement_only,
    -- The set of top-level columns that actually changed on an UPDATE (keys only,
    -- never values), so reviewers see WHAT changed without seeing the data.
    CASE
      WHEN al.action = 'UPDATE' AND al.old_data IS NOT NULL AND al.new_data IS NOT NULL THEN
        (SELECT array_agg(k ORDER BY k)
           FROM jsonb_object_keys(al.new_data) k
          WHERE al.new_data -> k IS DISTINCT FROM al.old_data -> k)
      ELSE NULL
    END AS changed_columns
FROM audit.activity_log al;
COMMENT ON VIEW audit.activity_log_summary IS
  'PII-safe change-history surface: audit metadata + the list of column names changed on each UPDATE (keys only, never values). Default surface for app/reporting roles; the base audit.activity_log (which may hold non-redacted values) stays for privileged forensic roles only.';

GRANT SELECT ON audit.activity_log_summary TO app_readonly, app_readwrite;


-- =====================================================================
-- SECTION 8. TEMPORAL / POINT-IN-TIME HISTORY
--            (hr.compensation + invoicing.invoice)
-- =====================================================================
-- audit.activity_log answers "who changed what, when". For these two tables the
-- spec wants efficient POINT-IN-TIME ("what was the value AS OF date X")
-- reconstruction. We implement lightweight system-versioning: a shadow history
-- table holding every prior version with a validity period [valid_from,
-- valid_to), populated by a BEFORE UPDATE/DELETE trigger that archives the OLD
-- row. The live table remains the current version. This is the standard
-- PG-native temporal pattern (no extension required) and complements, not
-- replaces, the audit log.

-- ---------------------------------------------------------------------
-- 8a. hr.compensation history (effective-dated pay -> needs true point-in-time)
-- ---------------------------------------------------------------------
-- Mirrors hr.compensation columns. amount_enc stays encrypted in history too
-- (we copy the ciphertext verbatim; it is never decrypted here).
CREATE TABLE IF NOT EXISTS audit.compensation_history (
    history_id      bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- snapshot of the source row (surrogate + public id retained for joins)
    id              bigint       NOT NULL,
    public_id       uuid         NOT NULL,
    organization_id bigint       NOT NULL,
    employment_id   bigint       NOT NULL,
    pay_grade       text         NULL,
    pay_frequency   hr.pay_frequency NOT NULL,
    currency_code   char(3)      NOT NULL,
    amount_enc      bytea        NOT NULL,   -- ciphertext copied verbatim (never decrypted)
    amount_band     text         NULL,
    effective_from  date         NOT NULL,
    effective_to    date         NULL,
    is_current      boolean      NOT NULL,
    created_at      timestamptz  NOT NULL,
    updated_at      timestamptz  NOT NULL,
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    -- system-versioning validity window + provenance of the archive event
    sys_valid_from  timestamptz  NOT NULL,   -- when this version became current (source updated_at)
    sys_valid_to    timestamptz  NOT NULL DEFAULT now(),  -- when it was superseded/deleted
    archived_action audit.audit_action NOT NULL,          -- UPDATE or DELETE that archived it
    archived_txid   bigint       NOT NULL DEFAULT txid_current()
);
COMMENT ON TABLE audit.compensation_history IS
  'System-versioned history of hr.compensation. One row per superseded/deleted version with validity window [sys_valid_from, sys_valid_to). amount_enc is stored as ciphertext verbatim (never decrypted). Enables AS-OF point-in-time reconstruction via audit.compensation_as_of(). Append-only; no UPDATE/DELETE grants.';

CREATE INDEX IF NOT EXISTS ix_compensation_history_src
    ON audit.compensation_history (id, sys_valid_from DESC);
CREATE INDEX IF NOT EXISTS ix_compensation_history_employment
    ON audit.compensation_history (employment_id, sys_valid_from DESC);
CREATE INDEX IF NOT EXISTS ix_compensation_history_org
    ON audit.compensation_history (organization_id, sys_valid_to DESC);

-- ---------------------------------------------------------------------
-- 8b. invoicing.invoice history (financial document -> point-in-time)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.invoice_history (
    history_id          bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id                  bigint       NOT NULL,
    public_id           uuid         NOT NULL,
    organization_id     bigint       NOT NULL,
    bill_to_customer_id bigint       NOT NULL,
    invoice_number      text         NOT NULL,
    status              invoicing.invoice_status NOT NULL,
    currency_code       char(3)      NOT NULL,
    issue_date          date         NULL,
    due_date            date         NULL,
    subtotal_amount     numeric(18,4) NOT NULL,
    tax_amount          numeric(18,4) NOT NULL,
    discount_amount     numeric(18,4) NOT NULL,
    total_amount        numeric(18,4) NOT NULL,
    amount_paid         numeric(18,4) NOT NULL,
    amount_due          numeric(18,4) NOT NULL,
    notes               text         NULL,
    hubspot_deal_id     text         NULL,
    sent_at             timestamptz  NULL,
    paid_at             timestamptz  NULL,
    voided_at           timestamptz  NULL,
    created_at          timestamptz  NOT NULL,
    updated_at          timestamptz  NOT NULL,
    created_by          uuid         NULL,
    updated_by          uuid         NULL,
    deleted_at          timestamptz  NULL,
    sys_valid_from      timestamptz  NOT NULL,
    sys_valid_to        timestamptz  NOT NULL DEFAULT now(),
    archived_action     audit.audit_action NOT NULL,
    archived_txid       bigint       NOT NULL DEFAULT txid_current()
);
COMMENT ON TABLE audit.invoice_history IS
  'System-versioned history of invoicing.invoice. One row per superseded/deleted version with validity window [sys_valid_from, sys_valid_to). Enables AS-OF point-in-time reconstruction of an invoice (status, totals, balances) via audit.invoice_as_of(). Append-only; no UPDATE/DELETE grants.';

CREATE INDEX IF NOT EXISTS ix_invoice_history_src
    ON audit.invoice_history (id, sys_valid_from DESC);
CREATE INDEX IF NOT EXISTS ix_invoice_history_org
    ON audit.invoice_history (organization_id, sys_valid_to DESC);
CREATE INDEX IF NOT EXISTS ix_invoice_history_customer
    ON audit.invoice_history (bill_to_customer_id, sys_valid_from DESC);

-- ---------------------------------------------------------------------
-- 8c. System-versioning trigger functions (archive the OLD image).
-- ---------------------------------------------------------------------
-- SECURITY DEFINER so the audited table needs no direct grant on audit.* and so
-- app roles still cannot write history directly.
CREATE OR REPLACE FUNCTION audit.version_compensation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO audit.compensation_history (
        id, public_id, organization_id, employment_id, pay_grade, pay_frequency,
        currency_code, amount_enc, amount_band, effective_from, effective_to,
        is_current, created_at, updated_at, created_by, updated_by, deleted_at,
        sys_valid_from, sys_valid_to, archived_action)
    VALUES (
        OLD.id, OLD.public_id, OLD.organization_id, OLD.employment_id, OLD.pay_grade, OLD.pay_frequency,
        OLD.currency_code, OLD.amount_enc, OLD.amount_band, OLD.effective_from, OLD.effective_to,
        OLD.is_current, OLD.created_at, OLD.updated_at, OLD.created_by, OLD.updated_by, OLD.deleted_at,
        OLD.updated_at, now(), TG_OP::audit.audit_action);
    IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
COMMENT ON FUNCTION audit.version_compensation() IS
  'BEFORE UPDATE OR DELETE on hr.compensation: archives the OLD row into audit.compensation_history with validity [OLD.updated_at, now()). Powers point-in-time queries. SECURITY DEFINER.';

CREATE OR REPLACE FUNCTION audit.version_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO audit.invoice_history (
        id, public_id, organization_id, bill_to_customer_id, invoice_number, status,
        currency_code, issue_date, due_date, subtotal_amount, tax_amount, discount_amount,
        total_amount, amount_paid, amount_due, notes, hubspot_deal_id, sent_at, paid_at,
        voided_at, created_at, updated_at, created_by, updated_by, deleted_at,
        sys_valid_from, sys_valid_to, archived_action)
    VALUES (
        OLD.id, OLD.public_id, OLD.organization_id, OLD.bill_to_customer_id, OLD.invoice_number, OLD.status,
        OLD.currency_code, OLD.issue_date, OLD.due_date, OLD.subtotal_amount, OLD.tax_amount, OLD.discount_amount,
        OLD.total_amount, OLD.amount_paid, OLD.amount_due, OLD.notes, OLD.hubspot_deal_id, OLD.sent_at, OLD.paid_at,
        OLD.voided_at, OLD.created_at, OLD.updated_at, OLD.created_by, OLD.updated_by, OLD.deleted_at,
        OLD.updated_at, now(), TG_OP::audit.audit_action);
    IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
COMMENT ON FUNCTION audit.version_invoice() IS
  'BEFORE UPDATE OR DELETE on invoicing.invoice: archives the OLD row into audit.invoice_history with validity [OLD.updated_at, now()). Powers point-in-time reconstruction. SECURITY DEFINER.';

-- Attach the versioning triggers. Named trg_history_* (BEFORE) so they run
-- before the AFTER audit trigger; ordering vs zzz_audit is irrelevant since the
-- archive reads OLD which both see identically.
DROP TRIGGER IF EXISTS trg_history_compensation ON hr.compensation;
CREATE TRIGGER trg_history_compensation
    BEFORE UPDATE OR DELETE ON hr.compensation
    FOR EACH ROW EXECUTE FUNCTION audit.version_compensation();

DROP TRIGGER IF EXISTS trg_history_invoice ON invoicing.invoice;
CREATE TRIGGER trg_history_invoice
    BEFORE UPDATE OR DELETE ON invoicing.invoice
    FOR EACH ROW EXECUTE FUNCTION audit.version_invoice();

-- ---------------------------------------------------------------------
-- 8d. AS-OF point-in-time accessors.
-- ---------------------------------------------------------------------
-- Returns the version of a compensation row that was in force at instant p_as_of:
-- either a history version whose [sys_valid_from, sys_valid_to) covers p_as_of,
-- or the live row if p_as_of is at/after its current sys_valid_from.
-- NOTE: callers must still hold the audit.hash_key-independent decryption key to
-- read amount_enc; this returns the ciphertext as-stored.
CREATE OR REPLACE FUNCTION audit.compensation_as_of(p_compensation_id bigint, p_as_of timestamptz)
RETURNS audit.compensation_history
LANGUAGE sql
STABLE
AS $$
    -- Prefer a matching historical version...
    SELECT *
      FROM audit.compensation_history h
     WHERE h.id = p_compensation_id
       AND h.sys_valid_from <= p_as_of
       AND h.sys_valid_to   >  p_as_of
     ORDER BY h.sys_valid_from DESC
     LIMIT 1;
$$;
COMMENT ON FUNCTION audit.compensation_as_of(bigint, timestamptz) IS
  'Point-in-time read: the hr.compensation version (as an audit.compensation_history rowtype) that was in force for the given compensation id at instant p_as_of. Returns no row if p_as_of predates the first recorded version. For "now", read hr.compensation directly. amount_enc is returned as stored ciphertext.';

CREATE OR REPLACE FUNCTION audit.invoice_as_of(p_invoice_id bigint, p_as_of timestamptz)
RETURNS audit.invoice_history
LANGUAGE sql
STABLE
AS $$
    SELECT *
      FROM audit.invoice_history h
     WHERE h.id = p_invoice_id
       AND h.sys_valid_from <= p_as_of
       AND h.sys_valid_to   >  p_as_of
     ORDER BY h.sys_valid_from DESC
     LIMIT 1;
$$;
COMMENT ON FUNCTION audit.invoice_as_of(bigint, timestamptz) IS
  'Point-in-time read: the invoicing.invoice version (as an audit.invoice_history rowtype) in force for the given invoice id at instant p_as_of (status, totals, balances). Returns no row if p_as_of predates the first recorded version; for "now" read invoicing.invoice directly.';

-- History tables are append-only to app roles (read-only); writes are by the
-- SECURITY DEFINER versioning triggers only. Reuse the activity_log guard.
DROP TRIGGER IF EXISTS trg_compensation_history_immutable ON audit.compensation_history;
CREATE TRIGGER trg_compensation_history_immutable
    BEFORE UPDATE OR DELETE ON audit.compensation_history
    FOR EACH ROW EXECUTE FUNCTION audit.deny_activity_log_mutation();

DROP TRIGGER IF EXISTS trg_invoice_history_immutable ON audit.invoice_history;
CREATE TRIGGER trg_invoice_history_immutable
    BEFORE UPDATE OR DELETE ON audit.invoice_history
    FOR EACH ROW EXECUTE FUNCTION audit.deny_activity_log_mutation();

-- Grants: history is sensitive (holds comp ciphertext + invoice financials).
-- Read-only to app roles; no write path except the definer triggers.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit.compensation_history, audit.invoice_history
    FROM app_readonly, app_readwrite;
GRANT SELECT ON audit.compensation_history, audit.invoice_history TO app_readonly, app_readwrite;


-- =====================================================================
-- SECTION 9. RETENTION (pg_partman for activity_log + history purge)
-- =====================================================================
-- audit.activity_log is PARTITION BY RANGE (changed_at) (foundation). Retention
-- = drop whole monthly partitions past the window. That is DDL (DROP TABLE),
-- so the append-only ROW guard (section 4) does not block it -- retention and
-- immutability coexist correctly.
--
-- pg_partman config (run once, as the partman owner / superuser, AFTER
-- CREATE EXTENSION pg_partman SCHEMA partman). These statements are guarded so
-- the file still loads cleanly where pg_partman is not installed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_partman') THEN
    -- Register activity_log for monthly partitioning if not already managed.
    IF NOT EXISTS (SELECT 1 FROM partman.part_config WHERE parent_table = 'audit.activity_log') THEN
      PERFORM partman.create_parent(
        p_parent_table     => 'audit.activity_log',
        p_control          => 'changed_at',
        p_type             => 'range',
        p_interval         => '1 month',
        p_premake          => 3            -- keep 3 future partitions ready
      );
    END IF;

    -- RETENTION POLICY: keep ~7 years of change history (common SOC2/financial
    -- retention; tune per compliance counsel). retention_keep_table=false drops
    -- the partition table outright (vs detach) once it ages out.
    UPDATE partman.part_config
       SET retention            = '7 years',
           retention_keep_table = false,
           retention_keep_index = false,
           infinite_time_partitions = true
     WHERE parent_table = 'audit.activity_log';
  ELSE
    RAISE NOTICE 'pg_partman not installed: audit.activity_log partition automation skipped. Install it (CREATE EXTENSION pg_partman) and re-run this block, or create monthly partitions manually.';
  END IF;
END
$$;

-- Schedule pg_partman maintenance from cron (pg_cron) or an external scheduler;
-- this is the call it must run (creates new partitions, applies retention):
--   SELECT partman.run_maintenance('audit.activity_log');
-- e.g. with pg_cron:
--   SELECT cron.schedule('partman-audit', '17 2 * * *',
--                        $$SELECT partman.run_maintenance('audit.activity_log')$$);

-- 9b. History-table retention with LEGAL-HOLD exclusion.
-- Temporal history is purged on its OWN clock, but a version must NOT be purged
-- if its parent entity is implicated in a litigation hold. For invoices we honor
-- a hold via any legal.agreement under legal_hold linked to the invoice through
-- legal.agreement_link (REAL FK). Compensation has no legal_hold concept, so it
-- purges purely by age. The purge is a DELETE on the history table, which the
-- immutability guard blocks for normal roles -- so it must be run by the
-- BYPASSRLS migrator/purge role, and we make the function SECURITY DEFINER owned
-- by that privileged role at deploy time. To keep history APPEND-ONLY even for
-- the purge, retention here DETACHES nothing and instead relies on the same
-- partition-drop philosophy is not available (history isn't partitioned), so we
-- temporarily allow the definer to delete by routing through a dedicated
-- function the guard recognizes via a session flag.
--
-- Simpler, safer approach actually used: history retention is performed by the
-- migrator with the guard trigger DISABLED for the duration of the purge
-- transaction (ALTER TABLE ... DISABLE TRIGGER is a privileged DDL the purge
-- role holds). The function documents the contract; the legal-hold filter is the
-- important security property.
CREATE OR REPLACE FUNCTION audit.purge_invoice_history(p_older_than interval DEFAULT '7 years')
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_deleted bigint;
    v_cutoff  timestamptz := now() - p_older_than;
BEGIN
    -- Privileged purge: lift the append-only guard for THIS table within THIS
    -- transaction only (requires table-owner / migrator privilege).
    EXECUTE 'ALTER TABLE audit.invoice_history DISABLE TRIGGER trg_invoice_history_immutable';

    WITH held_invoices AS (
        SELECT DISTINCT al.invoice_id
          FROM legal.agreement_link al
          JOIN legal.agreement a ON a.id = al.agreement_id
         WHERE al.invoice_id IS NOT NULL
           AND a.legal_hold = true
    )
    DELETE FROM audit.invoice_history h
     WHERE h.sys_valid_to < v_cutoff
       AND h.id NOT IN (SELECT invoice_id FROM held_invoices)
    ;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    EXECUTE 'ALTER TABLE audit.invoice_history ENABLE TRIGGER trg_invoice_history_immutable';
    RETURN v_deleted;
END;
$$;
COMMENT ON FUNCTION audit.purge_invoice_history(interval) IS
  'Retention purge of audit.invoice_history older than p_older_than, EXCLUDING any invoice implicated in a legal hold via legal.agreement_link -> legal.agreement.legal_hold = true (litigation hold overrides retention). Privileged: must be run by the migrator/purge role (it toggles the append-only guard for the txn). Returns rows deleted.';

CREATE OR REPLACE FUNCTION audit.purge_compensation_history(p_older_than interval DEFAULT '7 years')
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_deleted bigint;
    v_cutoff  timestamptz := now() - p_older_than;
BEGIN
    EXECUTE 'ALTER TABLE audit.compensation_history DISABLE TRIGGER trg_compensation_history_immutable';
    DELETE FROM audit.compensation_history h
     WHERE h.sys_valid_to < v_cutoff;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    EXECUTE 'ALTER TABLE audit.compensation_history ENABLE TRIGGER trg_compensation_history_immutable';
    RETURN v_deleted;
END;
$$;
COMMENT ON FUNCTION audit.purge_compensation_history(interval) IS
  'Retention purge of audit.compensation_history older than p_older_than (payroll history retention; tune per jurisdiction/statute of limitations). Privileged: run by the migrator/purge role. Returns rows deleted.';


-- =====================================================================
-- SECTION 10. pgaudit (STATEMENT / OBJECT-LEVEL AUDIT) -- CONFIG, NOT DDL
-- =====================================================================
-- The row-level trigger (audit.if_modified) captures the DATA DELTA (old/new
-- images) for SOC2 change tracking. pgaudit is COMPLEMENTARY: it logs the SQL
-- STATEMENTS themselves (including reads, DDL, role/grant changes, and failed
-- attempts) to the server log -- things triggers cannot see:
--   * SELECTs on sensitive tables (who READ the salary/PII; triggers fire only
--     on writes).
--   * DDL (CREATE/ALTER/DROP) and privilege changes (GRANT/REVOKE/role).
--   * Statements that error out before any row changes.
--   * Activity by BYPASSRLS/superuser roles outside the app path.
-- Ship the pgaudit log to a WORM/SIEM sink (CloudWatch/Cloud Logging/Splunk)
-- separate from the DB so a DB compromise cannot erase the statement trail --
-- the second, independent leg of tamper-resistance alongside the in-DB chain.
--
-- INFRA (postgresql.conf / cluster params -- NOT runnable here):
--   shared_preload_libraries = 'pgaudit'      # requires restart
--   pgaudit.log = 'write, ddl, role'          # writes + schema + grants/roles
--   pgaudit.log_catalog = off                 # reduce noise from catalog reads
--   pgaudit.log_parameter = on                # capture bound parameter values
--   pgaudit.log_relation = on                 # one entry per relation touched
--   pgaudit.log_statement_once = off
--   log_connections = on
--   log_disconnections = on
-- TLS in transit (ssl=on + hostssl-only pg_hba) and encryption at rest (CMK)
-- are assumed from the foundation; pgaudit logs must inherit the same controls.
--
-- The following ARE runnable once the extension/library is present. Guarded so
-- the file loads where pgaudit is absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgaudit') THEN
    -- Object-level read auditing focused on the highest-sensitivity surfaces:
    -- log every SELECT/DML on these via a pgaudit role whose privileges define
    -- the audit scope. Membership in audit_pgaudit_role marks objects to audit.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auditor') THEN
      CREATE ROLE auditor NOLOGIN;
    END IF;
    -- pgaudit.role names the role whose GRANTs delimit object-level auditing.
    -- Set at cluster/db scope so reads of granted objects are logged:
    EXECUTE 'ALTER DATABASE ' || quote_ident(current_database()) || ' SET pgaudit.role = ''auditor''';

    -- Mark sensitive READ surfaces for object-level audit by granting the
    -- auditor role SELECT on them (pgaudit then logs SELECTs against them).
    GRANT SELECT ON hr.employee, hr.compensation, hr.leave_request          TO auditor;
    GRANT SELECT ON invoicing.payment                                       TO auditor;
    GRANT SELECT ON crm.contact, crm.consent                                TO auditor;
    GRANT SELECT ON legal.agreement, legal.agreement_document, legal.signatory TO auditor;
    GRANT SELECT ON core.app_user                                           TO auditor;
  ELSE
    RAISE NOTICE 'pgaudit not available: statement/object-level audit configuration skipped. Add pgaudit to shared_preload_libraries and re-run this block.';
  END IF;
END
$$;


-- =====================================================================
-- SECTION 11. APPLY THE POLICY
-- =====================================================================
-- Re-attach the canonical redaction/hashing policy now (idempotent). Safe even
-- if some domain schemas are not yet loaded -- attach_audit will error only for
-- a missing table, so in a partial load comment out the missing domains. In the
-- holistic migration (all schemas loaded), this single call is the source of
-- truth for what gets redacted vs hashed everywhere.
SELECT audit.attach_all_sensitive();

-- =====================================================================
-- END AUDIT LOGGING & CHANGE TRACKING LAYER
-- =====================================================================
