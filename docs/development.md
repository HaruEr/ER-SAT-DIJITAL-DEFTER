# Geliştirici rehberi

## Mimari

`server.mjs` yerel HTTP/kimlik sınırını, `identity.mjs` ayrı kimlik deposunu, `editor-access.mjs` rol projeksiyonlarını sağlar. `repository.mjs` SQLite olay defteri, revision, replay, yedek ve atomik kayıt katmanıdır. `domain.mjs`, `retail-exchange.mjs`, `sale-pricing.mjs`, `inventory.mjs` ve `supplier-ledger.mjs` iş kurallarını uygular. `ledger-view.mjs` ve `supplier-view.mjs` rapor/projeksiyonları üretir. Frontend `public/` altında derleme gerektirmeyen JavaScript/CSS/HTML'dir (`ui-kit.js`, `amount-codec.js`, `date-format.js`, `draft-store.js`, `search-norm.js`, `combobox.js`, `command-palette.js` dahil). PDF motoru ve font yerel `public/vendor/pdfmake/` içindedir.

`test/` Node test runner; `qa-temp/` adı tarihsel olmasına rağmen buradaki izlenen `.mjs` dosyaları dağıtılan test kaynaklarıdır. Silinmemelidir. `test-support/` ortak yardımcıları içerir. `test:ui` için lockfile'daki JSDOM gereklidir; başka bilgisayarın global modülüne ihtiyaç yoktur.

## Test ortamı

Gerçek işletme kurulumundan ayrı geliştirme klonunu kullanın. Windows PowerShell'de test geçicilerini geliştirme klonunun dışında ayrılmış kardeş klasöre yönlendirin:

```powershell
$devTemp = Join-Path (Split-Path (Get-Location) -Parent) 'er-sat-test-temp'
New-Item -ItemType Directory -Force -Path $devTemp | Out-Null
$env:TEMP = $devTemp
$env:TMP = $devTemp
$env:npm_config_cache = Join-Path $devTemp 'npm-cache'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
Remove-Item Env:JSDOM_MODULE_PATH -ErrorAction SilentlyContinue
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd run test:ui
npm.cmd run test:supplier-oracle
npm.cmd run check:syntax
npm.cmd run check:release
```

Bu değişkenler yalnız terminal oturumuna aittir. Başarısız komutun `$LASTEXITCODE` değerini kaydedin; sonraki başarılı komut önceki hatayı örtmemelidir. Testlerin geçmesi gerçek mağaza, yazıcı, telefon veya felaket kurtarma kabulü değildir. `npm.cmd run test:coverage` mevcut Node coverage raporunu üretir; ölçülmedikçe yüzde iddia edilmez. `test:recovery` yedek/kurtarma testlerini, `benchmark` sentetik performans betiğini çalıştırır.

## macOS Apple Silicon geliştirme ve test

macOS geliştirici ortamında `.nvmrc` dosyasıyla Node.js 24
seçilir. Yeni Terminal oturumlarında `nvm use` komutu
tekrarlanmalıdır; `.nvmrc` kendiliğinden sürüm değiştirmez.

Testleri gerçek işletme verilerinin bulunduğu kurulumdan
ayrı, temiz bir geliştirme klonunda çalıştırın.

```bash
cd ~/Developer/ER-SAT-DIJITAL-DEFTER
nvm use

TEST_TEMP="$(cd .. && pwd)/er-sat-test-temp"
mkdir -p "$TEST_TEMP/npm-cache"

export TEMP="$TEST_TEMP"
export TMP="$TEST_TEMP"
export TMPDIR="$TEST_TEMP/"
export npm_config_cache="$TEST_TEMP/npm-cache"
unset NODE_OPTIONS NODE_PATH JSDOM_MODULE_PATH

npm ci --ignore-scripts
npm run check:syntax
npm run check:release
npm test
npm run test:ui
npm run test:supplier-oracle
npm run test:recovery
```

`TMPDIR` macOS üzerinde `node:os` geçici dizin seçimini
etkiler. Sentetik seed alt süreçleri için `TEMP`, `TMP` ve
`TMPDIR` tutarlı biçimde aktarılmalıdır. Bu konuda
`test/release-install.test.mjs` içinde bir regresyon
düzeltmesi bulunur.

Tarayıcıda deneme yapmak için:

```bash
npm run sandbox
```

Sandbox çıktısındaki yerel URL'yi açın. Sunucu Terminal'i
açık kalmalıdır. Çıktıda bulunan sentetik parolalar Git'e,
PR açıklamasına veya test kanıtına eklenmemelidir.

`npm start` normal yerel veri alanını kullanabilir;
`npm run sandbox` ise her açılışta bağımsız sentetik alan
oluşturur. İkisini birbirinin yerine kullanmayın.

Apple Silicon geliştirme testlerinin geçmesi gerçek mağaza,
mobil cihaz, yazıcı, otomatik yedek veya felaket kurtarma
kabulü değildir. Windows amd64 restic pilotu Mac test
kapsamına dahil değildir.

## İsteğe bağlı sentetik deneme

```powershell
npm.cmd run sandbox
```

Her başlatma yeni bir geçici sentetik ortam oluşturur; yerel terminalde adres ve üretilen deneme hesapları gösterilir. Bunları gerçek parola olarak kullanmayın veya PR kanıtına eklemeyin. Normal `data/` deposu hedeflenmez. Senaryolar için test ürünleri, stoklar, müşteriler, firmalar, çok birimli hesaplar ve hareketler kullanılabilir. Yeniden başlatmak yeni deneme oluşturur; mevcut işletme kaydını sıfırlayan komut yoktur. Yalnız veri kurulumu için `npm.cmd run seed:synthetic` kullanılır. Teknik akışlar kaynak testlerinde ayrıca ifade edilir; seed tek başına tüm işlevlerin kabul sonucu değildir.

## Mobil salt okunur raporlar

Bu özellik mevcut mimaride ayrı Tailscale özel ağ/HTTPS kimlik proxy'sine bağlıdır. Kaynaklar depodadır; harici ağ hesabı ve cihaz yapılandırması kullanıcının kendi kurulumudur. Editör portunu paylaşmayın. Salt okunur servis varsayılan kapalıdır; bunun nedeni yayın için özellik kaldırılması değildir.

Kendi özel ağınızda doğrulanmış Tailscale Serve kimlik başlıkları üreten yapılandırmayı kurduktan sonra, kendi gerçek değerlerinizle:

```powershell
$env:REPORT_ENABLED = '1'
$env:REPORT_ORIGIN = 'https://cihaz.kendi-aginiz.ts.net'
$env:REPORT_ALLOWED_LOGINS = 'izin-verilen-hesap'
$env:REPORT_DATA_DIRECTORY = (Resolve-Path './data').Path
$env:REPORT_PORT = '4318'
npm.cmd run start:reports
```

Yukarıdaki adres ve hesap örnektir; çalışan ağ hesabı değildir. Origin tam HTTPS origin olmalıdır. Proxy yalnız özel ağdan erişilebilir olmalı, `Host` ve tek `Tailscale-User-Login` başlığını güvenilir biçimde taşımalıdır; Funnel desteklenmez. Servis yalnız loopback dinler ve yalnız GET rapor yollarına izin verir. Başlıkları istemciden taklit ederek korumayı kaldırmayın. `test/reports.test.mjs` ve `test/report-launcher.test.mjs` sentetik güvenlik/okuma doğrulamasıdır; gerçek telefon veya tailnet kabulü değildir.

## Yedek ve kurtarma

Ana uygulamanın JSON/akışlı yedek, arşiv ve geri yükleme kaynakları dahildir. Kimlik ve mali olay depolarının kapsamı farklıdır; bir defter yedeğini bütün bilgisayar kurtarma planı saymayın. Geri yükleme uyumluluğu ve olay sürümleri testlerle korunmalıdır.

Şifreli yedek pilotu ayrı, isteğe bağlı sentetik geliştirici aracıdır; `scripts/restic-pilot-tool.json` içindeki sabit sürüm/hash beklentisine uygun harici **restic 0.19.1 Windows amd64** gerektirir. İncelenmiş ikiliyi `tools/restic_0.19.1_windows_amd64.exe` konumuna kendiniz kurun veya `RESTIC_PILOT_BINARY` ile tam yolunu belirtin; betik SHA256 pinini doğrular. Klonun kardeş `../temp` klasörünü oluşturun. Normal uygulama, backend/UI testleri veya yerel yedek ekranı için restic gerekmez. `npm.cmd run test:backup-pilot` ve `npm.cmd run pilot:backup` önkoşulları sağlanmadan PASS sayılmaz. Bulut sağlayıcı kurulumu, otomatik görev ve RPO/RTO işletme kabulü bu aday tarafından yapılmaz.

## Arayüz hareket katmanı

GUI yeniden tasarımı (ayrıntılar ve kararlar: [gui-redesign-plan.md](gui-redesign-plan.md)) renk paletine dokunmaz; yalnızca hareket, açılır katmanlar ve etkileşim ekler.

- **`public/motion.css`:** Tüm sayfalarda son stil dosyası. Token'lar `--dur-*`, `--ease-*`, `--lift-*`, `--press-scale`, `--glass-*`, `--glow-*`. **Renk literali içermez**: yalnızca mevcut palet token'ları `transparent` ile karıştırılır; `test/gui-motion.test.mjs` bunu ve cam yüzeylerde ≥ 4.5:1 metin kontrastını denetler. Yalnızca `transform` / `opacity` canlandırılır. Hover etkileri yalnızca `(hover: hover) and (pointer: fine)` için geçerli.
- **`public/ui-prefs.js` (`window.DefterPrefs`):** Her sayfada `<head>` içinde, stillerden önce yüklenir. Cihaz tercihleri:
  - `getMotion` / `setMotion` / `motionReduced`: `defter-motion`; sistem `prefers-reduced-motion` ayarı da sayılır.
  - `getSound` / `setSound`: `defter-sound`.
  - `getTopbarSticky` / `setTopbarSticky`: `defter-topbar`.
  - `onChange`.

  Tercihler `<html data-motion="reduced">` ve `<html data-topbar="static">` olarak ilk boyamadan önce uygulanır. Depolama engelliyse varsayılanlar geçerli olur.
- **`public/ui-kit.js` (`window.DefterUI`) eklemeleri:**
  - `animateExit`: katmanlar eşzamanlı kapanır; çıkışı gölge DOM içindeki görsel kopya oynatır ve hiçbir `document` sorgusu onu bulamaz.
  - `guardConfirm`: kritik onay butonu ilk 300 ms kullanıcı girdisini (`isTrusted`) yok sayar; programla yapılan `.click()` etkilenmez.
  - `enhanceStepper`, `enhanceNav`, `animateEnter`, `openSettings`, `playChime` / `celebrate`, `enhanceTopbar`.
  - `toast(…, { icon: 'check', announce })`.

  Bu fonksiyonlar mevcut adım, menü ve tema mantığına dokunmaz; değişimi `MutationObserver` ile izler veya sayfanın kendi butonlarını tetikler.
- **Yeni statik dosyalar** (`motion.css`, `ui-prefs.js`) hem `server.mjs` hem `report-server.mjs` statik listesinde olmalıdır; sunucu değişikliğinden sonra yeniden başlatın.
- **Gerçek tarayıcı testleri:** `npm run test:gui-browser`. Chrome bulunamazsa `CHROME_PATH` verin. `test-support/gui-browser.mjs` sentetik defter, sunucular ve CDP oturumunu kurar; `data/` klasörüne dokunmaz. `startGuiSession({ empty: true })` ilk kurulum, `{ reports: true }` rapor portalı içindir.
- **Ekran görüntüleri:** `node scripts/gui-screenshots.mjs <klasör> [--only=login,owner,users,checkout,reports]`. 3 genişlik × 2 tema; `index.html` galeri oluşturur. Klasörü depo dışında tutun.
- **`paket6b` CDP testleri:** macOS'te `CHROMIUM_PATH` gerektirir. Bu ortamda 22 senaryo yeniden tasarımdan önce de başarısızdı (çoğu `Ctrl+A`'nın macOS'te seçim yapmaması); Windows'ta ayrıca doğrulanmalıdır.

## Değişiklik doğrulama

UI, API ve domain katmanlarının birbiriyle uyumunu test edin. Eski olay fixture'ları sentetiktir; finansal şema değişikliğinde replay/restore ve bağımsız oracle sonuçlarını karşılaştırın. Yeni birim veya hesap davranışını otomatik dönüşümle tamamlamayın. Test çalışırken aynı kaynak dosyalarını değiştirmeyin. Kaynak SHA256'ları, test kesiti ve fiilî komut/exit bilgileri kabul raporunda eşleşmelidir.

İsteğe bağlı ölçek ve tarayıcı kıyaslama betikleri:
- `node scripts/benchmark.mjs` ve `node scripts/benchmark-paket6a.mjs` (büyük veri/snapshot kıyaslaması)
- `node qa-temp/paket6b-e2e-browser.mjs` ve `node qa-temp/paket6b-efficiency-benchmark.mjs` (gerçek Chrome CDP E2E)

## Sürüm uyumluluğu ve SILVER sınırı

- **Geriye Uyumlu Olmayan Olay Sınırı:** `bf63dae` sonrası kaydedilen serisiz `SILVER retailExchange` (`schemaVersion: 13`) olayları, eski `7719eaf` veya `b245e9c` sürümlerinde replay edilemez (`DomainError: Bağlı toptancı veya saf gümüş için güncel olay sürümü gerekli.`). Benzer şekilde `amend` rezerve sınırı (`F-M3-003`) ve iade sonrası toptancı tahsis ters kaydı (`CHAL-M33-P2`) eski sürümlerde reddedilir.
- **Eski Sürümde Güvenli Hata ve Kurtarma:** Eski sürüm bu olayları gördüğünde veritabanını sessizce dönüştürmez; güvenli hata ve rapor portalında `503` üretir, ancak `recoveryInfo()` (`canRestore: true`) korunur.
- **Sürüm Yükseltme ve Düşürme Kuralı:** Sürüm yükseltmeden önce mutlaka `.json` / `.ndjson` yedek alın. Sürüm düşürme gerekiyorsa yeni olaylar sonrası alınan yedeği eski sürüme zorlamayın; eski sürüm öncesi yedeği `/api/recovery` ile yükleyin veya desteklenen güncel (`6c9621d+`) sürüme ileri dönün. Eski ve yeni yedek dosyalarını tarih/sürüm etiketiyle ayrı tutun.
