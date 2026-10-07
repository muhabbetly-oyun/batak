# Kontrol paneli

`oyun.muhabbetly.com/admin` adresinde servis edilir. `index.html` tek dosya,
harici bağımlılık yok (yalnızca Google Fonts).

## Sunucuya bağlama

Oyun sunucusunda üç uç gerekir:

| Uç | Ne yapar |
| --- | --- |
| `GET /admin/api/config` | Çalışan ayarı döner |
| `PUT /admin/api/config` | Doğrular ve kaydeder; hatalıysa 422 + `issues[]` |
| `GET /admin/api/tables` | Açık masaların özeti |

`src/config/store.ts` içindeki `merge()` ve `validate()` bu işi yapar:

```ts
const next = merge(current, await readJson(req));
const issues = validate(next);
if (issues.length) return json(res, 422, { issues });
await saveConfig(next, adminUserId);
```

## Erişim

Panel yetki kontrolü yapmaz; **sunucu yapar.** Önerilen: Caddy'de temel kimlik
doğrulama veya platformdan gelen admin JWT'si. Panelin kendisi korumasız
kalırsa jeton ekonomisini herkes değiştirebilir.

Caddy örneği:

```
handle /admin* {
  basic_auth {
    admin <bcrypt-hash>
  }
  reverse_proxy game:3000
}
```

Hash üretmek için: `docker compose exec caddy caddy hash-password`

## Davranış

- Değişen satır sarı işaretlenir ve "önce X → şimdi Y" gösterir
- Kaydedene kadar hiçbir şey sunucuya gitmez
- Sunucu 422 dönerse ilgili satır kırmızı olur, hata mesajı altında yazar
- Sunucuya ulaşılamazsa örnek değerlerle açılır ve bunu söyler

## Neden kaydedilen ayar oynanan masayı etkilemez

`createTable()` varyant ayarının **kopyasını** masaya yazar. Panelden kural
değişse bile oynanan masa kendi kurallarıyla biter. Bunun testi var:
`test/table.test.ts` → "masa, varyant ayarının kopyasını tutar".
