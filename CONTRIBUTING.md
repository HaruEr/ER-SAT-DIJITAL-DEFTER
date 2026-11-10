# Katkı rehberi

Lisans ve depo koruma ayarları kesinleştikten sonra katkı akışı: **Fork → Clone → Branch → Develop → Test → Commit → kendi forkuna Push → Pull Request → depo sahibinin incelemesi → Kabul/Ret**. Kendi forkundaki değişiklikler resmî ana dala veya işletmenin defterine doğrudan uygulanmaz.

## Çalışma düzeni

1. Hata, özellik, mevcut özelliği değiştirme veya kaldırma önerisi için Issue açın. İşletme verisi, gerçek kimlik, parola veya yedek yüklemeyin.
2. Kendi forkunuza klonlayın; `git switch -c codex/kisa-aciklama` ile dal açın. Uygulama kurulumunu README üzerinden yapın.
3. Mevcut kaynak ve testleri inceleyin. Yeni davranış için önce anlamlı başarısız test, ardından düzeltme ve başarılı test kaydedin. Küçük metin değişikliği için gereksiz test altyapısı eklemeyin.
4. `npm.cmd test`, `npm.cmd run test:ui`, `npm.cmd run test:supplier-oracle`, `node scripts/check-syntax.mjs` ve `node scripts/release-check.mjs` çalıştırın. İlgisiz test atlandıysa gerekçesini açıkça yazın. UI değişikliğini gerçek tarayıcıda geniş/dar ekran ve klavye ile doğrulayın.
5. `git diff --check` ve `git diff` ile kapsamı inceleyin. Yalnız kaynak, test ve gerekli belgeleri commit edin. Yedek, SQLite, rapor, ekran görüntüsü veya günlük eklemeden önce içeriğin sentetik olduğunu kontrol edin.
6. Kendi forkunuza push edip ana depoya PR açın. Otomatik test başarısı kabul değildir; nihai karar depo sahibindedir.

## Mali ve güvenlik sınırları

Adet/gram/TL/döviz/HAS birimlerini, olay sürümlerini, revision/duplicate ve atomiklik kurallarını koruyun. Yeni kur, fiyat, saflık, maliyet veya muhasebe politikasını bir hata düzeltmesi içine gizlemeyin. Finansal değişiklikte eski ve yeni davranışı somut tutar/birim örnekleri ve bağımsız beklenen sonuçlarla test edin; eski olayların tekrar okunmasını ve yedek uyumunu sınayın. Hassas veri, kimlik veya yetki değişikliğinde bağımsız inceleme gereklidir.

Yeni HTTP yolunda kimlik, rol ve origin sınırlarını koruyun. Mobil API/DB salt okunur kalır. Bağımlılık eklemeden önce mevcut kodu değerlendirin; sabit sürüm, lockfile, kaynak ve lisans kaydı ekleyin. Kurulum lifecycle scriptlerini değerlendirmeden çalıştırmayın.

## PR'da zorunlu bilgiler

Amaç, etkilenen modüller, önceki/yeni davranış, varsa Issue, çalıştırılan tam komutlar ve exit/sonuçları, finansal etki, geriye dönük uyum, UI görüntüleri, atlanan kontroller ve açık riskler. PR şablonunu doldurun. Özelliği kaldırma önerileri kullanım ve veri geçişi etkisini ayrıca açıklamalıdır.

Kod için MIT seçilmiştir; telif sahibi/yılı doğrulanıp nihai `LICENSE` etkinleştirilmesi beklenmektedir. Katkı telifi katkıcıda kalabilir; katkının MIT altında sunulabildiği kabul öncesinde doğrulanmalıdır. DCO veya CLA şu an etkin değildir; [katkı politikası seçenekleri](docs/license-options.md) depo sahibi kararını bekler. Gerçek kişisel e-posta adreslerini kanıt dosyalarına eklemeyin; Git kimliğiniz için uygun gizlilik ayarını seçin.
