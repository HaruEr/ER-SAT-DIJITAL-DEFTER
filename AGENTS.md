# ER ŞAT DİJİTAL DEFTER — Proje Ajan Kuralları

## 0. Ürün Vizyonu ve Geliştirme Özgürlüğü
- **Ürün Vizyonu:** Kullanımı mümkün olduğunca kolay, modern, estetik, hızlı, kapsamlı ve finansal açıdan sarsılmaz güvenilirlikte bir kuyumcu yazılımı geliştirmek.
- **Değişim Özgürlüğü:** Mevcut teknoloji, mimari, kullanıcı arayüzü veya finansal işleyişin değiştirilemez olduğunu varsayma. Daha iyi alternatifler araştırılabilir, önerilebilir ve doğrulanarak geliştirilebilir.
- **Kırmızı Çizgiler:** Güvenlik ve veri bütünlüğü hiçbir geliştirme veya performans iyileştirmesi uğruna zayıflatılamaz.
- **Finansal Politika Değişiklikleri:** Hesaplama formülleri, birim/kur davranışı veya cari/stok iş kurallarını değiştiren kararlar; açık işletme kararı, etki analizi, geriye dönük uyumluluk ve bağımsız hesap doğrulaması gerektirir.

## 1. Veri ve Ortam Güvenliği (Zorunlu)
- Gerçek işletme verisi (`data/`, `.local/`, kullanıcı yedekleri, canlı `*.sqlite`) üzerinde asla okuma, yazma, silme veya test çalıştırma.
- Test ve sandbox komutlarını çalıştırmadan önce `TEMP`, `TMP` ve `npm_config_cache` değişkenlerini depo dışındaki izole bir kardeş klasöre yönlendir.
- Git geçmişine veya izlenen dosyalara sır, kişisel veri veya kimlik dosyası ekleme. Yeni kurulumda hazır yönetici parolası veya otomatik örnek işlem üretme.

## 2. Mali Doğruluk, Veri Bütünlüğü ve Eski Olay Uyumluluğu (Zorunlu)
- **Tam Sayı Aritmetiği:** Tüm miktar ve tutarları `domain.mjs` `UNITS` ölçeklerinde (`ADET=1`, `GRAM/HAS/SILVER=1000`, `TL/Döviz=100`) güvenli tam sayı (`<= 1e12`) olarak işle; parasal hesaplarda kayan nokta yuvarlaması kullanma.
- **Birim İzolasyonu:** Farklı birimleri (`HAS`, `TL`, `USD`, `EUR`, `SILVER`) örtük veya otomatik kurla birleştirme; dönüşüm/mahsup yalnızca açık işletme/kullanıcı girdisi ve kayıtlı olayla yapılmalıdır.
- **Append-Only ve Eski Kayıt Uyumluluğu:** `events` tablosundaki geçmiş olayları mutasyonla değiştirme. Yeni özellik veya şema eklerken eski olayların `replay()`, `restore` ve `restoreArchive` ile bozulmadan yeniden oynatılabilir kalmasını sağla.
- **Değişmezler:** `kind === 'asset'` bakiyeleri işlem sonunda negatif olamaz; `inventoryReserved` toplam stoğu aşamaz; tüm yazma uçlarında `revision` (`409`) ve `id` idempotency kontrollerini koru.
- **Toptancı Yazma Kapısı:** Toptancı hesaplarına (`supplierFirms` / `supplier-unit-*`) yalnızca `supplier*` komutlarıyla yaz; genel perakende rotalarının toptancı hesaplarına yazmasını engellemeye devam et.

## 3. Güvenlik ve Erişim Sınırları (Zorunlu)
- Yetkilendirme, oturum (`scrypt`, `invalidateSessions`), `employee` rol kısıtları (`editor-access.mjs`), loopback/Origin kontrolleri ve `report-server.mjs` salt okunur sınırını (`GET`, `query_only=ON`) zayıflatma.
- Geri yükleme (`restore` / `restoreArchive`) öncesinde aktif oturumların iptal edilmesini koru.
- İstemci arayüzünde CSP (`style-src 'self'`, `script-src 'self'`) uyumluluğunu koru; `'unsafe-inline'` veya satır içi stil/betik ekleme.

## 4. Risk Temelli Test ve Doğrulama Politikası
- **Kapsamı Etkiye Göre Belirle:**
  - *Belge ve yalnız biçimsel değişiklikler:* İlgili sözdizimi/yayın/biçim kontrollerini (`node scripts/check-syntax.mjs`, `node scripts/release-check.mjs`, `git diff --check`) kullan.
  - *UI değişiklikleri:* İlgili UI testlerini (`npm run test:ui` / `qa-temp/*-smoke.mjs`) ve gerektiğinde `sandbox` + gerçek tarayıcı doğrulamasını yap. JSDOM eksikliği testlerin kalıcı olarak atlanması için kabul edilebilir gerekçe değildir; kilitli bağımlılıkları (`npm ci --ignore-scripts`) kurarak çalıştır.
  - *Finansal çekirdek, güvenlik, veri modeli ve olay sözleşmesi değişiklikleri:* Kapsamlı regresyon (`npm test`) ve bağımsız mali doğrulama (`npm run test:supplier-oracle`, gerektiğinde `test:recovery`) uygula.
  - *Pull Request öncesi:* Gerekli tam CI kontrollerini (`check:release`, `check:syntax`, `npm test`, `test:ui`, `test:supplier-oracle`, yeni bağımlılık varsa `npm audit --audit-level=high`, `git diff --check`) gerçekleştir.
- **Şeffaf Raporlama:** Test başarısızlığını sonraki başarılı koşumla gizleme; her iki sonucu, çıkış kodlarını ve olası nedeni açıkça kaydet.
