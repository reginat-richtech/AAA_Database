# AAA_Database

A secure, multi-tenant **PostgreSQL 16** database for four business domains —
**invoicing**, **CRM (HubSpot mirror)**, **HR / working-time**, **inventory** —
plus **legal agreements** for customer deals. Security (tenant isolation,
encryption, audit, and privacy controls) is built into the schema itself, not
bolted on afterward.

> Status: **schema + structure complete and validated** against real PostgreSQL 16.
> Some cross-cutting security helpers and extended docs are still in progress —
> see [Roadmap](#roadmap).

## Architecture at a glance

One database, **one schema per domain** for clean isolation and per-domain access control:

| Schema | Purpose | Tables |
|--------|---------|-------:|
| `core` | Shared foundation: organizations (tenants), application users, roles, country/currency reference data | 6 |
| `audit` | Append-only change history (`activity_log`, partitioned by time) | 3 |
| `crm` | **Read-only mirror** of HubSpot contacts / companies / deals + consent + sync tracking | 7 |
| `hr` | Employees, employment, departments, working-time (timesheets, shifts, attendance, leave), compensation | 11 |
| `inventory` | Products, categories, warehouses/locations, stock levels, stock movements, suppliers, purchase orders | 10 |
| `invoicing` | Invoices, line items, tax, **tokenized** payments, payment allocations, credit notes | 8 |
| `legal` | Customer deal agreements, versions, signatories, parties, **document metadata** (files live in object storage), access log | 8 |

**53 tables total; 46 have row-level security enabled.** The domains connect:
`legal.agreement_link → invoicing.invoice`, `invoicing.invoice_line_item → inventory.product`,
and CRM links are intentionally *loose* (stored HubSpot IDs, no hard FK) because the mirror can be re-synced.

## How security is built in

| Control | How it works here | Why |
|---|---|---|
| **Tenant isolation** | Row-level security (RLS) on 46 tables; every query is scoped to the caller's `organization_id` via a session setting. Cross-tenant inserts are rejected. | One tenant can never see or write another's data, even with a query bug. |
| **No raw payment data** | `invoicing.payment` stores only a processor **token + brand + last4** — never card/bank numbers. | Keeps the database out of PCI-DSS scope entirely. |
| **Column encryption** | Sensitive HR fields (national ID, bank, salary) are stored encrypted (`bytea` via pgcrypto); keys come from an external KMS, never the DB. | A database dump alone does not expose the most sensitive fields. |
| **Audit trail** | A trigger writes before/after row images (with sensitive values redacted) to append-only `audit.activity_log`. App roles cannot modify history. | Tamper-evident record of who changed what, when. |
| **Privacy / GDPR** | PII tables carry `pseudonymized_at`; erasure overwrites identifiers while preserving financial/legal records. CRM consent is tracked. | Right-to-erasure without breaking referential integrity. |
| **No ID enumeration** | Internal `bigint` keys never leave the system; external references use random `public_id` UUIDs. | Sequential IDs don't leak business volume (invoice counts, customer counts). |
| **Least privilege** | Distinct database roles (`app_readwrite`, `app_readonly`, `crm_sync`, `app_migrator`) + application RBAC roles in `core.role`. | Each component gets only the access it needs. |
| **Soft delete** | `deleted_at` tombstones instead of hard deletes on the request path. | Accidental/ malicious deletes are recoverable; history stays intact. |

See `docs/security-model.md` (in progress) for the full role matrix and policies.

## Repository layout

```
db/
  migrations/      0001..0050 schema migrations (apply in order) + README
  seeds/           0001_reference_data.sql (countries, currencies, system roles)
  validate.sh      spins up a throwaway PostgreSQL 16 and verifies everything loads
docs/              data-model, security-model, operations (in progress)
README.md          this file
```

## Getting started

**Prerequisites:** Docker (for validation) and/or a PostgreSQL 16 server, plus `psql`.

```bash
# 1. Verify the whole thing loads cleanly in a disposable container:
./db/validate.sh

# 2. Apply to a real database (see db/migrations/README.md for details):
for f in db/migrations/[0-9]*.sql; do psql -v ON_ERROR_STOP=1 -f "$f"; done
psql -v ON_ERROR_STOP=1 -f db/seeds/0001_reference_data.sql
```

At runtime your application connects as `app_readwrite` and sets the tenant
context per transaction so RLS can isolate data:

```sql
SET LOCAL app.current_organization_id = '<organization id>';
SET LOCAL app.current_user_id        = '<app_user public_id>';  -- for audit attribution
```

## Roadmap

Complete and validated:
- [x] Foundation: schemas, core identity/tenant tables, audit, roles, reference data
- [x] All four domains + legal agreements (53 tables) — load clean in dependency order
- [x] RLS, audit triggers, payment tokenization, encrypted columns, soft-delete
- [x] Reference seed data + reusable validation script

In progress / next:
- [ ] Cross-cutting security SQL: encryption helper functions, masked reporting views, privacy/retention/erasure functions (incl. `legal_hold` override), extended role hardening
- [ ] `docs/data-model.md` (ER diagram), `docs/security-model.md`, `docs/operations.md`
- [ ] Hardened `postgresql.conf` / `pg_hba.conf` samples
- [ ] Down/rollback scripts + `schema_migrations` ledger for production

> Defaults chosen for you (all changeable): PostgreSQL 16, one DB with a schema
> per domain, GDPR-style privacy + SOC 2-style access control, payment data
> tokenized (out of PCI scope), HubSpot treated as a read-only source of truth.
