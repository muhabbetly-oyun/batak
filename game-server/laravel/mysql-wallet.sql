-- muhabbetly tarafinda (MySQL). Jeton defteri BURADA.

CREATE TABLE IF NOT EXISTS wallets (
  user_id    VARCHAR(64) PRIMARY KEY,
  balance    BIGINT NOT NULL DEFAULT 0,
  held       BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CHECK (balance >= 0),
  CHECK (held >= 0)
) ENGINE=InnoDB;

-- Idempotans anahtari TEKIL olmak zorunda. Ag koparsa oyun sunucusu ayni
-- cagriyi tekrar gonderir; bu indeks ikinci kez para hareketi olmasini
-- engelleyen tek sey.
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL,
  table_id        VARCHAR(64)  NOT NULL,
  hand_no         INT          NOT NULL,
  op              ENUM('hold','settle','release') NOT NULL,
  payload         JSON         NOT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_idem (idempotency_key),
  KEY idx_table_hand (table_id, hand_no)
) ENGINE=InnoDB;
