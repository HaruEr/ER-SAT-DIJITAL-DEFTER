# Geliştirici rehberi

## Mimari

`server.mjs` yerel HTTP/kimlik sınırını, `identity.mjs` ayrı kimlik deposunu, `editor-access.mjs` rol projeksiyonlarını sağlar. `repository.mjs` SQLite olay defteri, revision, replay, yedek ve atomik kayıt katmanıdır. `domain.mjs`, `retail-exchange.mjs`, `sale-pricing.mjs`, `inventory.mjs` ve `supplier-ledger.mjs` iş kurallarını uygular. `ledger-view.mjs` ve `supplier-view.mjs` rapor/projeksiyonları üretir. Frontend `public/` altında derleme gerektirmeyen JavaScript/CSS/HTML'dir. PDF motoru ve font yerel `public/vendor/pdfmake/` içindedir.

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

## Değişiklik doğrulama

UI, API ve domain katmanlarının birbiriyle uyumunu test edin. Eski olay fixture'ları sentetiktir; finansal şema değişikliğinde replay/restore ve bağımsız oracle sonuçlarını karşılaştırın. Yeni birim veya hesap davranışını otomatik dönüşümle tamamlamayın. Test çalışırken aynı kaynak dosyalarını değiştirmeyin. Kaynak SHA256'ları, test kesiti ve fiilî komut/exit bilgileri kabul raporunda eşleşmelidir.
