# ER ŞAT DİJİTAL DEFTER

[Teknik kabul sonuçları](docs/acceptance.md) · [Tam sürüm eşdeğerliği](docs/equivalence.md) · [Yayın güvenliği](docs/security-review.md) · [Geliştirici rehberi](docs/development.md)

Kuyumcu işletmeleri için yerel satış, müşteriden alış, stok, kasa/banka/POS ve çok birimli cari defter uygulaması. Node.js 24, yerleşik SQLite (`node:sqlite`) ve derleme gerektirmeyen vanilla JavaScript kullanır. Tüm veriler kurulumun kendi bilgisayarında tutulur. **Resmî muhasebe veya e-belge entegrasyonu içermez.**

**Lisans ve Sahiplik:** Kod [MIT lisansı](LICENSE) altındadır. Copyright (c) 2026 Harun Eren Şat. Bütün dosyaların kod sahibi `@HaruEr` olarak tanımlıdır. ER ŞAT DİJİTAL DEFTER adı korunur; marka/logo hakları kod lisansından ayrı değerlendirilir. Açık kaynak yayını ile gerçek mağaza/üretim ortamı kabulü birbirinden ayrıdır; üretim ortamında kullanım için ayrıca yerel operasyonel kabul gerekir. [Lisans kararı](docs/license-options.md) ve [yayın kapıları](docs/github-protection.md).

## Windows'ta kurulum

Git ve **Node.js 24.x** gerekir (Node 24 yerleşik `node:sqlite` sağlar; ayrı SQLite sunucusu kurulmaz). Windows dışı işletim sistemleri için doğrulanmış destek iddiası yoktur.

```powershell
git clone https://github.com/HaruEr/ER-SAT-DIJITAL-DEFTER.git er-sat-defter
cd er-sat-defter
node --version
npm.cmd ci --ignore-scripts
npm.cmd start
```

Tarayıcıda `http://127.0.0.1:4317` adresini açın. Alternatif olarak `BASLAT.cmd` kullanılabilir. `public/index.html` dosyasını doğrudan açmayın. Port kullanımda ise aynı PowerShell penceresinde `$env:PORT='4327'` ayarlayıp başlatın; açık başka uygulamaları durdurmayın.

İlk ekranda kendi işletme sahibi adınızı ve **en az 15 karakterlik** parolanızı belirleyin. Hazır yönetici hesabı veya varsayılan parola yoktur.

## Çalışma alanı ve veri güvenliği

Yeni kurulumda eski müşteri, toptancı, işlem, stok bakiyesi, cari bakiye ve sayım geçmişi bulunmaz. Uygulama ilk kullanımda kendi `data/` dizinini oluşturur; başka bir dizindeki eski veritabanını silmez veya kopyalamaz. “Örnek defter” (`demo`) ve “Dükkân defteri” (`dukkan`) ayrı çalışma alanlarıdır; örnek adı otomatik örnek işlem üretildiği anlamına gelmez. İlk kullanımda günü sıfır açılışla açın ve her işlem öncesi aktif çalışma alanını kontrol edin.

`data/`, `.local/`, yedekler ve kimlik dosyalarını kesinlikle Git'e eklemeyin. `.env` otomatik yüklenmez; gerekli ortam değişkenleri terminalden verilir.

## Mimari, yetkiler ve güncel işlevler

- **Finansal Kayıt Mimarisi:** Tüm miktar ve tutarlar güvenli tam sayı alt birimlerinde (`ADET=1`, `TL/USD/EUR=100`, `GRAM/HAS/SILVER=1000`, `<= 1e12`) işlenir; birimler otomatik kurla birleştirilmez. Olay defteri *append-only* (`v1`–`v17` şema sürümleri) yapıdadır; büyük ölçeklerde `hot-v1` SQLite anlık görüntüsü ve artımlı günlük indeksleri (`ledger_journal`, `ledger_links`) ile hızlandırılır.
- **Kullanıcı Yetkileri:** Yönetici (`owner`) tüm 10 bölüme (Günün Görünümü, İşlem Ekranı, Sayım ve Kapanış, Müşteri Ekranı, Toptancılar, Stok Ekranı, Banka/POS/Kasa, Günlük İşlemler, Günlük İşletme Özeti, Yedek ve Çalışma Alanı) ve çalışan yönetimine erişir. Çalışan (`employee`) yalnızca `/checkout` tezgâhında izin verilen perakende satış/alış ve sıfır açılışlı müşteri oluşturma işlemlerini yapabilir; toptancı, özel maliyet (`itemCostSource`), sayım ve yedekleme uçları sunucu tarafında `403` ile engellenir. Mobil rapor servisi (`report-server.mjs`) salt okunurdur (`GET`, `PRAGMA query_only=ON`).
- **Güncel Arayüz ve Ölçek Özellikleri:**
  - Hızlı ve 3 adımlı rehberli işlem akışı, `DefterCombobox` sanallaştırılmış arama, `Ctrl+K` komut paleti ve Türkçe karakter normalizasyonu (`search-norm.js`).
  - Birim farkındalıklı `tr-TR` sayı girişi (`amount-codec.js`) ve `GRAM/HAS/SILVER` alanlarında `10.500` belirsizliği için zorunlu kullanıcı netleştirme koruması.
  - 4 kategorili CSP-uyumlu bildirim sistemi (`ui-kit.js`), `sessionStorage` bayatlık (`stale`) korumalı taslak deposu (`draft-store.js`) ve tarayıcı Geri/İleri destekli Hash navigasyonu.
  - `/api/summary?paginated=1` geriye uyumlu sunucu taraflı özet sayfalama ve filtreleme.
- **Yedekleme ve Sürüm Uyumluluğu:** `.json` yedek (`<= 64 MiB`), akışlı `.ndjson` arşiv (`<= 512 MiB` / `<= 250.000` olay) ve tek kullanımlık indirme biletleri desteklenir; geri yükleme öncesi tüm aktif oturumlar iptal edilir. **Önemli sürüm sınırı:** `bf63dae` sonrasında kaydedilen serisiz `SILVER retailExchange` olayları eski `7719eaf`/`b245e9c` sürümlerinde replay edilemez; sürüm yükseltmeden önce yedek alınmalıdır ([detaylı kurtarma notları](docs/development.md#sürüm-uyumluluğu-ve-silver-sınırı)).

## Geliştirme, güncelleme ve test

Testleri asla gerçek işletme kurulumunda çalıştırmayın. İzole geçici klasör ayarlarıyla ([detaylar](docs/development.md#test-ortamı)):

```powershell
npm.cmd test
npm.cmd run test:ui
npm.cmd run test:supplier-oracle
npm.cmd run test:recovery
node scripts/check-syntax.mjs
node scripts/release-check.mjs
```

### Yeni geliştirme dalı açma ve mevcut klonu güncelleme

```powershell
# Yeni geliştirme için:
git switch -c feature/kisa-aciklama

# Önceden klonlanmış temiz bir depoyu güncellemek için:
git fetch origin
git switch main
git pull --ff-only origin main
```

Yerel deponuzda commit edilmemiş değişiklikler varsa `git pull --ff-only` öncesinde değişikliklerinizi commit edin veya `git stash push` ile güvene alın; genel güncelleme için `git reset --hard` veya force-pull kullanmayın.

[Katkı rehberi](CONTRIBUTING.md) · [Güvenlik bildirimi](SECURITY.md) · [Üçüncü taraflar](docs/third-party.md)
