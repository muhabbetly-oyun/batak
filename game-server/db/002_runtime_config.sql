-- Calisma zamani ayarlari. Tek satir, JSONB.
-- Panelden degistirilir; masa kurulurken KOPYASI masaya yazilir, boylece
-- oynanan masa ayar degisikliginden etkilenmez.
CREATE TABLE IF NOT EXISTS runtime_config (
  id    SMALLINT PRIMARY KEY CHECK (id = 1),
  value JSONB NOT NULL
);

-- Ayar degisikliklerinin izi. Kim ne zaman neyi degistirdi.
CREATE TABLE IF NOT EXISTS config_audit (
  id         BIGSERIAL PRIMARY KEY,
  changed_by TEXT        NOT NULL,
  before     JSONB,
  after      JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS config_audit_time ON config_audit (created_at DESC);
