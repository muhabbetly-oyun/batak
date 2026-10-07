# @muhabbetly/batak-engine

Batak kural motoru. **Saf fonksiyon**, bağımlılıksız (yalnızca `node:crypto`).
Dört varyantı da destekler: Eşli, İhaleli, Koz, Gönül Batağı.

Spec: *Batak Kural Spesifikasyonu — Muhabbetly Oyun*

## Neden böyle yazıldı

Motor `(state, move) → (state', events)` imzasında saf bir reducer. Yan etki
yok, zaman yok, rastgelelik yok — seed dışarıdan verilir. Bunun üç getirisi var:

- Binlerce el test olarak koşturulabilir (şu an 38 test, 200 rastgele el dahil)
- Şikâyet geldiğinde el, olay akışından birebir yeniden oynatılabilir
- Masa aktörü (tek-threaded state machine) bu fonksiyonu çağırır, kural
  mantığını kendi taşımaz

Motor **asla exception atmaz**. Kural ihlali `{ error: RuleError }` olarak döner
ve state değişmez. Bu, kötü niyetli istemcinin sunucuyu düşürmesini engeller.

## Kurulum

```bash
npm install
npm test     # 38 test
npm run build
```

`shim/` klasörü yalnızca `@types/node` olmayan ortamda derleme içindir.
`npm install` sonrası silin ve `tsconfig.json`'a `"types": ["node"]` ekleyin.

## Kullanım

```ts
import {
  ESLI_BATAK, startHand, applyMove, legalCards, newSeed,
} from "@muhabbetly/batak-engine";

const seed = newSeed();                       // 32 byte hex
let { state, events } = startHand(ESLI_BATAK, 3, seed);
// events[0].seedHash yayımlanır; seed el bitene kadar saklanır

const r = applyMove(state, { type: "bid", seat: 0, value: 5 }, ESLI_BATAK, seed);
if (r.error) {
  // kural ihlali — state değişmedi, istemciye hata kodu dön
} else {
  state = r.state;
  // r.events -> table_events tablosuna yaz, oyunculara yayınla
}
```

İstemciye gönderilecek oynanabilir kartlar:

```ts
const cards = legalCards(state, seat, ESLI_BATAK);
```

İstemci bunu kendi hesaplamaz. Sunucu gönderir, sunucu doğrular.

## Açık kararlar nerede

Spec'teki "Karar bekleyen maddeler" bölümü `src/variants.ts` içinde **bayrak**
olarak duruyor. Karar değişince tek satır değişir, motor değişmez:

| Bayrak | Varsayılan | Karar |
| --- | --- | --- |
| `minBid` | 5 | İhale tabanı |
| `mustPlayTrumpWhenVoid` | `false` | Elde açılan renk yoksa koz zorunlu mu |
| `contractorScoresActualTricks` | `true` | Tutturunca aldığı tur mu, taahhüt mü |
| `fixedTarget` (Koz Batak) | 3 | Herkesin sabit hedefi |
| `slamBonus` (Gönül) | `true` | 13 turun hepsi +13 mü |

Her bayrak için test var. Kararı değiştirdiğinizde ilgili test kırmızıya döner
ve beklenen değeri güncellemeniz gerekir — niyetli değişiklik, kazara değil.

## Henüz yazılmayanlar

- **Masa aktörü** — koltuklar, süre takibi, kopma, bot devralma. Motor bunları
  bilmez ve bilmemeli; zamanı yöneten katman ayrı olmalı.
- **Bot** — kurallara uygun en basit hamle. `legalCards(...)[0]` testlerde bu
  işi görüyor, gerçek bot biraz daha iyisini yapmalı (en küçük kartı atmak).
- **Cüzdan** — `hold` / `settle` çağrıları motorun dışında.
- **Reverb publish** — olay akışı `table.{id}` kanalına buradan değil, masa
  aktöründen yayılır.

## Dosyalar

| Dosya | İçerik |
| --- | --- |
| `src/types.ts` | Kart kodlaması, state, move, event, hata tipleri |
| `src/variants.ts` | Dört varyant + açık kararların bayrakları |
| `src/deck.ts` | Seed'li deterministik karıştırma, commit-reveal |
| `src/engine.ts` | Reducer: ihale, koz seçimi, kart oynama, tur alma |
| `src/scoring.ts` | Varyant başına puanlama, oyun sonu, beraberlik |
| `test/engine.test.ts` | 38 test |

## Kart kodlaması

Kart `0..51` arası bir sayı: `suit * 13 + (rank - 2)`.
Renk sırası: 0=Maça, 1=Kupa, 2=Karo, 3=Sinek. Rütbe 2..14 (14 = As).

Sayısal tutulmasının sebebi karşılaştırmanın ucuz, serileştirmenin küçük
olması — 13 turda 52 kart, saniyede yüzlerce masa.

## Karıştırma doğrulanabilirliği

El başında `sha256(seed)` yayımlanır, el sonunda `seed` açıklanır. Oyuncu
`deal(seed)` çağırıp dağıtımı kendi üretebilir. Bu, "site hile yapıyor"
iddiasına karşı tek gerçek savunma — ve rakipsiz bir güven argümanı, çünkü
Türkiye'deki okey/batak sitelerinin hiçbiri bunu sunmuyor.
