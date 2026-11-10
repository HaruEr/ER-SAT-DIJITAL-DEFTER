# Lisans kararı — MIT seçildi, hak sahibi bekleniyor

**Kullanıcı kod için MIT lisansını açıkça seçti.** ER ŞAT DİJİTAL DEFTER ürün adı korunacak; marka ve logo hakları ayrı tutulacak. Telif sahibi/yılı ve GitHub depo sahibi daha sonra doğrulanacak. `LICENSE.template` MIT metnini çözümlenmemiş `[COPYRIGHT_YEAR_PENDING]` ve `[COPYRIGHT_HOLDER_PENDING]` alanlarıyla içerir; nihai lisans bildirimi değildir. Hak sahibi bilgisi doğrulanınca bu alanlar doldurulup dosya `LICENSE` olarak etkinleştirilmelidir. Kullanıcı adına kişi, şirket veya yıl uydurulmaz.

GitHub'a push veya genel yayın yetkisi verilmedi. Kodun yalnız görünür olması açık kaynak değiştirme ve yeniden dağıtma izni sağlamaz; seçilmiş lisansın eksiksiz biçimde uygulanması gerekir. [GitHub lisans açıklaması](https://choosealicense.com/no-permission/).

Aşağıdaki karşılaştırma kararın bağlamını korur; yeni bir lisans seçimi talebi değildir.

| Seçenek | Temel sonuç | Tercih nedeni / maliyet |
| --- | --- | --- |
| [MIT](https://choosealicense.com/licenses/mit/) | Telif ve lisans bildirimi korunarak ticari kullanım, değişiklik ve yeniden dağıtım; kapalı türevler mümkün | En sade katkı/kullanım koşulu; türevlerin kaynak paylaşmasını zorunlu tutmaz |
| [Apache-2.0](https://choosealicense.com/licenses/apache-2.0/) | İzin verici; açık patent lisansı, bildirim ve değişiklik koşulları; marka izni vermez | Patent hükümleri daha açık; MIT'den daha ayrıntılı yükümlülükler |
| [GPL-3.0](https://choosealicense.com/licenses/gpl-3.0/) | Dağıtılan türev/birleşik eserlerde aynı lisans ve karşılık gelen kaynak yükümlülükleri | Dağıtılan geliştirmelerin açık kalmasını hedefler; bazı entegrasyon modellerini sınırlar |
| [AGPL-3.0](https://choosealicense.com/licenses/agpl-3.0/) | GPL ailesine ek olarak değiştirilmiş ağ hizmetinde kullanıcıya kaynak sunma yükümlülüğü | Hizmet olarak sunulan değişikliklerde açıklık ister; dış benimseme ve uyumluluk değerlendirmesi daha ağırdır |

MIT tercihi, telif ve lisans bildirimi koşullarıyla kapalı ticari türevlere de izin veren yaklaşımı seçer. Tam metin `LICENSE.template` içindedir. Üçüncü taraf bileşenler kendi lisanslarına tabi kalır.

## Ayrı haklar

- **Kod telifi:** Hak sahibi adı/unvanı ve başlangıç yılı doğrulanmalı; mevcut katkılardaki hak zinciri teyit edilmelidir. Bu belgede kişi veya şirket adına telif iddia edilmez.
- **Ürün adı/marka:** ER ŞAT DİJİTAL DEFTER adı ve mevcut arayüz kimliği korunur. Kod lisansı, marka/logo kullanım kapsamıyla aynı değildir. Marka varlıklarının dağıtım ve türev kullanım izni ayrıca açıklanmalı.
- **İşletme profili/verisi:** İşletme adı, adres, vergi/kimlik, müşteri ve mali kayıtlar kod lisansına dahil değildir; yayın paketine girmez.
- **Üçüncü taraflar:** PDF motoru, fontlar ve bağımlılıklar kendi lisanslarını korur. Proje lisansı onların bildirimlerini kaldırmaz. [Bileşen kaydı](third-party.md).

## Katkı politikası seçenekleri

**DCO 1.1:** Katkıcının katkıyı ilgili lisans altında sunma hakkı bulunduğunu tasdik eden süreçtir; tek başına telif devri veya proje lisansı değildir. Kabul edilirse `git commit -s` ve Signed-off-by denetimi açıkça belgelenir. Şu an zorunlu değildir. [DCO metni](https://developercertificate.org/).

**CLA:** Ayrı katkı sözleşmesiyle gerekli haklar tanımlanabilir; koşullarına göre lisans verme/yeniden lisanslama imkânı sağlayabilir. Katkıcıya ek işlem ve hukuki metin yönetimi getirir. Otomatik olarak telif devri anlamına gelmez; sözleşme metni belirleyicidir. Bu aday CLA dayatmaz.

Yayın öncesi kalanlar: hak sahibi ve telif yılı doğrulanır, taslak alanları doldurulup tam `LICENSE` etkinleştirilir, package metadata eşleştirilir, marka politikası ve katkı politikası netleştirilir; GitHub sahibi ve ayrı yayın onayı alınır. Bu kapılar kapanmadan “açık kaynak yayına hazır” sonucu verilmez.
