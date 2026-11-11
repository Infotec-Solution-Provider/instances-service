-- Apply explicitly only to the instances registry database, never to tenant CRMs.
CREATE TABLE IF NOT EXISTS admin_saved_configurations (
  resource_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_encrypted LONGTEXT NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (resource_key)
) ENGINE=InnoDB;
