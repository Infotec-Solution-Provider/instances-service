-- Proposed per-tenant migration. No automatic execution; review actual capabilities first.
CREATE TABLE crm_import_receipts (
  operation_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id INT NOT NULL,
  customer_id INT NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (operation_key)
) ENGINE=InnoDB;
