-- Application-owned migration only; never execute DDL during requests/startup.
CREATE TABLE IF NOT EXISTS crm_registration_receipts (
  operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id INT NOT NULL,
  kind VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (operation_id),
  KEY actor_created (actor_id, created_at)
) ENGINE=InnoDB;
