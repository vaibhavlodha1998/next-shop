---
name: db-migration-review
description: Review checklist for database migrations and schema changes.
metadata:
  version: "1.0.0"
  owner: platform
  paths: ["**/migrations/**", "**/migrate/**", "**/*.sql", "**/alembic/**", "**/flyway/**", "**/liquibase/**"]
---
- Destructive changes (DROP COLUMN, DROP TABLE, type narrowing) without a two-step expand and contract plan.
- Adding NOT NULL columns without a default to large tables; table-locking index builds (use CONCURRENTLY where supported).
- Missing down migration or rollback note when the repo convention requires one.
- Data backfills inside schema migrations; unbounded UPDATE or DELETE.
- Foreign keys without indexes.
