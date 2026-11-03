-- PROPOSAL ONLY. Apply through a separately authorized migration to each eligible tenant.
-- Existing CRM tables must also be InnoDB; unsupported triggers block the command.
CREATE TABLE crm_administration_transfers (
  operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id INT NOT NULL,
  transfer_id INT NOT NULL,
  before_json MEDIUMTEXT CHARACTER SET utf8mb4 NOT NULL,
  after_json MEDIUMTEXT CHARACTER SET utf8mb4 NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (operation_id),
  KEY transfer_id (transfer_id)
) ENGINE=InnoDB;
