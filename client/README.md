# Batak masası — istemci

Tek dosya, derleme adımı yok. `oyun.muhabbetly.com/` adresinden servis edilir.

## Nasıl çalışır

İstemci **kural çalıştırmaz.** Sunucudan gelen görünümü çizer ve niyet bildirir.
Oynanabilir kartlar bile sunucudan gelir (`view.hand.myLegalCards`); burada
hesaplanmaz. Böylece istemciyi kurcalayan biri kural dışı hamle yapamaz.

## Bağlantı akışı

```
1. GET /oyun/bilet            → { token }          (Laravel, mevcut oturumla)
2. new WebSocket("/ws", ["bearer", token])
3. → {"type":"join","variantId":"esli","roomId":"..."}
4. ← {"type":"joined","seat":2}
5. ← {"type":"state","view":{...}}                 her hamleden sonra
6. → {"type":"play","card":27}
```

`?oda=xyz` sorgu parametresiyle açılırsa o odadaki masaya oturur — sohbet
odasından "masa kur, arkadaşlarını çağır" akışı bunun üstüne kurulur.

## Deneme masası

Sunucu olmadan arayüzü görmek için "Deneme masası" düğmesi var. Tarayıcıda
basit bir simülasyon çalıştırır; **kural motoru değildir**, yalnızca ekranı
doldurur. Tasarım üzerinde konuşmak ve ekibe göstermek için.

## Tasarım kararları

**Dört renkli deste.** Maça siyah, kupa kırmızı, karo mavi, sinek yeşil.
Geleneksel iki renkli destede telefon ekranında karo ile kupayı ayırmak zor;
dört renk yanlış kart oynamayı belirgin şekilde azaltır.

**Kendi koltuğunuz daima altta.** Sunucu koltuk numarasını mutlak verir
(0–3); istemci bunu kendi koltuğuna göre döndürür. Oyuncu hep aynı yerden
bakar.

**Süre halkası aktif oyuncunun altında.** Son 5 saniyede kırmızıya döner.
Bitiş zamanı sunucudan damga olarak gelir, geri sayımı istemci çizer —
istemci saati kaydırsa bile sunucu kararı değişmez.

**Oynanamayan kartlar soluk, oynanabilirler kalkıyor.** Renk uyma
zorunluluğunu öğretmenin en hızlı yolu; kural metni okutmaya gerek kalmıyor.

## Yapılacaklar

- Masa içi sohbet paneli (mevcut Reverb `table.{id}` kanalına bağlanacak)
- Eşli masada el sırasında serbest sohbetin kapatılması (spec'te tanımlı)
- El sonu puan tablosu (şu an sadece toplam gösteriliyor)
- Kart dağıtma ve tur toplama animasyonu
- Ses (isteğe bağlı, varsayılan kapalı)
