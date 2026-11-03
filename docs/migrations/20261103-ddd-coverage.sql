-- G04 coverage only. Never use cidades_ddd (local-dialing exceptions).
-- Provision explicitly in an isolated test DB first; not executed by application startup.
-- Intentionally no FK against tenant-specific legacy column types/collations.
-- The signed repository locks and validates fone_areas/cidades on every write.
CREATE TABLE crm_ddd_city_links (
  ddd VARCHAR(5) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  city_id INT NOT NULL,
  uf CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_city VARCHAR(200) NOT NULL,
  created_by INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (ddd, city_id),
  KEY idx_crm_ddd_city_links_city (city_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
