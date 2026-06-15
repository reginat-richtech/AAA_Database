#!/usr/bin/env bash
# =====================================================================
# AAA_Database :: holistic validation
# Spins up a THROWAWAY PostgreSQL 16 container, applies every migration
# in order, loads the seeds, runs a few smoke checks, then tears down.
# Nothing touches any real database. Requires Docker.
#
# Usage:  ./db/validate.sh
# Exit 0 = all migrations + seeds load clean.
# =====================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG="$HERE/migrations"
SEED="$HERE/seeds"
CONTAINER="aaa_validate_$$"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> starting throwaway PostgreSQL 16 ($CONTAINER)"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres postgres:16 >/dev/null \
    || { echo "ERROR: could not start Docker container (is Docker running?)"; exit 2; }

docker exec "$CONTAINER" bash -c 'for i in $(seq 1 120); do pg_isready -U postgres -q && exit 0; sleep 0.5; done; exit 1' >/dev/null \
    || { echo "ERROR: postgres did not become ready"; exit 3; }
echo "==> postgres ready"

PSQL=(docker exec -e PGOPTIONS=--client-min-messages=warning "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1)

# Apply migrations in lexical order, then seeds.
for f in "$MIG"/[0-9]*.sql; do
    name="$(basename "$f")"
    docker cp "$f" "$CONTAINER:/tmp/$name" >/dev/null
    if "${PSQL[@]}" -f "/tmp/$name"; then echo "  OK  $name"; else echo "  FAIL $name"; exit 4; fi
done
for f in "$SEED"/[0-9]*.sql; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    docker cp "$f" "$CONTAINER:/tmp/$name" >/dev/null
    if "${PSQL[@]}" -f "/tmp/$name"; then echo "  OK  seed $name"; else echo "  FAIL seed $name"; exit 5; fi
done

echo "==> smoke checks"
docker exec "$CONTAINER" psql -U postgres -d postgres -At -F' : ' -c \
"select table_schema, count(*) from information_schema.tables
 where table_schema in ('core','audit','crm','hr','inventory','invoicing','legal')
 group by 1 order by 1;"
echo "  RLS-enabled tables: $(docker exec "$CONTAINER" psql -U postgres -d postgres -At -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relrowsecurity;")"
echo "  countries seeded:   $(docker exec "$CONTAINER" psql -U postgres -d postgres -At -c "select count(*) from core.country;")"
echo "  currencies seeded:  $(docker exec "$CONTAINER" psql -U postgres -d postgres -At -c "select count(*) from core.currency;")"
echo "  system roles seeded:$(docker exec "$CONTAINER" psql -U postgres -d postgres -At -c "select count(*) from core.role where is_system;")"

echo "==> VALIDATION PASSED"
