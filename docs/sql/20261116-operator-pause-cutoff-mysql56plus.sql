-- MySQL >=5.6.4 only. Inspect version and missing column before this ALTER.
ALTER TABLE telephony_operator_state ADD COLUMN unavailable_since DATETIME(3) NULL;
