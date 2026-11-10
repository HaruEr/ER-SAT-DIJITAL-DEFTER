# Lisans kararı — yayın öncesi açık

**Henüz bir proje lisansı seçilmedi.** Bu belge seçenek sunar; kullanıcı adına hak tanımaz. Kodun yalnız görünür olması açık kaynak değiştirme ve yeniden dağıtma izni sağlamaz. GitHub'ın görüntüleme/fork koşulları geniş bir yazılım lisansının yerini tutmaz. [GitHub lisans açıklaması](https://choosealicense.com/no-permission/).

| Seçenek | Temel sonuç | Tercih nedeni / maliyet |
| --- | --- | --- |
| [MIT](https://choosealicense.com/licenses/mit/) | Telif ve lisans bildirimi korunarak ticari kullanım, değişiklik ve yeniden dağıtım; kapalı türevler mümkün | En sade katkı/kullanım koşulu; türevlerin kaynak paylaşmasını zorunlu tutmaz |
| [Apache-2.0](https://choosealicense.com/licenses/apache-2.0/) | İzin verici; açık patent lisansı, bildirim ve değişiklik koşulları; marka izni vermez | Patent hükümleri daha açık; MIT'den daha ayrıntılı yükümlülükler |
| [GPL-3.0](https://choosealicense.com/licenses/gpl-3.0/) | Dağıtılan türev/birleşik eserlerde aynı lisans ve karşılık gelen kaynak yükümlülükleri | Dağıtılan geliştirmelerin açık kalmasını hedefler; bazı entegrasyon modellerini sınırlar |
| [AGPL-3.0](https://choosealicense.com/licenses/agpl-3.0/) | GPL ailesine ek olarak değiştirilmiş ağ hizmetinde kullanıcıya kaynak sunma yükümlülüğü | Hizmet olarak sunulan değişikliklerde açıklık ister; dış benimseme ve uyumluluk değerlendirmesi daha ağırdır |

Karar sorusu: kapalı ticari türevlere izin verilmesi mi, dağıtılan geliştirmelerin açık kalması mı, ağ hizmeti değişikliklerinin de paylaşılması mı isteniyor? Bu karar telif sahibine aittir. Tam lisans metni ve kullanılan bileşenlerle uyumluluk karar öncesi değerlendirilmelidir.

## Ayrı haklar

- **Kod telifi:** Hak sahibi adı/unvanı ve başlangıç yılı doğrulanmalı; mevcut katkılardaki hak zinciri teyit edilmelidir. Bu belgede kişi veya şirket adına telif iddia edilmez.
- **Ürün adı/marka:** ER ŞAT DİJİTAL DEFTER adı ve mevcut arayüz kimliği korunur. Kod lisansı, marka/logo kullanım kapsamıyla aynı değildir. Marka varlıklarının dağıtım ve türev kullanım izni ayrıca açıklanmalı.
- **İşletme profili/verisi:** İşletme adı, adres, vergi/kimlik, müşteri ve mali kayıtlar kod lisansına dahil değildir; yayın paketine girmez.
- **Üçüncü taraflar:** PDF motoru, fontlar ve bağımlılıklar kendi lisanslarını korur. Proje lisansı onların bildirimlerini kaldırmaz. [Bileşen kaydı](third-party.md).

## Katkı politikası seçenekleri

**DCO 1.1:** Katkıcının katkıyı ilgili lisans altında sunma hakkı bulunduğunu tasdik eden süreçtir; tek başına telif devri veya proje lisansı değildir. Kabul edilirse `git commit -s` ve Signed-off-by denetimi açıkça belgelenir. Şu an zorunlu değildir. [DCO metni](https://developercertificate.org/).

**CLA:** Ayrı katkı sözleşmesiyle gerekli haklar tanımlanabilir; koşullarına göre lisans verme/yeniden lisanslama imkânı sağlayabilir. Katkıcıya ek işlem ve hukuki metin yönetimi getirir. Otomatik olarak telif devri anlamına gelmez; sözleşme metni belirleyicidir. Bu aday CLA dayatmaz.

Yayın öncesi: kullanıcı lisansı ve hak sahibini seçer, tam LICENSE eklenir, package metadata eşleştirilir, marka politikası ve katkı politikası netleştirilir, üçüncü taraf bildirimleri tamamlanır. Bu kapılar kapanmadan “açık kaynak yayına hazır” sonucu verilmez.
