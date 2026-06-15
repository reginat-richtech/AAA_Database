# Migrations

Plain `.sql` migration files, applied in **lexical (numeric) order**. The numbering encodes a hard dependency order — do not reorder.

| Order | File | Creates | Depends on |
|------:|------|---------|-----------|
| 0001 | `0001_foundation.sql` | extensions, all schemas, `core.*` (orgs, app users, roles, country, currency), `audit.*`, shared trigger/RLS functions, database roles | — |
| 0010 | `0010_crm.sql` | `crm.*` (HubSpot read-only mirror) | `core` |
| 0020 | `0020_hr.sql` | `hr.*` (employees, working-time, compensation) | `core` |
| 0030 | `0030_inventory.sql` | `inventory.*` (products, warehouses, stock) | `core` |
| 0040 | `0040_invoicing.sql` | `invoicing.*` (invoices, lines, tokenized payments) | `core`, **`inventory`** |
| 0050 | `0050_legal.sql` | `legal.*` (customer agreements + document metadata) | `core`, **`invoicing`** |

Then load reference/seed data: `../seeds/0001_reference_data.sql`.

> **Why this order matters:** `invoicing.invoice_line_item` has a foreign key to `inventory.product`, and `legal.agreement_link` has a foreign key to `invoicing.invoice`. Referenced tables must exist first.

## Applying the migrations

### Quick local check (throwaway container, recommended first)
```bash
./db/validate.sh        # spins up a disposable PostgreSQL 16, applies everything, tears down
```

### Apply to a real database with `psql`
```bash
export PGHOST=... PGUSER=... PGDATABASE=... PGPASSWORD=...
for f in db/migrations/[0-9]*.sql; do
  echo ">> $f"
  psql -v ON_ERROR_STOP=1 -f "$f" || { echo "FAILED: $f"; break; }
done
psql -v ON_ERROR_STOP=1 -f db/seeds/0001_reference_data.sql
```

`ON_ERROR_STOP=1` ensures the run halts on the first error instead of charging ahead.

## Conventions used by every migration
- **Dual primary key:** internal `id bigint` (joins, never exposed) + `public_id uuid` (the only id used in URLs/APIs).
- **`timestamptz`** for all times; **`numeric`** (never float) for all money.
- **Soft delete** via `deleted_at` — rows are not hard-deleted on the request path.
- **`organization_id`** on every tenant-scoped table, enforced by row-level security.
- **Audit trigger** (`zzz_audit_*`) on sensitive tables writes change history to `audit.activity_log`.

## Production note
These files are designed to also work with a migration runner (Flyway, Sqitch, golang-migrate, Alembic-with-raw-SQL, etc.). For production you will additionally want **down/rollback** scripts and a `schema_migrations` ledger table — see `../../docs/operations.md` (pending).
