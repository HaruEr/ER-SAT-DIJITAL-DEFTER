# Yayın adayı kabul raporu — 11 Kasım 2026

## Karar

Tam uygulama kaynakları ve bağımsız sıfır kurulum teknik olarak doğrulandı. **Public yayına hazır onayı verilmedi:** MIT seçilmiş olsa da telif sahibi ve gerçek GitHub onay hesabı bekleniyor; son LICENSE/CODEOWNERS ve uzak koruma etkinleştirmesi tamamlanmadı. Push, gerçek PR, uzak depo değişikliği veya Public yayın yapılmadı.

## Kaynak ve davranış

Ana uygulamanın 37 runtime/statik dosyası ve 55 mevcut test/destek dosyası SHA256 eşleşir (92/92); dağıtım bildirimindeki lisans tamamlaması ayrı tutulur. [Eşdeğerlik matrisi](equivalence.md) ekran, API, domain ve test kapsamını gösterir; [hash kaydı](source-equivalence.json) karşılaştırmayı tekrar edilebilir kılar. Hiçbir aktif ekran veya finansal işlev yayın için çıkarılmadı.

Yeni geliştirme parçaları: taşınabilir ve rastgele parolalı isteğe bağlı seed/sandbox, ilk kurulum testleri, yayın/sözdizimi denetimi, CI ve katkı belgeleri. Normal npm start örnek hareket eklemez. Seed müşteri, satış/alış, sipariş avansı, çok birimli toptancı alışı/ödeme/tahsis/mahsup/iade ve sayım geçmişini yalnız yeni geçici dizinde kurar. Her başlatma yeni ortamdır; gerçek defteri sıfırlayan komut yoktur.

## Gerçek teknik sonuçlar

Windows, Node v24.15.0. Kaynak/test kesiti b62eb4e; sonraki 8ebed9d yalnız sentetik seed ve ona ait test kapsamını genişletir, runtime/UI kodu değişmez.

| Kontrol | Sonuç |
| --- | --- |
| Yeni yerel Git deposundan `git clone --no-local` | Başarılı; eski özel geçmiş yok |
| Temiz klonda `npm.cmd ci --ignore-scripts --no-bin-links` | exit 0, 39 paket; 0 audit bulgusu |
| Kaynak kopyasında `node --test --test-concurrency=2 test/*.test.mjs` | exit 0; 480 PASS / 0 FAIL / 1 opt-in SKIP |
| Temiz klonda belgelenen `npm.cmd test` | exit 0; 480 PASS / 0 FAIL / 1 opt-in SKIP |
| `npm.cmd run test:ui` | exit 0; 32 tekil betik + 71 Node alt test PASS |
| Temiz klonda bağımsız `npm.cmd run test:supplier-oracle` | exit 0; 22/22 PASS |
| Temiz klonda `node scripts/check-syntax.mjs` | exit 0; 132 JS dosyası |
| İlk kesit temiz klonda yayın taraması | exit 0; 164 dosya, 1 commit, 492 worktree/index/history kontrolü, 0 bulgu |
| Staged sahte sır negatif deneyi | Beklenen exit 1; index farkı yakalandı |
| Boş kurulum + taşınabilir seed testleri | Önce sabit yol RED; düzeltme sonrası 2/2 PASS |
| Genişletilmiş seed testi | Önce eksik müşteri RED; son seed 2/2 PASS |
| Şifreli pilot yol sınırı | RED sonrası 4/4 PASS |
| `npm.cmd run test:backup-pilot` | Resmî ve hash doğrulanmış Restic ile 37/37 PASS, exit 0 |
| PDF vendor lock ayrı npm audit | 74 bağımlılık; 0 bulgu, exit 0 |
| `git diff --check` | exit 0 |

Ayrı build/typecheck/lint scriptleri yok; PASS iddia edilmez. Coverage yüzdesi ölçülmedi. Tek atlanan test isteğe bağlı büyük PDF benchmark'ıdır; kaynak tamlığı veya zorunlu finansal regresyon yerine geçmez. Son seed değişikliği sonrası tüm backend/UI gereksiz yere tekrar edilmedi; etkilenen kurulum/seed testi tekrar edildi.

## Gerçek Computer Use kabulü

Bağımsız klon `npm start` ile ayrı loopback portunda ve yalnız yeni sentetik data/ ile açıldı. IAB gerçek arayüzde:

1. İlk yönetici oluşturma, sıfır eski kayıt ekranı ve tüm açılışların 0 girilmesi.
2. Yeni stok kartı, 10 adet stok girişi; 1 adet / 1000 TL satış; 1 adet / 100 TL müşteriden alış.
3. Yeni toptancı ve HAS hesabı; 5 çeyrek / 10 HAS borçlu alış.
4. 100 TL karşılığı 2 HAS ödeme; bunun 1 HAS kısmını alışa tahsis. Tahsis ikinci fiziksel ödeme oluşturmadı.
5. USD hesabı; 100 TL karşılığı 1 USD avans; kaynak izli 1 USD → 1 HAS manuel mahsup.
6. Kaynak alışa bağlı 1 çeyrek iadesi, 2 HAS belge düşümü ve 2 HAS cari alacak.
7. Ekstre; gerçek PDF ve CSV indirme. PDF 3 sayfa; ilk sayfa render edilerek Türkçe metin ve rakamlar incelendi.
8. 24 hesap sayımı ve ertesi iş gününe kapanış; günlük rapor görüntüleme.
9. Akışlı arşiv indirme, dosya seçimiyle geri yükleme; oturum iptali ve yeniden giriş.
10. Sıfır bakiyeli yeni müşteri oluşturma, son ana ekran kontrolü.

Son sentetik DB ayrıca salt okunur kontrol edildi: 16 olay, kasa 700 TL, çeyrek 4 adet, yeni ürün 10 adet, toptancı HAS −5, USD 0, müşteri 1, kapanış 1, restore arşivi 1. Ekran görüntüleri, indirilen çıktılar ve ham test logları yalnız yerel kanıt alanında tutulur; yayın paketine konmaz.

## Sınırlar

Bu sonuç mevcut bütün iş kurallarının her kombinasyonunun yeniden manuel sınandığı iddiası değildir. Sipariş/avans, çalışan rolleri, eski olay uyumu, mobil salt okunur API ve diğer kombinasyonlar mevcut otomatik regresyonlarla kapsanır. Gerçek telefon/ağ, fiziksel yazıcı, mağaza kabulü, bulut/elektrik kesintisi, RPO/RTO ve Windows dışı işletim sistemi doğrulanmadı. Native PDF indirme doğrulandı; yazıcı çıktısı iddiası yoktur.

GitHub fork/push/PR ve server-side owner onayı ancak yayın izni, depo ve hesap bilgileri tamamlanınca dış ortamda doğrulanabilir. [Koruma kontrol listesi](github-protection.md) hazırlanmıştır; dosya halinde öneri ile etkin GitHub ayarı ayrıdır.
