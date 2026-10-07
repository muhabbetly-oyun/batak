# Bağlantı katmanı

Kural motorunu (`@muhabbetly/batak-engine`) çalışan sunucuya oturtur. Motor
saftır ve dış dünyayı bilmez; bu katman zamanı tutar, efektleri gerçek
çağrılara çevirir ve istemcilere görünüm gönderir.

## Akış

```
İstemci (WebSocket)
   │  {"type":"play","card":27}
   ▼
ws/protocol.ts ── doğrula, koltuğu SUNUCUDAN al
   ▼
tables/registry.ts ── hangi masa, hangi koltuk
   ▼
tables/runner.ts ── kuyruk, tek tek işle
   ▼
engine.step(state, input) ── saf, yan etkisiz
   │
   ├─ effects: wallet_hold ──→ effects/wallet.ts ──→ Laravel (10.8.0.1, imzalı)
   ├─ effects: publish ──────→ effects/reverb.ts ──→ Reverb (10.8.0.1:8080)
   ├─ effects: persist ──────→ effects/persist.ts ─→ Postgres
   └─ effects: schedule ─────→ setTimeout → tick
```

## Dosyalar

| Dosya | İş |
| --- | --- |
| `src/ws/protocol.ts` | İstemci mesajlarını doğrular, hız sınırı |
| `src/tables/registry.ts` | Masa kaydı, eşleştirme, oda→masa akışı |
| `src/tables/runner.ts` | Kuyruk, efekt yürütme, zamanlayıcı, görünüm gönderimi |
| `src/effects/wallet.ts` | İmzalı cüzdan çağrıları, idempotans |
| `src/effects/reverb.ts` | Mevcut Reverb'e olay yayını |
| `src/effects/persist.ts` | Olay akışı, el kayıtları, parmak izi |
| `src/admin/routes.ts` | Ayar deposu + panel uçları |
| `db/002_runtime_config.sql` | Ayar tablosu |
| `laravel/` | muhabbetly tarafına konacak dosyalar |

## Kurulum

### 1. Postgres

```bash
docker compose exec -T postgres psql -U oyun -d oyun < db/002_runtime_config.sql
```

### 2. Laravel tarafı (212.16.87.1)

| Dosya | Nereye |
| --- | --- |
| `laravel/WalletInternalController.php` | `app/Http/Controllers/Internal/` |
| `laravel/VerifyInternalHmac.php` | `app/Http/Middleware/` |
| `laravel/GameTokenController.php` | `app/Http/Controllers/` |
| `laravel/mysql-wallet.sql` | MySQL'de çalıştırın |

`.env` ekleyin:

```
OYUN_INTERNAL_SECRET=<oyun sunucusundaki INTERNAL_API_SECRET ile AYNI>
```

`config/services.php`:

```php
'oyun' => [
    'secret'      => env('OYUN_INTERNAL_SECRET'),
    'allowed_ips' => ['10.8.0.2'],
],
```

### 3. JWT anahtar çifti

```bash
# Laravel sunucusunda
openssl genrsa -out storage/jwt-private.pem 2048
openssl rsa -in storage/jwt-private.pem -pubout -out jwt-public.pem
chmod 600 storage/jwt-private.pem
```

`jwt-public.pem` içeriğini **oyun sunucusunun** `.env` dosyasına
`JWT_PUBLIC_KEY` olarak koyun (satır sonları `\n`).

**Private key oyun sunucusuna asla gitmez.**

### 4. Panelin korunması

Panel kendi yetki kontrolünü yapmaz. Caddy'de:

```
handle /admin* {
  basic_auth {
    admin <bcrypt-hash>
  }
  reverse_proxy game:3000
}
```

Hash: `docker compose exec caddy caddy hash-password`

Korumasız bırakılırsa jeton ekonomisini herkes değiştirir.

## Cüzdan: neden böyle

Jeton defteri Laravel'de kalıyor, oyun sunucusu MySQL'e hiç bağlanmıyor.
Tek ekonomi defteri, tek yedek, tek doğruluk kaynağı.

Her çağrı idempotent anahtar taşıyor (`hold:{tableId}:{handNo}`). Ağ koparsa
oyun sunucusu aynı çağrıyı tekrar gönderir; MySQL'deki `UNIQUE KEY uniq_idem`
ikinci kez para hareketi olmasını engelleyen tek şey. **O indeksi atlamayın.**

El başında tek `hold`, el sonunda tek `settle`. Hamle başına çağrı yok —
tünel gecikmesi 4,7 ms olsa bile her hamlede ağ turu beklemek oyunu
yavaşlatır.

### Başarısızlık halleri

| Durum | Ne olur |
| --- | --- |
| `hold` başarısız | El başlamaz, masa kapanır, oyunculara sebep söylenir |
| `settle` başarısız | **Alarm üretilir.** El oynandı ama para yazılmadı; idempotent anahtarla tekrar denenebilir, mutabakat gerekir |
| Reverb erişilemez | Oyun sürer; sohbet yayını kaybolur, loglanır |
| Postgres yazamaz | Oyun sürer; olay akışı eksilir, loglanır |

`settle` başarısızlığı tek gerçek ciddi hal. Loglarda
`MUTABAKAT GEREKIYOR` araması yapan bir alarm kurun.

## Gizlilik

- Rakip kartları hiçbir pakette bulunmaz. `viewFor(state, seat)` her oyuncuya
  yalnızca kendi kartlarını verir; bunun testi var.
- `cards_dealt` olayı Reverb'e **basılmaz** — kanal herkese açık.
- Kartlar olay akışına yazılmaz. El sonunda seed açıklandığı için dağıtım
  zaten yeniden üretilebilir.

## Testler

```bash
npm test
```

24 test: HMAC imzası, tekrar saldırısı penceresi, idempotans anahtarı,
protokol doğrulama (aralık dışı kart/teklif/renk, bozuk JSON, aşırı büyük
mesaj), hız sınırı, Reverb'e sızıntı kontrolü.

`shim/` klasörü `@types/node` olmayan ortamda derleme içindir; `npm install`
sonrası silin.

## Henüz yazılmayanlar

- **WebSocket sunucusu** — `protocol.ts` ve `registry.ts` hazır; mevcut
  `ws.ts` dosyasına bağlanacak
- **İstemci** — masa arayüzü
- **Eş iletişimi kısıtları** — eşli masada el sırasında serbest sohbetin
  kapatılması (spec'te tanımlı, kodda yok)
- **Anlaşmalı oyun tespiti** — veri toplanıyor (`session_fingerprints`),
  algoritma yok

## WebSocket sunucusu

`src/ws/server.ts` ve `src/index.ts` eklendi. `index.ts`, mevcut oyun
sunucusundaki dosyanın yerini alır.

### İstemci akışı

```
1. Tarayıcı muhabbetly'ye giriş yapar (mevcut oturum)
2. GET /oyun/bilet  →  { token, ws: "wss://oyun.muhabbetly.com/ws" }
3. new WebSocket(ws, ["bearer", token])
4. ← {"type":"hello","userId":"..."}
5. → {"type":"join","variantId":"esli","roomId":"oda-42"}
6. ← {"type":"joined","tableId":"...","seat":2}
7. ← {"type":"state","view":{...}}   her hamleden sonra
8. → {"type":"play","card":27}
```

Token alt protokolde taşınır, query string'de değil — query string proxy
loglarına düşer.

### Koltuk istemciden gelmez

İstemci `{"type":"play","card":27,"seat":3}` gönderse bile `seat` yok
sayılır. Koltuk sunucudaki oturumdan okunur. Testi var.

### Tek bağlantı kuralı

Aynı kullanıcı ikinci kez bağlanırsa eski bağlantı `4001 baska_cihaz` ile
kapanır. Çoklu sekmeyle aynı masada iki kez oynamayı engeller.

### Kopma

Bağlantı kapandığında oyuncu masadan **düşürülmez**; 90 saniyelik yeniden
bağlanma penceresi işler. Dönen oyuncu `{"type":"rejoined"}` alır ve masa
durumu yeniden gönderilir. Dönmezse bot devralır.

### Deploy

Yeniden başlatmadan önce açık soketlere `1012 server_restarting` gönderilir.
İstemci bunu görünce otomatik yeniden bağlanmalı.

## Çalıştırma

```bash
npm install
npm test            # 31 test
npm run build
```

Motor paketi `file:../batak-engine` olarak bağlı. İki paketi aynı repoda
yan yana tutun.
