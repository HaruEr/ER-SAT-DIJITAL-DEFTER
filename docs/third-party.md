# Üçüncü taraf kaynakları

Bu adayda mevcut PDF motoru/font kaynakları korunur; yeni UI paketi eklenmez.

| Bileşen | Kaynak/sürüm | Hak bildirimi | Kullanım |
| --- | --- | --- | --- |
| pdfmake | [Bartek Pampuch / pdfmake 0.2.23](https://github.com/bpampuch/pdfmake/tree/0.2.23) | `public/vendor/pdfmake/LICENSE` (MIT) | Yerel tarayıcı PDF üretimi; ağdan kod yüklenmez |
| Roboto | [Roboto Classic](https://github.com/googlefonts/roboto-classic), mevcut gömülü font | `public/vendor/pdfmake/Roboto-OFL.txt` (SIL OFL 1.1) | PDF Türkçe karakter ve metin desteği |
| PDF geçişli bileşenleri | `public/vendor/pdfmake/review-dependency-lock.json` | `public/vendor/pdfmake/THIRD-PARTY-NOTICES.txt` | Gömülü dağıtımın bildirim envanteri; incelemede saptanan eksik metinler tamamlandı |
| JSDOM | `package-lock.json` ile sabit 26.1.0 | Npm paketindeki lisans ve geçişli paket bildirimleri | Yalnız geliştirici/UI testi; kurulum `npm ci --ignore-scripts` |

Kaynakların bu yayın adayına alınma inceleme tarihi: 11 Kasım 2026. Önceki kaynakların ilk indirilme tarihi bu belgeyle yeniden iddia edilmez. PDF dosyaları ve bildirimleri birlikte tutulmalıdır. Paket lockfile'ları sürüm/integrity izlenebilirliği sağlar; tek başına lisans tamlığı veya güncel güvenlik garantisi değildir. Yeni bağımlılıkta kaynak, yazar, sürüm, lisans ve değişiklik kaydı eklenmelidir.

Proje kodu için MIT seçimi bu bileşenlerin lisanslarını veya marka/font koşullarını değiştirmez. Yayın incelemesindeki kök ve vendor npm audit sonuçları bilinen açık sayısını sıfır gösterdi; bu sonuç inceleme tarihine aittir, gelecekteki açıklar için garanti değildir.
