-- Apply explicitly to the instances database and each participating CRM database.
-- No DDL is performed by administration requests. Legacy business tables must be InnoDB.
CREATE TABLE IF NOT EXISTS admin_operation_receipts (
  operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (operation_id)
) ENGINE=InnoDB;
