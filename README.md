# ER ŞAT DİJİTAL DEFTER

Kuyumcu işletmeleri için yerel satış, alış, stok, kasa/banka ve çok birimli cari defter uygulaması. Node.js, yerleşik SQLite ve vanilla JavaScript kullanır. Veriler kurulumun kendi bilgisayarında tutulur. Resmî muhasebe veya e-belge entegrasyonu içermez.

**Yayın adayı:** Kod lisansı, telif sahibi ve GitHub depo sahibi henüz kesinleştirilmedi. Bu hazırlık açık kaynak kullanım izni verildiği veya GitHub korumalarının etkin olduğu anlamına gelmez. [Lisans seçenekleri](docs/license-options.md) ve [yayın kapıları](docs/github-protection.md) tamamlanmadan genel yayın yapılmamalı.

## Windows'ta kurulum

Git ve Node.js **24.x** gerekir. Node 24 yerleşik `node:sqlite` sağlar; ayrı SQLite sunucusu kurulmaz. Windows dışı platformlar için bu adayda doğrulanmış destek iddiası yoktur.

Depo yayımlandıktan ve lisans kesinleştikten sonra kendi fork adresinizi kullanın:

```powershell
git clone <forkunuzun-HTTPS-adresi> er-sat-defter
cd er-sat-defter
node --version
npm.cmd ci --ignore-scripts
npm.cmd start
```

Tarayıcıda `http://127.0.0.1:4317` açılır. Alternatif olarak `BASLAT.cmd` kullanılabilir. `public/index.html` dosyasını doğrudan açmayın. Port kullanımda ise aynı PowerShell penceresinde `$env:PORT='4327'` ayarlayıp başlatın; açık başka uygulamaları durdurmayın.

İlk ekranda kendi işletme sahibi adınızı ve **en az 15 karakterlik** parolanızı belirleyin. Hazır yönetici hesabı veya varsayılan parola yoktur. Bu hesap adı işletme profilinden ve **ER ŞAT DİJİTAL DEFTER** ürün adından ayrıdır.

Yeni kurulumda eski müşteri, toptancı, işlem, stok bakiyesi, cari bakiye ve sayım geçmişi bulunmamalıdır. Teknik hesap/birim/kategori tanımları bulunur. “Örnek defter” ve “Dükkân defteri” ayrı çalışma alanlarıdır; örnek adı otomatik örnek işlem üretildiği anlamına gelmez. İlk kullanımda günü sıfır açılışla açın. Çalışma alanını her işlem öncesi kontrol edin.

Uygulama ilk kullanımda kendi `data/` dizinini oluşturur; kurulum başka bir dizindeki eski veritabanını silmez veya kopyalamaz. `data/`, `.local/`, yedekler ve kimlik dosyalarını Git'e eklemeyin. `.env` otomatik yüklenmez; gerekli ortam değişkenleri terminalden verilir.

## Kullanım ve kapsam

Yönetici ekranındaki on bölüm: Günün Görünümü, İşlem Ekranı, Sayım ve Kapanış, Müşteri Ekranı, Toptancılar, Stok Ekranı, Banka/Pos/Kasa, Günlük İşlemler, Günlük İşletme Özeti, Yedek ve Çalışma Alanı. Çalışan hesapları ayrı sayfadan yönetilir; çalışan tezgâhı rol kısıtlarını korur.

- Stok ekranında ürün ve miktarları tanımlayın; adet, gram, ayar ve HAS anlamlarını birbirine dönüştürmeyin. İki seviyeli stok ve tekil ürün kaydı korunur.
- Müşteri ekranında sıfır açılışlı müşteri oluşturun. İşlem ekranında satış veya müşteriden alış seçin; ürünleri, alınan/verilen para ve ürünleri, gerektiğinde cari karşılıkları ekleyin. Önizlemeyi doğrulayıp kaydedin.
- Toptancılarda firma oluşturun, HAS/TL/USD/Ag gibi bağımsız birim hesaplarını ekleyin; ürün alışı, ödeme/avans, tahsis, mahsup, bağlı iade, düzeltme ve mutabakatı kullanın. Birimler otomatik kurla birleştirilmez.
- Sipariş ve avans, bağlı iade/değişim, kasa/banka/POS ve döviz hareketleri, günlük sayım/kapanış, olay ve düzeltme geçmişi mevcuttur.
- Ekstre ve raporları görüntüleyin; ilgili ekranlardan CSV/PDF ve yazdırma araçlarını kullanın. Yedek ekranından dışa aktarma/geri yükleme yapılır. Geri yükleme öncesi ayrı güvenlik kopyası alın; geri yükleme oturumu kapatabilir.

Çalışan yalnız izin verilen perakende işlemleri ve sıfır açılışlı müşteri oluşturmayı yapar; toptancı işlemleri, özel maliyet ve yönetici görevleri çalışan yetkisinde değildir. Mobil rapor servisi salt okunurdur. [Mimari ve mobil kurulum](docs/development.md).

## Geliştirme ve test

Testleri gerçek işletme kurulumunda çalıştırmayın. Ayrı geliştirme klonunda [test hazırlığını](docs/development.md#test-ortamı) uyguladıktan sonra:

```powershell
npm.cmd test
npm.cmd run test:ui
npm.cmd run test:supplier-oracle
node scripts/check-syntax.mjs
node scripts/release-check.mjs
```

Node testleri backend/finansal davranışı, JSDOM betikleri arayüz etkileşimini sınar; JSDOM gerçek tarayıcı görsel kabulünün yerine geçmez. Ayrı build, TypeScript veya lint sistemi yoktur. Gerçek komut sonuçları yayın kabul raporunda ayrıca kaydedilir; CI dosyasının varlığı GitHub'da çalıştığı anlamına gelmez.

[Katkı rehberi](CONTRIBUTING.md) · [Güvenlik bildirimi](SECURITY.md) · [Üçüncü taraflar](docs/third-party.md)
