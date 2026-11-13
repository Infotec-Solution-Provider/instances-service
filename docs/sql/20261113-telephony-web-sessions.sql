-- Per-tenant migration, applied with the telephony runtime migration before enabling the tenant.
-- UTC observations. Gaps are closed at last_seen; they are never counted as connected time.
CREATE TABLE IF NOT EXISTS telephony_web_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  segment INT UNSIGNED NOT NULL,
  operator_id INT NOT NULL,
  started_at DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  ended_at DATETIME NULL,
  end_reason VARCHAR(20) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_web_session_segment (session_id,segment),
  KEY ix_web_session_operator_time (operator_id,started_at,last_seen)
) ENGINE=InnoDB;
