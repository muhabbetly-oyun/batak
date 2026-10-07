-- ===========================================================================
-- Oyuncu hesaplari ve jeton cuzdani.
--
-- Cuzdan ARTIK BURADA. Muhabbetly canli destek urunu; oyunun kendi oyuncu
-- sistemi var. Bu, cuzdani HTTP cagrisi olmaktan cikariyor: hold/settle
-- ayni veritabaninda tek transaction, ag kopmasi ve mutabakat derdi yok.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --- Oyuncular -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS players (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Kucuk harfe indirgenmis tekil ad. "Ahmet" ve "ahmet" ayni hesaptir.
  username_key  TEXT        NOT NULL UNIQUE,
  -- Ekranda gorunen hali (buyuk/kucuk harf korunur).
  username      TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  -- Hesap kapatma / askiya alma
  status        TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','suspended','closed')),
  suspended_until TIMESTAMPTZ,
  suspend_reason  TEXT
);
CREATE INDEX IF NOT EXISTS players_created ON players (created_at DESC);

-- --- Cuzdan ----------------------------------------------------------------
-- balance = toplam jeton. held = masada bloke edilmis kisim.
-- Harcanabilir = balance - held.
CREATE TABLE IF NOT EXISTS wallets (
  player_id     UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  balance       BIGINT      NOT NULL DEFAULT 0 CHECK (balance >= 0),
  held          BIGINT      NOT NULL DEFAULT 0 CHECK (held >= 0),
  last_bonus_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT held_within_balance CHECK (held <= balance)
);

-- --- Defter ----------------------------------------------------------------
-- Her jeton hareketi buraya duser. Silinmez, guncellenmez.
-- Sikayet geldiginde oyuncunun tum jeton gecmisi buradan okunur.
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id              BIGSERIAL PRIMARY KEY,
  player_id       UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  op              TEXT        NOT NULL
                              CHECK (op IN ('signup_gift','daily_bonus','hold',
                                            'settle','release','admin_adjust')),
  -- Isaretli degisim. hold/release bakiyeyi degistirmez, yalnizca held.
  amount          BIGINT      NOT NULL,
  balance_after   BIGINT      NOT NULL,
  held_after      BIGINT      NOT NULL,
  table_id        UUID,
  hand_no         INT,
  -- Ayni islemin iki kez islenmesini engeller.
  idempotency_key TEXT UNIQUE,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_player ON wallet_ledger (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_table  ON wallet_ledger (table_id) WHERE table_id IS NOT NULL;

-- --- Oturumlar -------------------------------------------------------------
-- JWT kisa omurlu; yenileme bileti burada. Cikis yapinca satir silinir,
-- boylece calinmis bilet iptal edilebilir.
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- Ham bilet DEGIL, SHA-256 ozeti saklanir.
  token_hash  TEXT        NOT NULL UNIQUE,
  ip          INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_player ON sessions (player_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- --- Giris denemeleri ------------------------------------------------------
-- Kaba kuvvet denemelerini sinirlamak icin.
CREATE TABLE IF NOT EXISTS login_attempts (
  id           BIGSERIAL PRIMARY KEY,
  username_key TEXT        NOT NULL,
  ip           INET,
  ok           BOOLEAN     NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attempts_user ON login_attempts (username_key, created_at DESC);
CREATE INDEX IF NOT EXISTS attempts_ip   ON login_attempts (ip, created_at DESC);

-- --- Ekonomi ayarlari ------------------------------------------------------
-- Panelden degistirilebilir olsun diye tabloda; kodda sabit degil.
INSERT INTO runtime_config (id, value)
VALUES (1, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
