-- Proposed ONLY if information_schema confirms cliente_bloqueado is absent.
-- Source: sgr/sgr/SQL/01.04.22 - CREATE TABLE CLIENTE_BLOQUEADO.sql.
-- No decision/backfill or approval/rejection execution is enabled by this DDL.
-- A foreign key is intentionally not assumed before validating tenant key types/consumers.
CREATE TABLE cliente_bloqueado (
  CODIGO INT NOT NULL AUTO_INCREMENT,
  CODIGO_CAMPANHA_CLIENTE INT NOT NULL,
  DATA_HORA_CRIACAO TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  BLOQUEADO ENUM('S','N') NULL DEFAULT 'N',
  PRIMARY KEY (CODIGO),
  KEY FK_CAMP_CLIENTE_CB (CODIGO_CAMPANHA_CLIENTE)
) ENGINE=InnoDB;
