# GUI Yeniden Tasarım İş Planı — Hareket, Açılır Katmanlar ve Etkileşim

> Kaynak: KadroSphere UI Tasarım Rehberi (bölüm 3–26).
> Hedef: ER ŞAT Dijital Defter'in **renk paletine dokunmadan** açılır ekranlarını, hareket (fizik) modelini ve mikro-etkileşimlerini yenilemek.
> Durum: Faz 0–11 tamamlandı (2026-11-22). Açık kalan: ekran okuyucuyla elle kontrol ve commit.

---

## 1. Alınan kararlar

| Konu | Karar |
|------|-------|
| Renkler | **Değişmez.** `styles.css` içindeki açık ve koyu tema `:root` renk değişkenleri (`--gold`, `--paper`, `--surface`, `--sidebar`…) aynen kalır. Rehberdeki yeşil `--accent` rolünü uygulamanın mevcut altını (`--gold` / `--gold-bright`) üstlenir. Glow ve saydam tonlar yeni renk değil, mevcut değişkenlerden `color-mix()` ile türetilir. |
| Hareket yoğunluğu | **Orta.** Kart üzerine gelince 2px yükselme ve altın glow, butona basınca 0.97 ölçek, pencereler 200–250 ms'de hafif yayla açılır, kapanış 150 ms. |
| Cam efekti | **Sadece açılır katmanlarda**: modal, çekmece, popover, Ctrl+K paleti, üst bar ve toast. Kartlar, tablolar, formlar ve bakiye kutuları opak kalır. |
| Kapsam | Ana defter (10 bölüm), tezgâh (`/checkout`), giriş ve çalışan hesapları (`/login`, `/users`), mobil rapor (`/reports`). |
| Menü | Sol menü kalır ve yenilenir: aktif öğe göstergesi, hover ve daraltma animasyonu eklenir. |
| Yazı tipi ve ikon | Mevcut sistem fontu (Segoe UI) ve çizgi SVG ikonlar kalır. Inter ve Font Awesome eklenmez, CDN kullanılmaz. |
| Hareketli arka plan | **Sadece giriş ekranında**, mevcut altın tonlarıyla, çok düşük opaklıkta. |
| Açılır ekran türleri | Ortada açılan onay pencereleri, sağdan kayan çekmeceler, telefonda alttan açılan sayfa (bottom sheet), ilerleme çubuklu çok adımlı sihirbaz. |

## 2. Dokunulmayacaklar (kırmızı çizgiler)

- **Renk değerleri**: hiçbir hex değeri değişmez ve yeni renk tonu eklenmez. Yeni değişkenler yalnızca mevcut renklerin saydam karışımı olabilir.
- **CSP** (`style-src 'self'; script-src 'self'`): satır içi `<style>`, `style="…"` niteliği, CDN ya da `'unsafe-inline'` kullanılmaz. Gerekli dinamik değerler JS içinden CSSOM ile (`el.style.setProperty`) verilir; bu yöntem `ui-kit.js` içinde zaten kullanılıyor.
- **DOM sözleşmesi**: testlerin ve `app.js`'in kullandığı `id`, `data-*`, `role`, `aria-*` öznitelikleri ve DOM sırası korunur. Yeni sınıflar eklenebilir, mevcut sınıflar kaldırılmaz.
- **Katman davranışı**: odak tuzağı, `Esc`, geri tuşu ve history senkronu, `inert` arka plan ve odağın geri dönmesi gibi davranışlar aynen kalır. Animasyon bu davranışları geciktirmez.
- **Finansal okunabilirlik**: tutar, bakiye ve gram değerleri hiçbir zaman animasyonla sayılmaz, bulanıklaşmaz ve kaymaz. Rakamlar opak zemin üzerinde durur.
- **Mali ve sunucu kodu**: `domain.mjs`, `repository.mjs`, `server.mjs` ve diğer `.mjs` sunucu dosyalarına dokunulmaz. Bu iş yalnızca `public/` klasörünü kapsar.

## 3. Rehberden uygulamaya eşleme

| Rehber bölümü | Uygulamadaki karşılığı | Uyarlama |
|---|---|---|
| §3 Hareketli arka plan | `login.html` / `access.css` | `body::before` üzerinde 3 radial gradyan; altın (`--gold`), `--gold-bright` ve `--gold-text` tonlarıyla, %3–6 opaklıkta, 20 sn döngüyle |
| §4 Glass card | Sadece katmanlarda | `.defter-dialog`, `.defter-drawer`, `.defter-popover`, komut paleti, `.topbar` |
| §5 Nav | Sol `.sidebar` | Aktif öğe için kayan altın gösterge, hover arka planı, daraltma animasyonu |
| §7 Auth ekranı | `/login`, `/users` | Ortalanmış cam kart, yumuşak giriş animasyonu, odakta altın hale |
| §8 Onboarding wizard | İlk kurulum + İşlem Ekranı 3 adımlı akış | İlerleme çubuğu, "Adım 1 / 3" etiketi, adımlar arası kayma geçişi |
| §9 Buton sistemi | `.button`, `.secondary`, `.gold`, `.danger`, `.compact`, `.text` | Basınca 0.97 ölçek, hover'da kalkma ve glow. Varyant isimleri değişmez. |
| §10–11 Stat ve liste kartları | Bakiye, hesap, stok ve banka kartları | Yalnızca **tıklanabilir** kartlarda hover kalkışı; bilgi kartları sabit kalır |
| §12 Modal | `openModal`, `confirmCritical` | Ölçek ve opaklık ile giriş, bulanık backdrop, kritik onaylarda kırmızı (`--red`) vurgu |
| §13 Toast | `toast()` | Sağdan kayarak girer ve çıkar, süre çubuğu gösterir, üzerine gelince durur (bu davranış zaten var) |
| §14 Flyout | `openPopover`, combobox listesi | `translateY(-8px) scale(.97)` girişi |
| §15 Segmented tab | Workbench sekmeleri, `stepper-tab`, filtre grupları | Aktif sekmenin arkasında kayan altın "hap" |
| §19 Tablo | Defter ve ekstre tabloları | Satır hover tonu (mevcut `--hover`). Satır ayrımı ve sticky thead korunur. |
| §20 Switch | Varsa onay kutusu tercihleri | `modern-switch` stili; mevcut `<input type=checkbox>` aynen kalır |
| §21 Boş durum ve spinner | `.loading`, `defter-skeleton`, `ledger-loading` | Mevcut iskelet korunur, geçişler yumuşatılır |
| §22 Sayfa geçişi | `data-view` değişimi | `main` içeriğinde 200 ms `fadeIn` (10px yukarı kayma) |
| §26 Erişilebilirlik | Mevcut `:focus-visible` ve skip-link | Korunur. Glow halesi eklenir, odak çizgisi kaldırılmaz. |

Rehberden **alınmayacaklar**: Google ile giriş, cookie banner, ELO/MVP/yıldız bileşenleri, SOS pulse (gerekirse yalnızca kritik uyarıda, sadeleştirilmiş haliyle), Font Awesome, Inter, Flatpickr, SortableJS.

## 4. Fizik / hareket modeli (tasarım token'ları)

Yeni dosya: `public/motion.css`. Bu dosya `styles.css`'ten sonra, tüm sayfalarda yüklenir. Renk içermez; yalnızca zaman, eğri, ölçek ve gölge token'larını tanımlar.

```css
:root {
  /* Süre */
  --dur-instant: 90ms;   /* buton basışı */
  --dur-fast:   150ms;   /* kapanış, hover */
  --dur-base:   220ms;   /* modal/popover açılış */
  --dur-slow:   250ms;   /* çekmece, bottom sheet, sihirbaz adımı (Faz 2'de 320 → 250: açılış ≤ 250 ms kuralı) */

  /* Eğri */
  --ease-out:    cubic-bezier(0.16, 1, 0.3, 1);     /* hızlı başla, yumuşak dur */
  --ease-in:     cubic-bezier(0.4, 0, 1, 1);        /* kapanış */
  --ease-spring: cubic-bezier(0.34, 1.32, 0.64, 1); /* hafif yay (~%3 aşma) */

  /* Fizik değerleri */
  --lift-hover: -2px;
  --press-scale: 0.97;
  --enter-scale: 0.96;

  /* Mevcut renklerden türetilen efektler (yeni renk değil) */
  --glow-gold: 0 0 0 1px color-mix(in srgb, var(--gold) 30%, transparent),
               0 6px 24px color-mix(in srgb, var(--gold) 22%, transparent);
  --glass-bg: color-mix(in srgb, var(--surface) 78%, transparent);
  --glass-border: color-mix(in srgb, var(--line-strong) 40%, transparent);
  --glass-blur: 16px;
}
```

**Hareket kuralları**

1. Sadece `transform` ve `opacity` canlandırılır; `width`, `height`, `top` ve `left` canlandırılmaz. Tek istisna sol menü daraltmasıdır; mevcut `width` geçişi korunur.
2. Hover efektleri yalnızca `@media (hover: hover) and (pointer: fine)` içinde çalışır. Dokunmatik ekranda "yapışkan hover" oluşmaz.
3. `@media (prefers-reduced-motion: reduce)` açıksa tüm süreler 0 ms'ye iner ve sadece opaklık değişir. Bunun için global bir kural yazılır (`styles.css:669`'daki mevcut kural genişletilir).
4. Cam efekti için `@supports not (backdrop-filter: blur(1px))` kontrolü yapılır; desteklemeyen tarayıcıda zemin opak `var(--surface)` olur.
5. Aynı anda ekranda en fazla bir bulanık katman bulunur; iç içe modal açılırsa alttaki katmanın blur'u kapatılır. Bu kural eski Windows PC'lerde performansı korur.
6. Açılış süresi 250 ms'yi, kapanış süresi 150 ms'yi geçmez. Klavyeyle hızlı çalışan kasiyer hiçbir zaman animasyonu beklemez.

**Bileşen bazında hareket tablosu**

| Bileşen | Açılış | Kapanış | Etkileşim |
|---|---|---|---|
| Modal (orta) | opaklık 0→1, ölçek 0.96→1, `--dur-base`, `--ease-spring` | opaklık 1→0, ölçek 1→0.98, `--dur-fast` | Backdrop 0→blur(4px) |
| Kritik onay | Modal ile aynı, ek olarak üstte `--red` şerit | Aynı | Doğrulama hatasında 3 kez ±4px yatay sarsıntı (reduced-motion açıksa yok) |
| Çekmece (masaüstü) | `translateX(100%)→0`, `--dur-slow`, `--ease-out` | `0→100%`, `--dur-fast` | — |
| Bottom sheet (≤700px) | `translateY(100%)→0`, `--dur-slow` | Aşağı kayar | Tutamaçtan sürükleme. Sürükleme yüksekliğin %30'unu ya da 0.5 px/ms hızı geçerse kapanır, geçmezse yayla geri döner. |
| Popover / combobox listesi | `translateY(-8px) scale(.97)→0`, 180 ms | Opaklık, 120 ms | Açıldığı yere göre origin |
| Ctrl+K paleti | Modal ile aynı, origin üstte | Aynı | Seçili satır arkasında kayan vurgu |
| Toast | `translateX(110%)→0`, `--dur-base` | `→110%` ve opaklık | Altta süre çubuğu (`scaleX` 1→0). Hover'da durur. |
| Buton | — | — | Hover: `--lift-hover` + `--glow-gold` (yalnızca `.gold` / birincil). Basış: `--press-scale`, `--dur-instant`. |
| Tıklanabilir kart | — | — | Hover: -2px + glow. Basış: 0.99. |
| Sol menü | — | — | Aktif öğe göstergesi `transform` ile yeni öğeye kayar (220 ms) |
| Sekme / stepper | — | — | Aktif "hap" kayar. Adım içeriği yöne göre ±24px kayarak değişir. |
| Sayfa (view) geçişi | `translateY(10px)→0` + opaklık, 200 ms | Anında | Tutarlar dahil tüm içerik birlikte gelir; sayı animasyonu yok |

## 5. Teknik mimari — çıkış animasyonu sorunu

`ui-kit.js` içindeki `close()` şu an dialog'u **eşzamanlı** kaldırıyor (`dialog.close(); dialog.remove()`). Testler (`qa-temp/*`) ve `app.js` bu davranışa güveniyor; örneğin `!document.querySelector('dialog[open]')` kontrolleri.

**Çözüm: "hayalet" çıkış (ghost exit).**

1. `close()` mevcut haliyle çalışmaya devam eder: dialog kapanır, DOM'dan kalkar, odak geri döner, history ve `inert` aynen işler. **Davranış sözleşmesi değişmez.**
2. Kapatmadan hemen önce dialog'un görsel bir kopyası alınır. Kopya, `aria-hidden="true"` ve `inert` taşıyan bir `.defter-ghost-host` öğesinin **gölge DOM'u (shadow root)** içine konur, Web Animations API ile kapanış animasyonunu oynatır ve bitince (yedek olarak süre + 250 ms zaman aşımıyla) silinir. *(Uygulandı: `ui-kit.js` `animateExit`.)*
3. Kopyada `<dialog>` yerine `<div>` kullanılır ve `id`/`name` nitelikleri silinir. **Gölge DOM zorunludur:** Faz 2'de ilk sürüm kopyayı normal DOM'a koyuyordu. Hem `paket6b` testleri hem uygulama kodu öğeleri `data-*` ve sınıf adlarıyla aradığı için kapanmakta olan kopyayı bulabiliyordu (ör. yeniden açılan palette `[data-command-palette-input]`). Gölge DOM içindeki hiçbir şey `document.querySelector` ile bulunamaz.
4. Gölge DOM'un stilleri, sayfanın kendi stil dosyalarından tek seferlik oluşturulan bir `CSSStyleSheet` kopyasıdır (`adoptedStyleSheets`). `:root[...]` seçicileri `:host(...)` seçicilerine çevrilir; host, `data-theme` ve `data-motion` niteliklerini taşır. Bu bir CSSOM işlemidir, satır içi stil sayılmaz; CSP korunur. Kopya, ilk katman açılınca tarayıcı boştayken önceden hazırlanır.
5. Animasyon azaltılmışsa (uygulama anahtarı veya sistem ayarı) ya da ortam animasyon desteklemiyorsa (JSDOM) kopya hiç oluşturulmaz.

Açılış animasyonu tamamen CSS ile çözülür (`dialog[open]` + `@keyframes`); JS değişikliği gerektirmez.

**Bottom sheet sürükleme:** `ui-kit.js` içine küçük bir `attachSheetDrag(dialog)` yardımcısı eklenir. Pointer olaylarını dinler, `el.style.transform` ile CSSOM üzerinden çalıştığı için CSP ile uyumludur ve yalnızca `(max-width:700px)` ile `pointer: coarse` koşullarında etkinleşir. Klavye kullanıcısı için `Esc` ve kapat butonu her zaman çalışır.

## 6. Fazlar ve görevler

Her fazın sonunda: `npm run check:syntax`, ilgili `qa-temp/*-smoke.mjs` testleri, `git diff --check` ve açık/koyu temada 1440 / 1024 / 390 px ekran görüntüsü karşılaştırması yapılır. Testler `npm run sandbox` verisiyle ve izole `TEMP` dizininde çalıştırılır (AGENTS.md §1).

### Faz 0 — Hazırlık ✅ (2026-11-21)
- [x] `feature/gui-motion` dalı açıldı.
- [x] Ekran görüntüsü aracı yazıldı: `scripts/gui-screenshots.mjs` (ayrıntılar aşağıda).
- [x] Başlangıç ekran görüntüleri alındı: 126 adet, sayfa hatası yok. Konum: `../er-sat-gui-shots/baseline/` (repo dışı, ~27 MB; galeri sayfası `index.html`).
- [x] Temel test koşusu yapıldı (sonuçlar aşağıda).
- [x] Katman envanteri çıkarıldı (aşağıda).

#### Faz 0 sonuçları

**Başlangıç testleri** (macOS, Node v24.21.0, izole `TEMP=../er-sat-test-temp`):

| Komut | Sonuç | Süre |
|---|---|---|
| `check:release` | ✅ çıkış 0 (204 dosya, 46 commit) | 6 sn |
| `check:syntax` | ✅ 165 JS dosyası | 3 sn |
| `npm test` | ✅ 705 test: 704 geçti, 0 başarısız, 1 atlandı (`10k receipt PDF performance budget`, öntanımlı SKIP) | 17 sn |
| `test:ui` | ✅ 33 smoke betiği ve 6 `node --test` grubu; 0 başarısız | 31 sn |
| `test:supplier-oracle` | ✅ 22/22 | 4 sn |
| `test:recovery` | ✅ 15/15 | 2 sn |

**Ekran görüntüsü aracı:** `node scripts/gui-screenshots.mjs <klasör> [--only=login,owner,users,checkout,reports]`
- Her çalıştırmada `npm run sandbox` ile aynı sentetik tohumu kurar; `data/` ve `.local/` klasörlerine dokunmaz.
- Görünmez modda Chrome (CDP) ile çalışır. 3 genişlik (1440 / 1024 / 390) × 2 tema (açık / koyu) üzerinden şu ekranları çeker: giriş, ana defterin 10 bölümü, Ctrl+K paleti, hızlı müşteri çekmecesi, `/users`, tezgâhın hızlı ve rehberli modu, tezgâh çekmecesi, raporların 4 sekmesi.
- Rapor sunucusu yalnızca HTTPS tailnet adresini kabul ettiği için tarayıcı hayali bir `*.ts.net` adresine yönlendirilir ve istekler CDP Fetch ile yerelde yanıtlanır. Ağa çıkılmaz ve sunucunun güvenlik kontrolleri gevşetilmez.
- Kıyaslamada gürültü yapmasın diye programatik odak çerçevesi çekimden önce kaldırılır.
- Faz 11'de aynı komut `../er-sat-gui-shots/after/` klasörüne çalıştırılır.

**Katman envanteri**

| Katman | Nerede | Tetikleyen |
|---|---|---|
| Çekmece `openDrawer` | `app.js:2568` | Hızlı müşteri kartı (İşlem Ekranı) |
| Çekmece `openDrawer` | `app.js:2649` | Yeni stok kartı (İşlem Ekranı) |
| Çekmece `openDrawer` | `checkout.js:1042` | Tezgâhta yeni müşteri kartı |
| Popover `openPopover` | `app.js:1173` | Defter olay ayrıntısı |
| Popover `openPopover` | `app.js:2524` | Müşteri bilgi butonu |
| Kritik onay `confirmCritical` | `users.js:16` | Çalışan erişimini kapatma (**tek kullanım**) |
| Yerel `confirm()` | `users.js:23` | `confirmCritical` yoksa yedek |
| Yerel `alert()` | `access-client.js:99` | `DefterUI.toast` yoksa yedek hata |
| Toast | `app.js:441,2152`, `checkout.js:847,934`, `users.js:33`, `access-client.js:98`, `command-palette.js` | Kayıt sonucu, hatalar |
| Kendi `<dialog>`'u | `command-palette.js:1097` | Ctrl+K paleti (ui-kit dışında, ayrıca uyarlanmalı) |
| İskelet `renderSkeleton` | `app.js:1412,1606` | Yükleme durumları |
| Sayfa içi onay panelleri | `app.js:3270` (`data-confirm-return`), `app.js:3558` (`data-confirm-reverse`) | İade / değişim ve kayıt ters çevirme |
| Rehberli adımlar (stepper) | `app.js:2060–2183`, `checkout.html:18` + `checkout.js:880–980` | İşlem Ekranı ve tezgâh 3 adımlı akış |
| `<details>` açılır bölümler | `app.js` 26, `suppliers.js` 14, `checkout` 3 | Filtreler, gelişmiş alanlar |

**Fazları etkileyen bulgular**
1. **Statik dosya listeleri:** Sunucu yalnızca listedeki dosyaları sunuyor. `motion.css` (ve varsa yeni JS dosyaları) `server.mjs:19` `staticFiles` haritasına, raporlar için `report-server.mjs` statik listesine eklenmeli. Bu, sunucu dosyasında tek satırlık ve davranış değiştirmeyen bir değişiklik; §2'deki "sunucu koduna dokunulmaz" kuralının **tek istisnası**. → Faz 1.
2. **Giriş sayfası `/` adresinde**, `/login` diye bir yol yok. → Faz 8.
3. **Global reduced-motion kuralı zaten var** (`styles.css:669`): `animation` ve `transition` için `none !important`. Yeni "Animasyonları azalt" anahtarı aynı kuralı `[data-motion="reduced"]` için de uygulayacak. → Faz 1.
4. **Kritik işlemler modal değil, sayfa içi panelle onaylanıyor** (iade/değişim ve ters çevirme). Bunları modala çevirmek akış ve test değişikliği demek. Faz 4'te bu paneller **görsel olarak** kritik onay diline geçirilecek: kırmızı şerit, beliriş animasyonu, onay butonu gecikmesi. DOM ve akış aynı kalacak. `confirmCritical` stili ise ileride kullanılacak modallar için hazırlanacak.
5. **Ctrl+K paleti ui-kit kullanmıyor**, kendi `<dialog>`'unu açıyor (`command-palette.js:1097`). Faz 2'de ayrıca ele alınacak. 29 test dosyası bu paleti kapsıyor (`test/paket6b-command-palette.test.mjs`).
6. **Katman testleri:** `test/ui-kit-2a…2d`, `paket4-unified-flow`, `r1-gates`, `paket2-acceptance`, `paket6b-*`. Faz 2 ve 3 değişikliklerinden sonra bu testler öncelikle koşulacak.
7. **Mevcut hareket çok az:** yalnızca sidebar genişlik geçişi, buton ve nav renk geçişleri (.15s), yükleme dönmesi ve iskelet nabzı var. Çakışma riski düşük.

### Faz 1 — Token ve hareket katmanı ✅ (2026-11-21)
- [x] `public/motion.css` oluşturuldu (§4) ve 5 sayfaya son stil dosyası olarak bağlandı.
- [x] `motion.css` ile `ui-prefs.js`, `server.mjs` `staticFiles` haritasına ve `report-server.mjs` statik listesine eklendi (Faz 0 bulgusu 1).
- [x] "Animasyonları azalt" altyapısı: `public/ui-prefs.js`. Her sayfada `<head>` içinde, stillerden önce ve eşzamanlı yüklenir; böylece ilk boyamadan önce `<html data-motion="reduced">` kurulur.
- [x] Reduced-motion: sistem ayarında token'lar 0'a iner (`styles.css:669` kuralı zaten animasyonları kapatıyor). `data-motion="reduced"` açıkken token'lar 0'a iner, ayrıca `animation` ve `transition` kapanır.
- [x] `@supports` yedekleri: `color-mix()` yoksa glow kapanır ve cam efekti opak `--surface` olur; `backdrop-filter` yoksa cam efekti opak olur.
- [x] Kabul ölçütleri: Görsel fark **sıfır** (aşağıda) ve tüm testler geçti.

#### Faz 1 sonuçları

**`window.DefterPrefs` API** (Faz 2 ve sonraki fazlar kullanacak):

| Fonksiyon | Açıklama |
|---|---|
| `getMotion()` | `'full' \| 'reduced'` (uygulama anahtarı) |
| `setMotion(mode)` | Kaydeder ve `<html data-motion>` niteliğini günceller |
| `motionReduced()` | Uygulama anahtarı **veya** sistem ayarı açıksa `true`. JS ile yapılan hareketler (hayalet çıkış, bottom sheet) buna bakar. |
| `getSound()` / `setSound(bool)` | Satış sesi tercihi; varsayılan açık (Faz 9) |
| `onChange(fn)` | Tercih değişimini dinler; geri dönen fonksiyon dinlemeyi kaldırır. Başka sekmedeki değişikliği de (`storage` olayı) yakalar. |

- `localStorage` anahtarları `defter-motion` ve `defter-sound`; erişim engelliyse varsayılanlar geçerli olur ve hata fırlatılmaz.
- Rapor portalı ayrı bir adreste çalıştığı için tercihleri kendi tarayıcı deposunda tutar; sistem ayarına uyar.

**Yeni test:** `test/gui-motion.test.mjs` (8 test). Kapsadıkları:
- `motion.css` içinde hex, `rgb()`/`hsl()` veya isimli renk **olmadığını** ve her `color-mix()`'in yalnızca `var(--palet-tokeni)` ile `transparent` karıştırdığını denetler. "Renklere dokunma" kuralının otomatik bekçisidir.
- Token'ların ve reduced-motion kurallarının varlığını, 5 sayfada yükleme sırasını (ui-prefs → CSS → motion.css son), satır içi script ve stil olmadığını, iki sunucunun da dosyaları sunduğunu denetler.
- `DefterPrefs` için varsayılanları, açma/kapamayı, sistem ayarının önceliğini ve engellenmiş depolamayı test eder.

**Testler (Faz 1 sonrası):** `check:syntax` 168 dosya ✅ · `npm test` 713 test: 712 geçti, 0 başarısız, 1 atlandı (öntanımlı) ✅ · `test:ui` 0 başarısız ✅ · `test:supplier-oracle` 22/22 ✅ · `test:recovery` 15/15 ✅

**Görsel karşılaştırma** (`../er-sat-gui-shots/faz1/` ile `baseline/`): 126 görüntünün 111'i bayt bayt aynı. Farklı çıkan 15 görüntü, aynı kodla alınan iki çekim (`faz1/` ve `faz1-tekrar/`) arasında da aynı dosyalarda, çoğunda aynı piksel sayısıyla değişiyor. Yani fark Faz 1'den değil, bilinen gürültüden geliyor:
- `owner-journal--*`: kayıt saatinin dakika hanesi (6–15 px genişliğinde dikey şerit), sentetik veri her çalıştırmada yeni saatle oluşuyor.
- `checkout-guided--*`, `owner-overlay-palette--tablet-light`, `owner-stocks--phone-light`, `owner-suppliers--desktop-dark`, `owner-accounts--tablet-light`, `owner-backup--phone-*`: 8–600 px arası dağınık kenar yumuşatma (antialias) farkı.
Sonraki fazlarda bu dosyalardaki küçük farklar gürültü sayılacak.

**Satır sonu notu:** Depo `* -text` ile baytları olduğu gibi korur ve bazı dosyalar CRLF kullanır (`index.html`, `server.mjs` vb.). Düzenlemelerde dosyanın mevcut satır sonu korunmalı.

### Faz 2 — Katman altyapısı: modal, çekmece, popover, toast ✅ (2026-11-21)
- [x] `.defter-dialog`: cam zemin (%90 yüzey + 16px blur), bulanık backdrop (4px), modalda yaylı ölçek açılışı (0.96 → 1, 220 ms).
- [x] `.defter-drawer`: sağdan kayarak açılış (250 ms), cam zemin. Başlık mevcut yapıda zaten sabit.
- [x] `.defter-popover` ve combobox listesi: flyout girişi. Yukarı açılan (dropup) listeler alttan yükselir.
- [x] Toast: **sağ altta**, sağdan kayarak giriş (telefonda alttan), hayalet ile çıkış, altın süre çubuğu (üzerine gelince durur), biri kapanınca diğerleri kayarak yer değiştirir (FLIP). Zemin %96 opak.
- [x] `ui-kit.js`: hayalet çıkış (§5, gölge DOM) ve tek blur kuralı (`aria-hidden` olan alt katmanın blur'u kapanır).
- [x] Komut paleti: aynı modal hareketi (üstten), hayalet çıkış (bulanıksız "düz" perde, çünkü paletin backdrop'u bulanık değil). "Kayan seçim vurgusu" yerine seçim vurgusuna 150 ms renk geçişi eklendi (sanal liste DOM'una dokunmamak için).
- [x] Kabul ölçütleri: Odak tuzağı, `Esc`, geri tuşu ve odak dönüşü değişmedi. `paket6b` E2E sonuçları orijinal kodla birebir aynı. Açılışlar ≤ 250 ms.

#### Faz 2 sonuçları

**Değişen / eklenen dosyalar**

| Dosya | Değişiklik |
|---|---|
| `public/motion.css` | Faz 2 bölümü: cam yüzeyler, `@keyframes`, hayalet stilleri, toast konumu/çubuğu, combobox flyout, liste vurgu geçişi. Yeni token'lar: `--glass-bg-solid`, `--glass-head`, `--backdrop-tint-plain`. `--dur-slow` 320 → 250 ms. |
| `public/ui-kit.js` | `animateExit()` (gölge DOM'lu hayalet, dışa açık: `DefterUI.animateExit`), `glideSiblings()` (FLIP), ghost stil ön hazırlığı, toast süre çubuğu ve duraklatma. `close()`, `closePopover()`, toast `dismiss()` eşzamanlı sözleşmesini korur. |
| `public/command-palette.js` | `close()` içinde `animateExit` çağrısı (yalnızca görsel). |
| `test-support/gui-browser.mjs` | **Yeni.** Ortak gerçek tarayıcı aracı: sentetik defter, sunucular, görünmez modda Chrome (CDP), giriş, tema ve rapor vekili. |
| `scripts/gui-screenshots.mjs` | Ortak aracı kullanacak şekilde sadeleştirildi. |
| `qa-temp/gui-layer-motion-smoke.mjs` | **Yeni.** Gerçek Chrome'da 7 senaryo (`npm run test:gui-browser`). |
| `qa-temp/paket6b-cdp-harness.mjs` | `clickSelector` tıklamadan önce hedefin veya üst öğelerinin çalışan animasyonlarını bekliyor (en fazla 1 sn). Gerekçe aşağıda. |
| `package.json` | `test:gui-browser` komutu. |

**`npm run test:gui-browser` neyi doğrular** (8/8 ✅):
- Çekmece: `defter-drawer-in` 250 ms, backdrop fade, cam zemin (`/ 0.9`, `blur(16px)`), açılış sürerken odağın ilk alanda olması. Kapanınca eşzamanlı olarak: `dialog[open]` = 0, DOM'da dialog = 0, odak tetikleyiciye döner, katman sayısı 0. Hayalet stilli ve animasyonda; `.defter-drawer`, `#f-name`, `[name=name]` gibi hiçbir şeyi document aramalarında görünmez. 450 ms sonra temizlenir.
- Modal: `defter-modal-in` ve yay eğrisi. İç içe katmanda alttaki katmanın blur'u ve backdrop blur'u `none`. Üstteki kapanınca ekstra perde oluşmaz.
- Palet: üstten ölçek, düz perde, `[data-command-palette-input]` sızıntısı yok. Hayalet sönerken yeniden açılınca tek ve odaklı giriş kutusu bulunur (paket6b T1-F4-5 regresyonu).
- Popover: flyout girişi, hayaletle çıkış.
- Toast: sağ alt 24/24 px, `defter-toast-time` 5000 ms, çubuk metin eklemiyor, alttaki kapanınca üstteki kayıyor.
- "Animasyonları azalt": modal ve toast'ta animasyon 0, hayalet 0, süre çubuğu gizli.
- Telefon (390 px): toast bölgesi 12/12/12 px, alttan yükselme.
- Sayfa hatası yok.

**Başlangıçla (orijinal kod) karşılaştırma — Mac, aynı makine**

| Kontrol | Orijinal kod | Faz 2 |
|---|---|---|
| `npm test` | 712 ✅ / 1 atlandı | 712 ✅ / 1 atlandı (713 test; +8 Faz 1) |
| `test:ui`, `test:supplier-oracle`, `test:recovery`, `check:release` | ✅ | ✅ |
| `paket6b-e2e-browser.mjs` | 60 geçti / 22 başarısız | **60 / 22, aynı test listesi** |
| `paket6b-efficiency-benchmark.mjs` | 15/16 (T02 başarısız) | 15/16 (aynı T02) |
| Palet açılışı (T06, medyan) | 32,9 ms | 32,8 ms |
| Kapanış maliyeti (`close()`) | — | ilk 8 ms, sonra ~5–6 ms; animasyon azaltılmışsa 1,6 ms |

- **paket6b'deki 22 başarısızlık Faz 2'den önce de vardı (Mac'e özgü).** Çoğu Türkçe karakter yazımında combobox zaman aşımı ("ÇEYREK", "AĞRI HAS ALTIN"). Harness Windows için yazılmış (`CHROMIUM_PATH` ile Mac Chrome'u verildi). Windows'ta ayrıca doğrulanmalı.
- **T02 (tekrarlanan arama, hedef medyan ≤ 20 ms):** iki koşuda da ~33 ms ≈ 2 ekran karesi. Mac'te headless kare zamanlamasından kaynaklanıyor, Faz 2 ile ilgisi yok.
- **`T2-F2-5` (`#summary-search` "igdir") — Mac'te test aracından kaynaklı yanlış sonuç (Faz 3'te çözümlendi):** Harness kutuyu `Ctrl+A` + `Backspace` ile temizliyor, ama macOS'te Chrome'da `Ctrl+A` seçim yapmaz (orada `Cmd+A`). Bu yüzden **her iki kodda da** kutuya "gumuigdir", sonra "gumuigdiistanbul" yazılıyor (hata ayıklama çıktısıyla doğrulandı). Orijinal kod, test sonuç tablosunu süzgeç uygulanmadan önce okuduğu için (50 satırın tamamı) şans eseri geçiyor. Yeni kodda süzgeç daha önce uygulanıyor ve çöp sorgu "sonuç yok" gösteriyor. Arama davranışı değişmedi. Windows'ta `Ctrl+A` çalıştığı için sorun orada beklenmez. Mac'teki 22 eski başarısızlığın bir kısmı da muhtemelen aynı temizleme sorunundan kaynaklanıyor; harness'te `process.platform === 'darwin'` için `Meta` kullanılması ayrı bir iş olarak önerilir.
- **`clickSelector` değişikliği:** `T1-F6-4` (tezgâh müşteri çekmecesi), çekmece açılır açılmaz butonun koordinatını ölçüp tıklıyordu. Çekmece 250 ms kayarken koordinat değiştiği için tıklama boşa düşüyordu (deterministik, 2/2). Gerçek kullanıcı bu sürede tıklayamaz; harness artık hedefin üzerindeki animasyon bitince ölçüyor. Animasyon yoksa davranışı aynı. Sonra 3/3 geçti.

**Görsel karşılaştırma** (`../er-sat-gui-shots/faz2/`): 126 görüntüden yalnızca açılır katman görüntüleri (palet ×6, müşteri çekmecesi ×6, tezgâh çekmecesi ×6) değişti. Diğer farklar Faz 1'de belgelenen bilinen gürültü. Toast yakın çekimleri: `faz2/toasts-light.png`, `faz2/toasts-dark.png`.

### Faz 3 — Mobil bottom sheet ✅ (2026-11-21)
- [x] ≤700px genişlikte `.defter-drawer` alttan açılan sayfaya dönüşür: tam genişlik, yalnızca alt kenara sabit, içeriğe göre yükseklik (en fazla `92dvh`), 20px yuvarlak üst köşeler (`--radius-sheet`), başlıkta tutamaç çizgisi (`::before`, DOM'a öğe eklenmez), alttan kayarak açılış (`defter-sheet-in`, 250 ms).
- [x] `attachSheetDrag` (`ui-kit.js`): başlık sürüklenince sayfa parmağı izler. Bırakınca yüksekliğin %30'u geçildiyse **veya** son 100 ms'deki aşağı hız > 0,5 px/ms ise kapanır; kapanma nedeni `'swipe'`, hayalet parmağın bıraktığı yerden aşağı kayar. Aksi halde yayla geri döner.
- [x] Güvenli alan: gövdenin alt boşluğu `16px + env(safe-area-inset-bottom)`.
- [x] Kabul ölçütleri: sürükleyerek kapatma çalışıyor. İçerik kaydırması sürüklemeyle çakışmıyor.

#### Faz 3 sonuçları ve kararlar
- **Sürükleme yalnızca başlıktan (tutamaç + başlık alanı) başlar.** Plandaki "içerik en üstteyken de başlasın" seçeneği uygulanmadı. Tarayıcı içerik üzerindeki dokunmayı kaydırma olarak sahiplenip `pointercancel` gönderdiği için bu, formlarda yanlışlıkla kapanma ve kaydırma çakışması riski taşıyordu. Başlıkta `touch-action: none` var; içerik normal kaydırılır.
- **Butonlar, bağlantılar ve form alanları** sürüklemeyi başlatmaz (kapat butonu her zaman tıklanır). `Esc` ve kapat butonu aynen çalışır.
- **Etkinlik koşulu genişliktir (≤700px), işaretçi türü değildir.** Dar pencerede fare ile de sürüklenebilir; masaüstü genişliğinde çekmece yan panel olarak kalır ve sürükleme yok sayılır.
- **Animasyonlar azaltılmışsa** sürükleme yine çalışır (doğrudan dokunma). Yaylanma ve kapanış animasyonu oynatılmaz.
- **Ölçüm hatası ve düzeltmesi:** İlk sürümde sayfa `margin-top: auto` ile alta itiliyordu. Tarayıcının dialog için verdiği `inset-block: 0` yüzünden `height: auto` içeriğe göre değil ekranı dolduracak şekilde esnedi (tezgâh müşteri formunda altta boş alan). `inset: auto 0 0 0` ile düzeltildi; kısa içerikli sayfa testi eklendi.
- Çekmeceyi kullanan kodlar kapanma nedenine bakmıyor (tek `onClose` `checkout.js:1047`, nedenden bağımsız). Yeni `'swipe'` nedeni davranış değiştirmez.

**Testler (Faz 3 sonrası):** `check:release` ✅ · `check:syntax` ✅ · `npm test` 712/713 (1 öntanımlı atlama) ✅ · `test:ui` ✅ · `test:supplier-oracle` 22/22 ✅ · `test:recovery` 15/15 ✅ · `test:gui-browser` 18/18 ✅ · `gui-motion` 8/8 ✅ · `paket6b-e2e` orijinal kodla aynı liste (60/22). Tek istisna yukarıda açıklanan `T2-F2-5` yarışı (son koşuda 59/23).

**Yeni test:** `qa-temp/gui-sheet-smoke.mjs` gerçek CDP dokunma olaylarıyla 9 senaryo içeriyor (`npm run test:gui-browser` içinde; 3 ardışık koşuda kararlı):
- Telefon genişliğinde alt kenara sıfır boşluk, tam genişlik, 20px üst köşe, düz alt köşe, `touch-action: none`, tutamaç.
- Kısa içerik içeriğe göre boyutlanır (< 260px).
- Yavaş 50px çekiş parmağı izler (`translateY(50px)`), bırakınca açık kalır ve yayla döner.
- %45 çekiş kapatır; odak tetikleyiciye döner; hayalet, dinlenme konumundan aşağıda başlar.
- Hızlı 60px fırlatma kapatır.
- İçerikten sürükleme sayfayı oynatmaz.
- `Esc` ve kapat butonu çalışır.
- Masaüstü genişliğinde yan panel kalır, sürükleme yok sayılır.
- Animasyon azaltılmışken sürükleme çalışır; açılış animasyonu, yaylanma ve hayalet yoktur.

### Faz 4 — Kritik onay pencereleri ✅ (2026-11-21)
- [x] `confirmCritical`: üstte 4px şerit (`danger` için `--red`, `danger:false` için `--gold`), başlıkta SVG uyarı ikonu (`aria-hidden`; başlık metni ve `aria-labelledby` değişmez), etki metni kutusu. Onay butonu 300 ms "kurulma" süresinden sonra kullanıcı girdisini kabul ediyor (ayrıntı aşağıda).
- [x] Gerekçe alanı boşsa sarsıntı: tarayıcının kendi zorunlu alan doğrulaması (`required`) korunuyor ve `invalid` olayında pencere sarsılıyor. Yalnızca boşluktan oluşan gerekçede mevcut `showFieldError('Gerekçe yazın.')` ile birlikte sarsılıyor.
- [x] `users.js` `confirm()` / `access-client.js` `alert()`: **değiştirilmedi, bilinçli karar.** İkisi de zaten önce `confirmCritical` ve toast kullanıyor; yerel kutular yalnızca `ui-kit.js` yüklenemezse devreye giren yedekler. `users.html` ve diğer sayfalar `ui-kit.js`'i yüklüyor; `login.html`'de indirme bağlantısı yok. Yedeği kaldırmak, `ui-kit` yüklenemediğinde çalışan erişiminin **onaysız** kapanması demek olurdu.
- [x] Sayfa içi onay panelleri (`data-return-review`, `data-reverse-review`): beliriş animasyonu, ters kayıtta hafif kırmızı zemin ve onay butonunda aynı kurulma koruması (`app.js`'te 2 satır: `uiKit?.guardConfirm?.(…)`). DOM ve akış değişmedi. Sonuca göre renkli çerçeve zaten mevcut tasarımda var (`styles.css:772-773`, `#journal-list` kimlik seçicili 2px çerçeve; ters kayıtta kırmızı). Planlanan sol şerit bu kuralla çakıştığı için eklenmedi.
- [x] Kabul ölçütleri: iade, ters çevirme ve çalışan kaldırma akışları aynı sonucu üretiyor (JSDOM smoke testleri + gerçek tarayıcıda ters kayıt akışı). Onay anahtarları ve `revision` koruması değişmedi.

#### Faz 4 sonuçları ve kararlar

**Kurulma koruması (`DefterUI.guardConfirm`) neden "300 ms gecikme" yerine böyle:**
- Yalnızca **kullanıcı girdisi** (`event.isTrusted`: fare, dokunma, klavye) ilk 300 ms içinde yok sayılır. Programla yapılan `.click()` / `requestSubmit()` hiç geciktirilmez. Mevcut JSDOM testleri (`ui-kit-2d`, `ui-returns-smoke`, `ui-d07-smoke`, `ui-workbench-smoke`) onay butonuna ~10 ms içinde programla tıklıyor; onlar ve uygulamanın programla yaptığı gönderimler etkilenmez.
- Klavye de korunur: sayfa içi panel açılınca odak doğrudan onay butonuna gidiyor (mevcut davranış). Basılı tutulan veya tekrarlanan Enter, ilk 300 ms'de işlemi kaydedemez. `confirmCritical`'da ilk odak zaten "Vazgeç"te.
- Bekleme süresince buton `is-arming` (soluk) ve `aria-disabled="true"`. Koruma bir güvenlik kuralı olduğu için "Animasyonları azalt" açıkken de geçerli; sarsılma ise o durumda oynamaz.

**Değişen / eklenen dosyalar:** `public/ui-kit.js` (`guardConfirm`, `shake`, kritik ikon ve sınıflar, `invalid` sarsılması), `public/app.js` (2 satır, CRLF korundu), `public/motion.css` (Faz 4 bölümü), `qa-temp/gui-confirm-smoke.mjs` (**yeni**, `npm run test:gui-browser` içinde).

**`qa-temp/gui-confirm-smoke.mjs`** (gerçek Chrome, güvenilir CDP fare/klavye olayları; 9/9 ✅):
- Kırmızı şerit, ikon, etki kutusu. Başlık metni ve `aria-labelledby` aynı. İlk odak "Vazgeç".
- 300 ms içindeki gerçek tıklama yok sayılıyor; sonraki tıklama onaylıyor.
- İki kez Enter erken onaylayamıyor; 300 ms sonra Enter onaylıyor.
- Programla yapılan tıklama hemen onaylıyor.
- Boş gerekçe: tarayıcı doğrulaması ve sarsılma. Boşluk gerekçe: alan hatası ve sarsılma. Animasyon azaltılmışken sarsılma yok, koruma var.
- `danger:false`: altın şerit.
- Panel animasyonu ve ters kayıt zemini.
- **Gerçek Günlük İşlemler ters kayıt akışı:** form gönderiliyor; mevcut kırmızı çerçeve korunuyor; odak onay butonunda; kurulma süresindeki gerçek tıklama `/api/command` göndermiyor, sonraki tıklama tam 1 komut gönderiyor.

**Testler (Faz 4 sonrası):** `check:release` ✅ · `check:syntax` ✅ · `npm test` 712/713 (1 öntanımlı atlama) ✅ · `test:ui` ✅ · `test:supplier-oracle` 22/22 ✅ · `test:recovery` 15/15 ✅ · `test:gui-browser` 27/27 ✅ · `paket6b-e2e` orijinal kodla birebir aynı liste (60/22).
**Şeffaflık notu:** Son CSS düzeltmesinden sonraki ilk `test:gui-browser` koşusunda `gui-sheet-smoke` hiçbir alt teste başlamadan, ilk sayfa yüklemesinde (`OWNER_READY`, 15 sn) zaman aşımına uğradı (17/18). Hemen ardından iki ardışık koşu 27/27 geçti. Ortam kaynaklı tek seferlik takılma olarak değerlendirildi. **Faz 7'de kök neden bulundu ve düzeltildi** (test aracı yarışı; ayrıntı Faz 7 sonuçlarında).

**Not:** `qa-temp/customer-return-browser.mjs` dışarıdan çağrılan bir fonksiyon; boş bir defter bekliyor. Sentetik UAT defteriyle hem orijinal hem yeni kodda aynı yerde (`#return-form-credit-sale` bulunamıyor) duruyor; Faz 4 ile ilgisi yok.

### Faz 5 — Çok adımlı sihirbaz ✅ (2026-11-21)
- [x] İşlem Ekranı (`app.js`) ve tezgâh (`checkout.js`) 3 adımlı akışı:
  - Sekmelerin üstünde ince altın ilerleme çizgisi (`scaleX`, 250 ms).
  - "Adım 2 / 3" etiketi.
  - Adım içeriği ileri/geri yönüne göre ±16px kayarak geliyor.
  - Sekme renk geçişleri yumuşak.
- [x] İlk kurulum (`/` adresi, setup modu) iki adımlı: 1) işletme sahibinin adı, 2) parola. "Adım n / 2" ve ilerleme çizgisi var; 2. adımda "Geri" butonu ve 15 karakter göstergesi. Form, alanlar ve `/api/auth/setup` çağrısı aynı.
- [x] Kabul ölçütleri: `ui-simplified-transactions-smoke`, `ui-drafts-smoke`, `ui-workbench-smoke`, `ui-checkout-trade-smoke`, `paket4-unified-flow`, `draft-lifecycle` geçti; taslak deposu adım değişiminde bozulmadı.

#### Faz 5 sonuçları ve kararlar
- **Adım mantığına dokunulmadı.** `DefterUI.enhanceStepper(bar, scope)` yalnızca dekorasyon. Sekmelerdeki `is-active` değişimini `MutationObserver` ile izliyor; `setStep` / `setCheckoutStep`, doğrulama (`validateStep`) ve taslak kaydı aynen çalışıyor. `app.js` ve `checkout.js`'e birer satır eklendi (CRLF korundu).
- **Eklenen satır (`.stepper-meta`) `aria-hidden`.** Adım bilgisi zaten `aria-current="step"` ile duyuruluyor. Satır, adım çubuğunun ilk öğesi; hızlı modda çubukla birlikte gizleniyor.
- **"Kayan aktif sekme göstergesi" ayrıca yapılmadı.** Aktif sekmenin mevcut görünümü (altın kenar ve gölge) korunup yumuşak renk geçişi verildi. İlerleme çizgisi adımdan adıma kayarak doluyor; ikinci bir kayan şekil görsel tekrar olurdu.
- **İçerik kayması 16px (plandaki 24px yerine).** Sayfa kenar boşluğu en az 22px olduğu için 16px kayma telefonda yatay kaydırma çubuğu oluşturmuyor.
- **Kurulum sihirbazının ayrıntıları:**
  - 1. adımda parola alanı gizli ama `required`. Ad alanında Enter'a basılınca tarayıcı gizli boş alan yüzünden gönderimi reddedeceği için Enter doğrudan yakalanıp 2. adıma geçiliyor.
  - **Parola zaten doluysa** (şifre yöneticisi, otomasyon) 1. adımdaki Enter veya gönderim, sihirbaz öncesindeki gibi doğrudan gönderiyor.
  - 2. adımda parolaya `minlength=15` ve `aria-describedby="password-count"` ekleniyor. Sunucudaki 15 karakter kuralı değişmedi; bu yalnızca erken uyarı.
  - Normal oturum açmada (setup değil) sihirbaz hiç kurulmuyor; `minlength` ve ek öğe yok.
- **Test aracı:** `startGuiSession({ empty: true })` hiç kullanıcısı olmayan boş kurulum açar (ilk kurulum ekranları için).

**Testler (Faz 5 sonrası):** `check:release` ✅ · `check:syntax` ✅ · `npm test` 712/713 (1 öntanımlı atlama) ✅ · `test:ui` ✅ · `test:supplier-oracle` 22/22 ✅ · `test:recovery` 15/15 ✅ · `test:gui-browser` 44/44 ✅ · `paket6b-e2e` orijinal kodla birebir aynı liste (60/22).

**Yeni test:** `qa-temp/gui-steps-smoke.mjs` (17 senaryo, `npm run test:gui-browser` içinde):
- İşlem Ekranı: "Adım 1 / 3", ilerleme 0.333, `aria-hidden`; boş ürünle ileri gidilemiyor (doğrulama aynı); ileri `translateX(16px)` ve 0.667; geri `translateX(-16px)`.
- Animasyon azaltılmışken sayaç güncelleniyor, kayma yok. Hızlı modda çubuk gizli.
- Tezgâh: aynı sayaç.
- Normal giriş değişmedi.
- Kurulum: 1. adımda yalnızca ad; boş adla "Devam et" ilerlemiyor; Enter 2. adıma geçip parolaya odaklanıyor (ileri kayma). Gösterge "4 / 15 karakter" → "23 karakter · yeterli". "Geri" adı koruyor (geri kayma). Dolu parola 1. adımdan doğrudan gönderiyor. 2. adım tamamlanınca **gerçek** `/api/auth/setup` ile sahip hesabı oluşuyor ve `/owner` açılıyor.

### Faz 6 — Mikro-etkileşimler ve ana defter ✅ (2026-11-21)
- [x] Butonlar: tüm butonlarda basınca 0.97 ölçek. Birincil (altın) butonlarda (`.button` + `secondary/text/danger` olmayanlar) fare üzerine gelince 2px kalkış ve altın glow. Bekleme süresindeki onay butonu (`is-arming`) tepki vermez.
- [x] Tıklanabilir kartlar: Günün Görünümü hızlı işlem kutuları (`.quick-action`) ve sayım modu butonları (`button.count-mode`) 2px kalkış + glow, basınca 0.99.
- [x] Sol menü: aktif öğenin arkasında kayan tek gösterge (yaylı, 220 ms), ikonun fare üzerindeyken 2px kayması. Daraltma geçişinde gösterge `ResizeObserver` ile yeni konuma atlar.
- [x] Sekmeler, ödeme çipleri ve tablo satırları: renk geçişleri yumuşatıldı (150 ms).
- [x] Görünüm geçişi: bölüm değişince `#main` 10px yükselerek ve solarak 200 ms'de gelir. Aynı bölüm yeniden çizildiğinde (Yenile, kayıt sonrası) oynatılmaz.
- [x] Odak halesi: mevcut 3px `outline` korunur; butonlarda ve form alanlarında `--glow-focus` eklenir.
- [x] Kabul ölçütleri: 10 bölümün görüntüleri karşılaştırıldı; rakam hizası (`tabular-nums`) değişmedi.

#### Faz 6 sonuçları ve kararlar
- **Hesap/stok/banka kartları kalkmıyor.** Bu kartlar bütün olarak tıklanabilir değil, yalnızca içlerindeki isim butonu tıklanıyor. Kartın kalkması "tıklanır" izlenimi verip kullanıcıyı yanıltırdı. Plandaki "Bilgi kartları sabit kalır" ilkesi bu kartlara uygulandı.
- **Aktif menü öğesinin görünümü değişmedi.** Gösterge, `styles.css` "Refined premium" bloğundaki (`@media screen`) gerçek aktif stili birebir kopyalıyor: `--sidebar-hover` zemin, `--sidebar-line` kenar, solda 3px altın. İlk sürüm eski parlak altın stili kullanıyordu ve açık yazı okunmaz olurdu; tarayıcı testi bunu yakaladı ve düzeltildi. Önce/sonra yakın çekimi: `../er-sat-gui-shots/faz6/nav-compare.png`.
- **Gösterge yalnızca masaüstü kenar çubuğunda (≥901px).** Telefondaki yatay menü şeridi kendi aktif stilini koruyor.
- **"Kayan hap" yerine renk geçişi:** İşlem sekmelerinin ve iş tezgâhı sekmelerinin aktif stilleri ekran genişliğine göre farklı (`styles.css` 204, 397). Kayan ayrı bir şekil her genişlik için ayrı yeniden yazım gerektirirdi; yumuşak renk geçişi verildi.
- **Görünüm geçişi yalnızca bölüm gerçekten değişince** (`app.js` `setView`, `prevView !== view`) oynatılıyor. Sayılar sayılmıyor ve yeniden dizilmiyor (yalnızca opaklık ve transform). Odak ve giriş beklemiyor.
- `app.js`'e 2 satır eklendi (CRLF korundu): `uiKit?.animateEnter?.($('#main'))` ve `uiKit?.enhanceNav?.($('#navigation'))`.

**Görsel karşılaştırma** (`../er-sat-gui-shots/faz6/` ile `baseline/`): masaüstünde 10 bölümün her birinde değişen tek alan aktif menü öğesinin kutusu (~234×44 px, gösterge katmanı). Günlük İşlemler ekranında buna ek olarak bilinen saat gürültüsü var. Telefon görüntüleri baştakiyle **piksel piksel aynı** (Yedek ekranındaki bilinen 39 px gürültü hariç). Etkileşimlerin hepsi fare üzerine gelme, basma veya geçiş anında; durağan ekranı değiştirmiyor.

**Testler (Faz 6 sonrası):** `check:release` ✅ · `check:syntax` ✅ · `npm test` 712/713 (1 öntanımlı atlama) ✅ · `test:ui` ✅ · `test:supplier-oracle` 22/22 ✅ · `test:recovery` 15/15 ✅ · `test:gui-browser` 53/53 ✅ · `paket6b-e2e` orijinal kodla birebir aynı liste (60/22) · `paket6b-efficiency-benchmark` 15/16 (orijinaldeki aynı T02).

**Performans (orijinal → Faz 6, medyan):**

| Ölçüm | Orijinal | Faz 6 |
|---|---|---|
| Palet açılışı | 32,9 ms | 32,7 ms |
| Combobox sonuç | 32,8 ms | 32,3 ms |
| Klavye | 15,9 ms | 15,8 ms |
| Satış görünümü hazır (T12) | 66,4 ms | 82,9 ms |
| Günlük görünümü hazır (T13) | 67,4 ms | 83,3 ms |
| Günlük arama (T05) | 66,4 ms | 81,9 ms |

Görünüm ölçümleri tam olarak bir ekran karesi (~16 ms) uzadı. Hepsi hedeflerin çok altında ve geçiyor. T13 artışı Faz 2'den beri vardı; T12 Faz 6'da eklendi. Muhtemel neden, görünüm girişinde `#main` için oluşturulan geçici birleştirme katmanının ölçümün beklediği çift `requestAnimationFrame`'i bir kare kaydırması. Kullanıcı açısından içerik ve giriş beklemiyor. "Animasyonları azalt" açıkken bu katman oluşturulmuyor.

**Yeni test:** `qa-temp/gui-micro-smoke.mjs` (gerçek fare olaylarıyla 8 senaryo, `npm run test:gui-browser` içinde; 2 ardışık koşuda kararlı):
- Gösterge aktif öğenin tam arkasında ve mevcut aktif görünümde.
- Bölüm değişince gösterge kayıyor ve `#main` geliyor; Yenile'de geliş animasyonu yok.
- Altın buton üzerine gelince `translateY(-2px)` ve glow, basınca 0.97; ikincil buton kalkmıyor.
- Hızlı işlem kutusu kalkıyor.
- Hesap kartı kalkmıyor.
- Odakta outline ve hale birlikte.
- Animasyonlar azaltılmışken kalkış, giriş animasyonu ve gösterge animasyonu yok.
- Daraltılmış kenar çubuğunda gösterge doğru yerde; telefonda gösterge gizli, menü şeridi kendi stilinde.

### Faz 7 — Üst bar, tema butonu ve ayarlar ✅ (2026-11-21)
**Kapsam değişikliği (kullanıcı kararı, 2026-11-21):** "Animasyonları azalt" ve "Ses" anahtarları Gece modu butonunun yanına konmayacak. Bunun yerine üst barın en sağına bir **Ayarlar** (dişli/kaydırıcı) butonu gelecek; açılır pencerede tüm tercihler toplanacak. Gece modu için üstte ayrıca yalnızca **ay / güneş** simgesi gösteren bir buton kalacak.

- [x] `.topbar` ≥901px'te yapışkan; sayfa kaydırılınca cam görünüme geçiyor (`.is-scrolled`; `scroll` dinleyicisi `passive`). Yüksekliği `--topbar-h` olarak yayımlanıyor; canlı işlem özeti, günlük detay paneli ve `scroll-padding-top` bu değerin altında kalıyor. Telefonda (≤900px) yapışkan değil, ekran alanı korunuyor.
- [x] Tema butonu (`#theme-toggle`) yalnızca simge: açıkta ay, koyuda güneş (SVG maske), geçişte 180° döner. Metin (`Gece modu` / `Gündüz modu`) ve `aria-label` erişilebilirlik için korunuyor (`font-size: 0`); `title` = "Gece / gündüz modu". Mevcut `applyTheme` / `applySharedTheme` mantığına dokunulmadı.
- [x] Ayarlar butonu (`#settings-trigger`, `[data-settings-trigger]`): ana defterde Yenile'nin sağında, tezgâhta "Oturumu kapat"ın sağında; en sağdaki kontrol. Açıkken ikon 90° döner.
- [x] Ayarlar penceresi (`DefterUI.openSettings`, popover tabanlı: cam, flyout, `Esc` / dışarı tıklama ile kapanır, odak geri döner). Satırlar (`role="switch"` anahtarlar, açıkken altın):
  - **Gece modu:** sayfanın kendi `#theme-toggle` butonunu tetikler; tek doğruluk kaynağı.
  - **Animasyonları azalt:** `DefterPrefs.setMotion`. Sistem ayarı da hareketi azaltıyorsa bunu açıklayan not gösterilir.
  - **Onay sesi:** `DefterPrefs.setSound` ve "Sesi dinle" önizlemesi (`DefterUI.playChime`, Web Audio, 2 nota, ~250 ms). Satış ve alışa bağlanması Faz 9'da yapılacak.
  - **Üst barı sabit tut** *(sonradan eklendi, kullanıcı isteği)*: `DefterPrefs.getTopbarSticky / setTopbarSticky`, anahtar `defter-topbar` (`sticky` varsayılan / `static`). Kapalıyken `ui-prefs.js` ilk boyamadan önce `<html data-topbar="static">` koyar; `motion.css`'teki yapışkanlık, cam, `scroll-padding-top` ve alt panel kaydırma kuralları `:root:not([data-topbar="static"])` ile tamamen devre dışı kalır. Satır yalnızca üst barı olan sayfada ve ≥901px genişlikte görünür (telefonda bar zaten sabit değil).
  - **Kenar menüsünü daralt:** yalnızca masaüstünde, mevcut `#sidebar-collapse` butonunu tetikler; tercih zaten `defter-sidebar-collapsed` ile saklanıyor.
  - Not: "Bu ayarlar yalnızca bu bilgisayarda ve bu tarayıcıda saklanır."
- [x] Mikro-etkileşimler: üst bar butonları Faz 6'dan geliyor (basma, odak halesi).

#### Faz 7 sonuçları ve kararlar
- **Ayarlara alınmayanlar:**
  - **Çalışma alanı seçimi** (Örnek / Dükkân defteri) üst barda kaldı. Bu bir görünüm tercihi değil, hangi deftere yazıldığını belirleyen kritik bir seçim; her an görünür olmalı.
  - **"Komutlar"** bir eylem, ayar değil.
- Uygulamadaki tüm kalıcı görünüm tercihleri (`defter-theme`, `defter-sidebar-collapsed`, `defter-motion`, `defter-sound`, `defter-topbar`) artık tek pencerede. `defter-workspace` bilinçli olarak dışarıda.
- **Telefon düzeni (≤600px):** üst bar ızgarası `'date date workspace workspace' / 'palette ×4' / 'refresh refresh theme settings'` olarak genişletildi. `styles.css`'teki mevcut `#theme-toggle` grid kuralı (M2-F17 testi) aynen duruyor.
- **Ortak açılır menü düzeltmesi (`openPopover`):**
  - Genişlik artık `offsetWidth` ile ölçülüyor. Faz 2'den beri flyout animasyonunun 0.97 ölçeği `getBoundingClientRect`'e giriyordu; geniş menüler sağ kenardan ~3px taşıyordu (testte 1443 > 1440).
  - Yeni `className` seçeneği, sınıfı ölçümden önce uyguluyor.
- **Test aracı yarışı bulundu ve düzeltildi (`test-support/gui-browser.mjs` `login()`):**
  - Faz 4'te ve bu fazda birer kez görülen "ilk sayfa yüklenmiyor" zaman aşımı 20 denemelik döngüyle yeniden üretildi (3/20). Bu durumda sayfa giriş ekranında ve oturum yok.
  - Neden: giriş sonrası `location.replace('/owner')` yüklenirken araç hemen ikinci bir tarayıcı gezinmesi başlatıyordu; sekmenin `sessionStorage` yazımı kalıcılaşmadan oturum kayboluyordu. Gerçek kullanıcıda oluşmaz.
  - `login()` artık yönlendirilen uygulama tamamen hazır olana kadar bekliyor. Düzeltmeden sonra **0/20**.
- **CSP:** ay/güneş SVG maskeleri `data:` URI; CSP `img-src 'self' data:` buna izin veriyor (sayfa hatası yok). Maskede yalnızca alfa kullanılıyor; renk denetimi testi (`gui-motion.test.mjs`) geçiyor.

**Testler (Faz 7 sonrası):** `check:release` ✅ · `check:syntax` ✅ · `npm test` 712/713 (1 öntanımlı atlama) ✅ · `test:ui` ✅ · `test:supplier-oracle` 22/22 ✅ · `test:recovery` 15/15 ✅ · `test:gui-browser` 62/62 ✅ · `paket6b-e2e` orijinal kodla birebir aynı liste (60/22).

**Yeni test:** `qa-temp/gui-settings-smoke.mjs` (gerçek fare ve klavye ile 8 senaryo, `npm run test:gui-browser` içinde; düzeltmeden sonra 3/3 koşu kararlı):
- Simge buton 46px; metin ve `aria-label` korunuyor; maske ikon var; dişli en sağda.
- Ay → güneş ve dönme.
- Pencerede 4 satır, mevcut durumlar doğru, ekranın içinde, odak kapat butonunda.
- Her anahtar gerçek tercihi değiştiriyor: tema, `data-motion`, `defter-sound` (ses kapalıyken `playChime()` çalmıyor, `force` ile çalıyor), kenar menüsü ve `defter-sidebar-collapsed`.
- `Esc` kapatıyor ve odak dişliye dönüyor; dışarı tıklama kapatıyor.
- Kaydırınca üst bar `top: 0`, cam; `scroll-padding-top` = yükseklik + 16px.
- Telefonda ikonlar 46px, pencere ekranda, kenar menüsü satırı yok, üst bar yapışkan değil.
- Tezgâhta dişli "Oturumu kapat"ın sağında; tema, hareket ve ses satırları var.

### Faz 8 — Giriş ve çalışan hesapları ✅ (2026-11-21)
- [x] Giriş ekranı (`/`):
  - Arka planda 20 sn'de yavaşça kayan üç yumuşak altın ışık (`--gold`, `--gold-bright`, `--gold-text`; %8–14 karışım; yeni renk yok).
  - Cam kart, açılışta 10px yükselip beliriyor (320 ms).
  - Yalnızca giriş sayfasında (`body.access-page:has(#login)`); tezgâh ve çalışanlar sayfasında ışık yok.
- [x] `/users`:
  - Çalışanlar baş harfli kartlar olarak listeleniyor; her kartta kendi "Erişimi kapat" butonu var.
  - Yeni eklenen kart beliriş animasyonuyla geliyor; kapatılan kart sağa kayarak çıkıyor.
  - Çalışan yoksa boş durum kartı gösteriliyor.
- [x] Kabul ölçütleri: oturum açma, geri yükleme sonrası mesaj ve hatalı girişte parola alanının temizlenmesi değişmedi (gerçek tarayıcı testi).

#### Faz 8 sonuçları ve kararlar
- **Mevcut görünüm hatası düzeltildi:** `styles.css`'teki genel `main { min-height: calc(100vh - 220px) }` kuralı, giriş ve çalışanlar sayfalarındaki tek kartı (`main.access-card`) içeriğinin çok altına uzatıyordu (1440×900'de 680px kart, ~400px içerik). Bu iki sayfada kart artık içeriğine göre boyutlanıyor; tezgâh (`.checkout-page`) etkilenmiyor.
- **Arka plan ilk denemede görünmüyordu:** `html` ve `body` ikisi de `--paper` zemin boyuyor. `z-index: -1` ışık katmanı gövdenin zemininin arkasında kalıyordu. `body`'ye `isolation: isolate` verildi; test bunu koruyor.
- **Çalışan kartları mevcut formu kullanıyor:** `#disable` seçim formu sayfada duruyor (`.is-list-backed` ile görünmez). Kart butonu seçimi yapıp `requestSubmit()` çağırıyor; aynı `confirmCritical` penceresi, aynı `/api/auth/disable` çağrısı, aynı başarı bildirimi. Onay penceresinin tetikleyicisi artık tıklanan kart butonu. `users.js` CRLF korunarak güncellendi.
- **`CSS.escape` kullanılmadı:** İlk sürüm kartı `CSS.escape` ile arıyordu; JSDOM'da bu fonksiyon yok ve mevcut `ui-kit-2d` testi başarısız oldu (başarı bildirimi oluşmuyordu). Kart artık `dataset` karşılaştırmasıyla bulunuyor; test yeniden geçiyor.
- `login.js` ve `login.html` bu fazda değişmedi (Faz 5 sihirbazı aynen duruyor).

**Testler (Faz 8 sonrası, üst bar tercihi dahil):** `check:release` ✅ · `check:syntax` ✅ · `npm test` 714/715 (1 öntanımlı atlama; +2 üst bar tercihi testi) ✅ · `test:ui` ✅ · `test:supplier-oracle` 22/22 ✅ · `test:recovery` 15/15 ✅ · `test:gui-browser` 73/73 ✅ (son CSS ile tekrar) · `paket6b-e2e` orijinal kodla birebir aynı liste (60/22).

**Yeni test:** `qa-temp/gui-access-smoke.mjs` (gerçek tarayıcı, 9 senaryo, `npm run test:gui-browser` içinde):
- Giriş kartı içeriğine göre, cam, kayan ışık katmanı görünür istifte.
- Hatalı parolada alan temizleniyor ve hata gösteriliyor.
- Geri yükleme mesajı bir kez çıkıyor.
- Animasyonlar azaltılmışken hiç animasyon yok.
- Çalışan kartı (adı, "UÇ" baş harfleri, erişilebilir buton adı); form sayfada ama gizli.
- Çalışan ekleme: yeni kart animasyonlu ve başarı bildirimi.
- Karttan "Erişimi kapat": kritik pencere, doğru seçim, 300 ms koruma, onay; yalnızca o kart gidiyor ve bildirim çıkıyor.
- Kapatılan çalışan kullanıcı listesinde yok.
- Tezgâh kartı etkilenmiyor.

### Ara değişiklik — İşlem Ekranı yerleşimi ✅ (2026-11-21, kullanıcı isteği)
- [x] İşlem Ekranı'nda (≥1100px) form ve "Canlı işlem özeti" yarı yarıya: `styles.css` `#sale-form.trade-form:not([data-operation="stock"])` için `minmax(0, 1.35fr) minmax(300px, .85fr)` → `minmax(0, 1fr) minmax(300px, 1fr)`. Tek satır, CRLF korundu. Özetin 300px alt sınırı korunuyor.
- Ölçüm: 1440px'te 517/517 px, 1100px'te 363/363 px; yatay taşma yok. 1100px'te sol sütundaki bazı buton grupları alt satıra geçiyor (taşma değil). 1100px'in altında düzen eskisi gibi tek sütun.
- Tezgâhın (`.checkout-trade-layout`, 1.35fr / .9fr) oranı istek kapsamında olmadığı için değiştirilmedi.
- `qa-temp/gui-sale-feedback-smoke.mjs` iki genişlikte eşitliği koruyor.

### Faz 9 — Tezgâh ve satış geri bildirimi ✅ (2026-11-21)
- [x] Çekmeceler: tezgâh müşteri çekmecesi Faz 2 (sağdan kayma, cam, hayalet çıkış) ve Faz 3 (telefonda alttan açılan sayfa, sürükleyerek kapatma) hareketlerini ortak `ui-kit` üzerinden zaten alıyor (`gui-layer-motion` / `gui-sheet` testleri).
- [x] Seçili hap animasyonu: `aria-pressed="true"` olan ödeme çipleri ve tezgâhtaki "Hızlı Mod / Rehberli Adımlar" seçimi seçildiğinde bir kez esniyor (0.96 → 1.03 → 1, 260 ms, yalnızca CSS).
- [x] Satış/alış kaydedilince başarı bildiriminde kendini çizen onay işareti (daire belirir; işaret 400 ms'de çizilir) ve onay sesi (`DefterUI.celebrate`). İşlem akışını bloke etmiyor.
- [x] Dokunmatik hedefler: yeni ikon butonları 46×46px; mevcut M4.3 kuralları (`styles.css` coarse pointer ≥44px) değişmedi.
- [x] Kabul ölçütleri: `ui-checkout-trade-smoke`, `ui-sale-pricing-smoke`, `ui-simplified-transactions-smoke`, `ui-purchase-smoke` geçti.

#### Faz 9 sonuçları ve kararlar
- **Ne zaman çalar / çizilir:** yalnızca **yeni** kaydedilen satış ve alışta.
  - İşlem Ekranı: `submit()` başarılı ve `command.type ∈ {sale, purchase}` ve `!result.duplicate`.
  - Tezgâh: `sendPending()` ticaret dalı ve `!result.duplicate`.
  - Daha önce kaydedilmiş isteğin doğrulanması ("İkinci kez yazılmadı" / "Önceki kayıt doğrulandı"), müşteri kartı, stok kartı ve diğer kayıtlar sade bildirimde kalıyor.
  - Ses "Onay sesi" ayarı kapalıysa çalmıyor; onay işareti yine görünüyor.
- **Çift duyuru önlendi:** Tezgâh başarı metnini zaten kendi `#status` (`role="status"`) alanında duyuruyor. Onay işaretli bildirim orada `announce: false` ile yalnızca görsel (`aria-hidden="true"`, `role` yok). İşlem Ekranı'nda bildirim tek duyuru kaynağı olduğu için `role="status"` korunuyor.
- **Animasyonlar azaltılmışken** onay işareti çizilmeden, tamamlanmış halde görünüyor (`stroke-dashoffset: 0`).
- **Değişen kod:** `ui-kit.js` (`toast` için `icon: 'check'` ve `announce` seçenekleri, `celebrate()`), `app.js` (`inform` `icon` iletir; satış/alış dalı, 2 satır), `checkout.js` (2 satır). `app.js` ve `checkout.js` CRLF korundu.
- **"Ödeme yöntemi seçimi" notu:** Tezgâhtaki Para / Ürün / Hurda butonları seçim değil, satır ekleme butonu. Seçili durum taşıyan (`aria-pressed`) kontroller ödeme çipleri ve mod seçimi; animasyon bunlara uygulandı.

**Testler (Faz 9 sonrası):** `check:release` ✅ · `check:syntax` ✅ · `npm test` 714/715 (1 öntanımlı atlama) ✅ · `test:ui` ✅ · `test:supplier-oracle` 22/22 ✅ · `test:recovery` 15/15 ✅ · `test:gui-browser` 81/81 ✅ · `paket6b-e2e` orijinal kodla birebir aynı liste (60/22).

**Yeni test:** `qa-temp/gui-sale-feedback-smoke.mjs` (gerçek tarayıcı, gerçek kayıtlar; Web Audio osilatör sayacıyla ses doğrulaması; `npm run test:gui-browser` içinde):
- İşlem Ekranı yarı yarıya yerleşim (1440 ve 1100px).
- **Gerçek İşlem Ekranı satışı:** onay işareti çiziliyor, ses 2 nota, bildirim duyuruluyor.
- Ses kapalıyken onay işareti var, ses yok.
- Sade bildirimde onay işareti ve ses yok.
- Animasyon azaltılmışken onay işareti tamamlanmış ve animasyonsuz.
- **Gerçek tezgâh satışı (kayıt → inceleme → onay):** görsel onay işaretli bildirim `aria-hidden`; `#status` duyuruyor; ses 2 nota.
- Mod seçimi esniyor.

### Faz 10 — Mobil rapor `/reports` ✅ (2026-11-21)
- [x] Kart girişleri ve sayfa geçişi: her sekme değişiminde `#report-main` yeniden çiziliyor. Doğrudan alt öğeleri 10px yükselerek ve 40 ms arayla kademeli geliyor (220 ms). Ayrı bir geçiş koduna gerek kalmadı; yalnızca CSS.
- [x] Sekme göstergesi: aktif sekmenin arkasında kayan tek gösterge. Telefonda alta sabit sekme çubuğunda, geniş ekranda üst sekmelerde. Görünümü `reports.css` `@media screen` aktif stiliyle birebir aynı (`--surface` zemin, `--line` kenar, 2px altın alt çizgi). Sekmenin `aria-current="page"` işareti aynen duruyor.
- [x] Salt okunur sınır değişmedi: `report-server.mjs` ve API çağrıları aynı; yalnızca `reports.js`'e görsel gösterge kodu (21 satır, CRLF korundu) ve `motion.css`'e Faz 10 bölümü eklendi.

#### Faz 10 sonuçları ve kararlar
- **`ui-kit.js` rapor sayfasına eklenmedi.** Telefondan açılan salt okunur portala ~50 KB'lık ortak modülü taşımak ve rapor sunucusunun statik listesini genişletmek yerine, `reports.js` içinde kendi kendine yeten küçük bir gösterge (`navIndicator`) yazıldı (Faz 6'daki menü göstergesiyle aynı yöntem: aktif kutudan konum, `ResizeObserver` ile yeniden yerleşim).
- **Sistem "hareketi azalt" ayarı:** Rapor sayfası `styles.css`'i yüklemiyor; `reports.css` yalnızca geçişleri kapatıyor, animasyonları kapatmıyor. Bu yüzden rapor animasyonlarının süreleri hareket token'larından alınıyor. Sistem ayarı açıkken token'lar 0 ms oluyor ve animasyonlar kendiliğinden kapanıyor (testle doğrulandı). Uygulama içi anahtar (`data-motion="reduced"`) da aynı sonucu veriyor.
- **Konumlandırma:** ≤520px'te sekme çubuğu `position: fixed`; gösterge onun içinde konumlanıyor. Daha geniş ekranlarda çubuğa `position: relative` veriliyor (yalnızca `min-width: 521px`'te; telefondaki sabit çubuğu bozmamak için).
- **"Daha fazla" ile eklenen hareket kartları** animasyonsuz geliyor; iç içe çift animasyon olmasın diye animasyon yalnızca `#report-main`'in doğrudan alt öğelerinde.

**Görsel karşılaştırma** (`../er-sat-gui-shots/faz10/` ile `baseline/`):
- 24 görüntünün 9'u piksel piksel aynı.
- Kalan farklar 2–282 piksel: aktif sekme kutusundaki kenar yumuşatma ve bilinen gürültü.
- Telefon görüntülerinin 5'i aynı; tek fark Genel bakış/açık temada bilinen 31 piksellik gürültü.

**Faz 10 test koşusu — şeffaflık notu:**
- İlk tam koşuda `test:gui-browser` 84/86 bitti. Başarısız olan, Faz 6'nın `gui-micro-smoke` "altın butona basınca 0.97" kontrolüydü: basmadan sabit 150 ms sonra ölçüyordu ve tam set yükü altında geçiş henüz tamamlanmamıştı (dönüş hâlâ `translateY(-2px)`). Aynı test tek başına 4/4 geçti.
- Sabit beklemeler, beklenen değeri en fazla 1,5 sn yoklayan bekleyişlerle değiştirildi. Sonrasında test 9/9, tüm tarayıcı seti 86/86 geçti; ikinci tam zincir koşusunun sonucu aşağıda.
- Aynı ilk koşuda `paket6b-e2e` 59/23 bitti. Tek fark, Faz 3'te kök nedeni belgelenen `T2-F2-5` yarışı (Mac'te `Ctrl+A` seçmiyor); ürünle ilgisi yok.

**İkinci tam zincir koşusu (düzeltmeden sonra):** `check:syntax` ✅ · `npm test` 714/715 (1 öntanımlı atlama) ✅ · `test:ui` ✅ · `test:supplier-oracle` 22/22 ✅ · `test:recovery` 15/15 ✅ · `test:gui-browser` 86/86 ✅ · `paket6b-e2e` orijinal kodla birebir aynı liste (60/22).

**Yeni test:** `qa-temp/gui-reports-smoke.mjs` (gerçek tarayıcı, test aracının tailnet vekili üzerinden gerçek rapor sunucusu; `npm run test:gui-browser` içinde; 2/2 koşu kararlı):
- Gösterge aktif sekmenin tam arkasında ve mevcut aktif görünümde; `aria-current` korunuyor.
- Sekme değişince gösterge kayıyor ve içerik kademeli geliyor (0 s / 0,04 s / 0,08 s).
- Telefonda alt çubuk sabit ve gösterge içinde doğru yerde; masaüstüne dönünce yeniden yerleşiyor.
- Uygulama anahtarıyla animasyon yok; sistem ayarıyla süreler 0 s.
- Sayfa hatası yok.

### Faz 11 — Kalite, performans, belge ✅ (2026-11-21 / 22)
- [x] **Tam test seti — son koşu:** `check:release` ✅ · `check:syntax` ✅ · `npm test` 715/716 (1 öntanımlı atlama; +1 kontrast testi) ✅ · `test:ui` ✅ · `test:supplier-oracle` 22/22 ✅ · `test:recovery` 15/15 ✅ · `test:gui-browser` **93/93** ✅ (12 dosya) · `paket6b-e2e` orijinal kodla birebir aynı liste (60/22) · `git diff --check` (CRLF hariç) temiz.
- [x] **Kontrast** (yeni otomatik test, `test/gui-motion.test.mjs`): cam yüzeylerde metin ≥ 4.5:1. Hesap en kötü durum bileşimiyle yapılıyor (yüzey opaklığı, karartma perdesi ve sayfa zemini; renkler `styles.css` token'larından okunuyor). Ana / soluk metin:

  | Yüzey | Açık tema | Koyu tema |
  |---|---|---|
  | Pencere (%90) | 13.65 / 5.86 | 14.14 / 9.00 |
  | Bildirim (%96) | 14.63 / 6.28 | 14.05 / 8.94 |
  | Üst bar (%78) | 15.00 / 6.44 | 14.39 / 9.16 |
- [x] **Performans** (`paket6b-efficiency-benchmark`, 3 koşu):
  - Koşu 1: 14/16. Koşu 2 ve 3: 15/16, yani orijinal kodla aynı.
  - **T02** (tekrarlanan arama, ~33 ms): orijinal kodda da başarısız; Mac'te headless kare zamanlaması.
  - **T08** (combobox klavye) koşu 1'de p95 = 16.7 ms ile sınırı (16.6) **0.1 ms** aştı; diğer koşularda 16.1 ve 16.3 ms ile geçti. Medyan orijinalle aynı (15.8–15.9 ms). Ölçüm gürültüsü olarak değerlendirildi.
- [x] **Klavye turu** (yeni gerçek tarayıcı testi, `qa-temp/gui-keyboard-smoke.mjs`, 2/2 kararlı):
  - İlk Tab atlama bağlantısına gidiyor, bağlantı görünür oluyor; Enter içeriğe atlıyor.
  - Tab kenar menüsünü ve üst barı (çalışma alanı, Komutlar, Yenile, ay/güneş, Ayarlar) dolaşıyor; **her durakta görünür odak** var.
  - Ayarlar yalnızca klavyeyle çalışıyor: Enter açıyor, Tab anahtara gidiyor, Space değiştiriyor, Esc kapatıyor ve odak geri dönüyor.
  - Ay/güneş butonu Enter ve Space ile çalışıyor.
  - Çekmecede Tab ve Shift+Tab ile odak dışarı çıkmıyor, her durak görünür; Esc kapatıyor ve odak tetikleyiciye dönüyor.
  - Ctrl+K paleti açıyor, odak arama kutusunda; Esc kapatıyor.
- [ ] **NVDA / VoiceOver ile elle kontrol:** otomatikleştirilemez; kullanıcıyla birlikte yapılmalı. Otomatik testler `aria-*` sözleşmelerini (rol, `aria-current`, `aria-hidden`, `aria-describedby`, tek duyuru) kapsıyor.
- [x] **Son ekran görüntüleri** (`../er-sat-gui-shots/after/`, 126 adet) başlangıçla karşılaştırıldı. 9 görüntü aynı, 15'inde yalnızca bilinen gürültü (< 300 px). Diğer farkların hepsi bilinçli değişiklik:
  - Üst bar ay/güneş ve Ayarlar butonları ile aktif menü kutusu (ana defterin durağan ekranları; telefonda yalnızca üst bar buton satırı, ~4 bin px).
  - İşlem Ekranı yarı yarıya yerleşim.
  - Açılır katmanların cam görünümü (palet, çekmeceler).
  - Tezgâh: rehberli moddaki "Adım 1 / 3" satırı (+31 px yükseklik) ve hızlı moddaki dişli.
  - Giriş ekranının arka planı ve kart yüksekliği.
  - Çalışanlar sayfasının kart listesi (sayfa boyu değişti).
- [x] **Belge:** `docs/development.md` dosyasına "Arayüz hareket katmanı" bölümü eklendi (token'lar, `DefterPrefs`, yeni `DefterUI` API'leri, statik dosya listeleri, `test:gui-browser`, ekran görüntüsü aracı, `paket6b` macOS notu).
- [ ] **Commit:** kullanıcı onayı bekliyor.

**Tahmini toplam: 13–17 iş günü.**

## 7. Riskler

| Risk | Önlem |
|---|---|
| Animasyon testleri kırar (eşzamanlı DOM beklentisi) | Hayalet çıkış (§5); test ortamında animasyon kapalı |
| `backdrop-filter` eski PC'de kasar | Tek blur katmanı kuralı, `@supports` yedeği, blur 16px'i geçmez |
| Cam zemin üzerinde metin kontrastı düşer | Cam opaklığı %78'in altına inmez; kontrast ≥ 4.5:1 her iki temada ölçülür |
| Hover glow açık temada soluk kalır | Glow yalnızca mevcut `--gold` karışımıyla yapılır; görünmezse kenarlık vurgusuyla desteklenir |
| Bottom sheet sürüklemesi kaydırmayla çakışır | Sürükleme yalnızca tutamaçtan veya `scrollTop === 0` iken başlar |
| `color-mix()` desteği | Chrome/Edge 111+ gerekir; desteklemeyen tarayıcıda glow kapanır (`@supports`) |

## 8. Sonradan verilen kararlar (2026-11-21)

1. **"Animasyonları azalt" anahtarı eklenecek.** Üst bardaki Gece modu butonunun yanında yer alır; `<html data-motion="reduced">` niteliğiyle çalışır. Tercih `localStorage`'da tutulur ve okuma/yazma `try/catch` içinde yapılır. Sistem ayarı (`prefers-reduced-motion`) açıksa anahtar kapalı olsa bile animasyonlar azaltılır. → Faz 1 (token) ve Faz 7 (üst bar).
2. **Satış tamamlanınca ses çalacak.** Ses dosyası kullanılmaz; Web Audio API ile 2 notalı kısa bir "tın" sesi (~180 ms) üretilir, CSP ile uyumludur. Ses ayrı bir **"Ses"** anahtarıyla kapatılabilir ve varsayılan olarak açıktır. Ses sadece başarılı kayıtta çalar, hata durumunda çalmaz. → Faz 9 (tezgâh), aynı ses İşlem Ekranı'ndaki başarılı kayıtta da çalar.
3. **Toast sağ alt köşeye taşınacak.** `.defter-toast-region` için `bottom: 24px; right: 24px` kullanılır. Tezgâhtaki alt ödeme çubuğuyla çakışmayı önlemek için `/checkout` sayfasında bu çubuğun yüksekliği kadar boşluk bırakılır. Kullanıcı beğenmezse konum tek bir değişkenle (`--toast-anchor`) değiştirilebilir. → Faz 2.
