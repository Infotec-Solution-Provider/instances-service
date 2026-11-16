-- Explicit per-tenant opt-in only, after same-CRM WhatsApp writer guard v1 is verified.
-- MySQL 5.5/8: inspect information_schema.COLUMNS before this non-repeatable ALTER.
ALTER TABLE telephony_runtime_policy ADD COLUMN pause_all_channels TINYINT NOT NULL DEFAULT 0;
-- Next apply exactly ONE matching cutoff script after checking server version
-- and absent COLUMN_NAME. Never derive the UTC boundary from updated_at.
-- MySQL 5.5: 20261116-operator-pause-cutoff-mysql55.sql (seconds, conservative).
-- MySQL >=5.6.4: 20261116-operator-pause-cutoff-mysql56plus.sql (milliseconds).
-- Do not enable here. Activation requires a new real preflight_hash and verified tenant capability.
-- Scope rollback: SET pause_all_channels=0. Preserve all operator state, segments and receipts.
