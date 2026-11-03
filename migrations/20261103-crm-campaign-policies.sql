-- Run only against explicitly approved homolog CRM databases.
-- Supplemental manual campaigns keep legacy campanhas.UNIDADE/TIPO empty;
-- this table is the authoritative organizational and operational association.
CREATE TABLE IF NOT EXISTS crm_campaign_policies (
  campaign_id INT NOT NULL,
  unit_id INT NOT NULL,
  operation_mode ENUM('audience_manual') NOT NULL,
  overlap_policy ENUM('allow') NOT NULL,
  assignment_policy ENUM('explicit_operator') NOT NULL,
  change_effect ENUM('future_batches') NOT NULL,
  PRIMARY KEY (campaign_id),
  KEY crm_campaign_policy_unit (unit_id)
) ENGINE=InnoDB;
