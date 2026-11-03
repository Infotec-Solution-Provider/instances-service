# CRM integration — 2026-11-03

This branch merges phones, campaigns, DDD, proposals, satisfaction and administration without changing their source branches. Public authorization stays in the owning service. Instances accepts only HMAC-authenticated tenant commands, preserves replay rejection and executes all mandatory effects inside TenantDatabase.

## Finalization wire contract

`telephony.schedule.finish`: statements 0–2 remain schedule CAS, history INSERT and finish receipt INSERT. With `surveyQuestions`, statements 3–4 are exactly the survey snapshot and answer INSERT; proposal mutation/event pairs follow them. Without a survey, proposal pairs start at 3. Maximum 47 statements with survey / 45 without. An optional family must declare every table it needs; unused proposal tables, partial pairs and unrecognized SQL are rejected.

Survey receipt, schedule, actor, snapshot JSON and persisted answers are cross-validated. The history insertId from statement 1 is injected exclusively into snapshot parameter 3, never supplied by a caller or read via LAST_INSERT_ID. One failed affected-row acknowledgement, mandatory INSERT, schema, trigger or lock check aborts the entire close. No second proposal/survey transaction is used.

## G12 and N01

`crm.customer.write` additionally accepts `importReceipt: {key, actorId, identity, requestHash}` only when creating (`customerId:0`), `syncPhones:true`, with one original customer INSERT statement. `key` is a lowercase UUID and CSV line 2–501; hash is lowercase SHA256. Declare `crm_import_receipts` and `operadores` as well as the existing customer/policy/phone tables. The authenticated customers-service computes the hash and INSERT guards; browser input cannot set receipt metadata directly.

All customer writes use REPEATABLE READ. After locking the singleton policy row, Instances checks receipt schema and its single-column full primary key, revalidates the active ADMIN actor and locks the receipt key. Same key/hash/actor returns the original single acknowledgement and customer insertId; a different request returns `TENANT_IMPORT_OPERATION_REUSED`. No customer INSERT or phone sync runs again on replay.

New imports execute the original INSERT, fixed N01 synchronization, a fixed duplicate check from the persisted customer and finally the fixed receipt INSERT, before COMMIT. Documents present are always checked; phone identity additionally compares every current number across every supported customer slot. This does not depend on permissive/restrictive tenant flags. The caller's pre-INSERT identity and relation guards remain intact. Receipt failure rolls back customer and phone synchronization. There is no automatic retry after ambiguous commit.

`TENANT_IMPORT_DUPLICATE` / `TENANT_IMPORT_OPERATION_REUSED` return 409 and NOT_COMMITTED; `TENANT_IMPORT_FORBIDDEN` returns 403; unsupported receipt schema returns 503. Ordinary customer writes preserve acknowledgement counts. Updates without phone changes do not normalize old incomplete phone data.

## Proposed DDL

- `docs/sql/20261103-crm-import-receipts.sql`: persistent G12 creation receipt, no FK inferred against legacy schemas.
- `docs/sql/20261103-crm-client-block-queue.sql`: legacy singular `cliente_bloqueado` only if absent; field names follow the Delphi SQL source. Does not approve/reject or backfill anything. Proposed without FK until key types/consumers have been reviewed.
- Existing administration and DDD proposed DDL remain preserved. Proposal and satisfaction audit DDL are owned by customers-service. No DDL runs automatically.

G22/G23 mutations remain disabled. No SMTP worker, production database or shared SQL was accessed by this integration.

## MySQL fixture gates (coordinator only)

First build this integrated checkout. These commands use only the disposable loopback MySQL instance, root with no password, and random test schemas validated again before deletion. They never use tenant registry/credentials. Explicit test-port options reject 3306, invalid numbers, duplicate ports and host selectors.

```sh
npm run build
RUN_CRM_INTEGRATION_MYSQL=true CRM_INTEGRATION_MYSQL_PORT=3308 node --test tests/crm-integration.mysql.test.cjs
RUN_CRM_UNITS_MYSQL=true CRM_UNITS_MYSQL_PORTS=3308 node --test tests/crm-units.mysql.test.cjs
RUN_DDD_COVERAGE_MYSQL=true DDD_COVERAGE_MYSQL_PORT=3308 node --test tests/ddd-coverage.mysql.test.cjs
RUN_CATALOG_ORDERING_MYSQL=true CATALOG_ORDERING_MYSQL_PORTS=3308 node --test tests/catalog-ordering.mysql.test.cjs
RUN_TENANT_MYSQL_TESTS=true TENANT_MYSQL_PORTS=3308 node --test tests/tenant-database.mysql.test.cjs
```

The new integration fixture uses MySQL 8 CHECK constraints to fail each mandatory stage. It exercises HTTP/HMAC, G12 idempotence, different-row duplicate races with permissive policy, secondary phone duplication, receipt-write rollback, tenant isolation, proposal creation+cancellation+survey with exact history linkage, rollback at every mandatory table, and G21 replay/stale ownership. The fixture lives in `tests/fixtures/crm-integration.sql`; it is not a tenant migration. It was syntax-checked and loaded with the opt-in disabled locally; real SQL execution must be reported separately by the coordinator.

Customers additionally provides `tests/crm-integration.mysql.test.ts` with `CRM_INTEGRATION_MYSQL_ENABLED=1 CRM_INTEGRATION_MYSQL_PORT=3308` and optional absolute `CRM_INSTANCES_DIST`. That gate tests the integrated domain service against this router. See its mysql-gates.md for focused N01 and telephony regression commands.

No new production environment variable is required by this patch. Existing `TENANT_TRANSACTION_SECRET`, tenant catalog configuration and `TENANT_DB_*` budgets retain their roles. Tests use a synthetic signing key and only their own `RUN_*`/test-port variables.
