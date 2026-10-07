# Sunucu kurulumu

Depo: `https://github.com/muhabbetly-oyun/batak`
Sunucu: `46.31.77.157` · `oyun.muhabbetly.com`

Bundan sonra dosya transferi yok — sunucu depoyu doğrudan çeker.

---

## 1. Mevcut kurulumu yedekle

Sunucuda (`root@oyun`):

```bash
/srv/oyun/scripts/backup.sh
```

```bash
cp /srv/oyun/.env ~/env-yedek-$(date +%Y%m%d-%H%M)
```

`.env` içindeki **PGPASSWORD**'ü not edin; veri aynı volume'da kalacak,
aynı parolayı kullanmalıyız.

## 2. Depoyu çek

```bash
cd /srv
```

```bash
git clone https://github.com/muhabbetly-oyun/batak.git oyun-yeni
```

Private depo ise kullanıcı adı + **personal access token** sorar
(GitHub → Settings → Developer settings → Personal access tokens → Fine-grained,
bu depoya `Contents: Read` izni).

## 3. .env hazırla

```bash
cd /srv/oyun-yeni
cp .env.ornek .env
chmod 600 .env
```

```bash
nano .env
```

Doldurulacaklar:

- `PGPASSWORD` → **eski .env'deki değerin AYNISI** (veri o parolayla yazıldı)
- `SESSION_SECRET` → `openssl rand -hex 32`
- `ADMIN_HASH` → aşağıdaki komutun çıktısı

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'SECTIGINIZ_PAROLA'
```

Kontrol — **sıfır olmadan devam etmeyin**:

```bash
grep -c DEGISTIRIN .env
```

## 4. Eski kurulumu durdur, yenisini başlat

Veri volume'ları adlarıyla bağlı, **silinmez**:

```bash
cd /srv/oyun && docker compose down
```

```bash
cd /srv/oyun-yeni && docker compose up -d --build
```

İlk derleme 2–4 dakika sürer (iki paket + bağımlılıklar).

## 5. Yeni şemayı yükle

`db/` klasörü yalnızca **boş** veritabanında otomatik çalışır. Mevcut veri
olduğu için elle yükleyeceğiz:

```bash
docker compose exec -T postgres psql -U oyun -d oyun < game-server/db/002_runtime_config.sql
```

```bash
docker compose exec -T postgres psql -U oyun -d oyun < game-server/db/003_players.sql
```

```bash
docker compose exec postgres psql -U oyun -d oyun -c "\dt"
```

`players`, `wallets`, `wallet_ledger`, `sessions` görünmeli.

## 6. Doğrula

```bash
docker compose ps
```

```bash
curl -s https://oyun.muhabbetly.com/health
```

Tarayıcıda `https://oyun.muhabbetly.com` → giriş ekranı gelmeli.

Panel: `https://oyun.muhabbetly.com/admin` → kullanıcı `admin`, parola
yukarıda belirlediğiniz.

## 7. İlk hesabı aç

Tarayıcıdan "Hesap açın" ile kayıt olun. 5.000 jeton otomatik yatar.

```bash
docker compose exec postgres psql -U oyun -d oyun \
  -c "SELECT username, created_at FROM players;"
```

## 8. Temizlik (her şey çalıştıktan SONRA)

```bash
mv /srv/oyun /srv/oyun-eski && mv /srv/oyun-yeni /srv/oyun
```

Yedek script'inin yolu değiştiği için cron'u güncelleyin:

```bash
crontab -l
```

Bir hafta sorunsuz geçerse `/srv/oyun-eski` silinebilir.

---

## Geri alma

Yeni sürüm sorun çıkarırsa:

```bash
cd /srv/oyun-yeni && docker compose down
cd /srv/oyun && docker compose up -d
```

Veri volume'larda, kayıp olmaz.

## Sonraki güncellemeler

```bash
cd /srv/oyun && git pull && docker compose up -d --build
```

## Bilinen eksikler

- Masa içi sohbet yok
- Tek masa tipi: Eşli Batak, tek bahis seviyesi (kasıtlı — masa doluluğu)
- Anlaşmalı oyun tespiti: veri toplanıyor, algoritma yok
- Yedek hâlâ aynı sunucuda; gerçek oyuncu verisi girmeden önce dışarı atın
