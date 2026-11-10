# Yayın güvenliği incelemesi

11 Kasım 2026. Bu rapor kaynak yayınını değerlendirir; tam penetrasyon testi veya bütün kişisel verilerin yokluğuna matematiksel kanıt değildir.

## Veri ayrımı ve geçmiş

Yeni depo yalnız açık kaynak izin listesiyle kuruldu. Gerçek işletme veri alanları okunmadı ve kopyalanmadı. Önceki Git geçmişi aktarılmadı veya yeniden yazılmadı. Yayın paketi Git'in izlediği dosyalardan üretilir; test klonunda üretilen sentetik data/ ve indirmeler pakete girmez.

`scripts/release-check.mjs` çalışma ağacı, staged bloblar ve bütün erişilebilir commit ağaçlarını tarar: yasak veri yolları, SQLite imzası, yüksek belirginlikli anahtar/token/özel anahtar/IBAN ve kişisel Windows yolu desenleri. İçerik yerine yalnız dosya adı/bulgu türü raporlanır. Ayrı negatif deneyde temiz çalışma dosyasının altında index'te kalan sahte sır başarıyla reddedildi. Desen dışındaki müşteri adı gibi sıradan metinler otomatik garanti kapsamında değildir; izin listesi, kaynak incelemesi ve köken kontrolü birlikte kullanılır.

## Korunan sınırlar

- Editör loopback, Host/Origin ve proxy başlık denetimleri; korumalı API yollarında oturum/rol kontrolleri korunur. İlk kurulum ve giriş uçları kendi kimlik doğrulama kurallarını uygular.
- İlk yönetici tek sefer oluşturulur; sabit parola yoktur. Parolalar rastgele salt + scrypt ile saklanır. Yerel bilgisayardaki ilk kurulumu güvenilir sahibi yapmalıdır.
- Çalışan özel maliyetleri, toptancı yönetimini veya yönetici işlemlerini okuyup yazamaz. Onaylı sıfır bakiyeli müşteri ve perakende satış/alış istisnaları korunur.
- Mobil rapor DB ve HTTP yolları salt okunurdur; mevcut kimlik proxy'si ve açık etkinleştirme gereksinimi korunur.
- CSP, çıktı kaçışları, indirme biletleri, dosya boyutu sınırları, atomiklik, revision/duplicate ve geri yüklemede oturum iptali mevcut testlerde doğrulanır.
- CI yalnız hosted Windows, contents:read ve credentials saklamayan checkout kullanır. Sır, yayın, otomatik kabul veya ayrıcalıklı pull_request_target yoktur. GitHub korumaları dosya varlığından etkin sayılmaz.

## Bağımlılık ve lisans kaydı

Kilitli JSDOM kurulumu lifecycle betikleri olmadan yapıldı; npm audit 0 bulgu. PDF motorunun ayrı review-dependency-lock dosyası geçici inceleme paketinde ayrıca tarandı: 74 bağımlılık, 0 bilinen açık. Bu sonuç yalnız sorgu tarihindeki danışma veritabanı kapsamıdır; bundle'da hiç açık bulunamayacağı anlamına gelmez.

PDF/font kodu byte düzeyinde korunur. Fontkit, dfa ve brotli paketlerinin eksik MIT bildirimleri; Brotli decoder'ın Apache-2.0 ve pako'nun Zlib bildirimleri tamamlandı. Tam sürüm npm arşivleri vendor lock SHA512 değerleriyle karşılaştırıldı. Olmayan telif yılı uydurulmadı. Ayrıntılar dağıtılan THIRD-PARTY-NOTICES.txt içindedir.

## Açık yayın kapıları

MIT kullanıcı tarafından seçildi. Telif sahibi/yıl doğrulanıp LICENSE.template nihai LICENSE haline getirilmeli; gerçek GitHub sahibi CODEOWNERS'a yazılmalı. Marka/logo hakları kod lisansından ayrıdır. Uzak depo korumaları ve ilk Actions koşusu henüz uygulanmadı. Açık kaynak/Public yayın için ayrıca kullanıcı izni gerekir.
