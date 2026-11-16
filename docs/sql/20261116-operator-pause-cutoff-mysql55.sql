-- MySQL 5.5 only. Inspect missing column before this non-repeatable ALTER.
ALTER TABLE telephony_operator_state ADD COLUMN unavailable_since DATETIME NULL;
