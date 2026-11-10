# Güvenlik

Bu yerel yayın adayında resmî destek süresi veya güvenlik yanıt SLA'sı ilan edilmemiştir. Son kabul raporu dışındaki sürümler için test sonucu varsaymayın.

## Açık bildirme

Güvenlik açığına ait istismar ayrıntılarını, gerçek defter kayıtlarını, veritabanını, parolayı veya tokenı açık Issue/PR'a göndermeyin. Yayın sırasında depo sahibi GitHub **Private vulnerability reporting** özelliğini etkinleştirmelidir. Etkin olduğunda deponun Security → Advisories → Report a vulnerability yolunu kullanın. Bu adayda uzak depo ve özel bildirim kanalının etkinliği doğrulanmış değildir; düğme yoksa önce depo sahibinden özel kanal isteyin, kamuya açık ayrıntı paylaşmayın.

Bildirimde etkilenen commit, sentetik yeniden üretim, rol/yetki koşulları, beklenen/gerçek davranış ve olası mali etki bulunsun. Gerçek veriyle kanıt üretmeyin.

## Çalıştırma sınırı

Ana editör yalnız `127.0.0.1` üzerinden yerel kullanıma uygundur. İnternete reverse proxy ile açmayın. Mobil okuyucu ayrı kimlikli özel HTTPS proxy gerektirir ve yazma API'si sağlamaz. Parolalar için sabit başlangıç hesabı yoktur. Dosya ve işletim sistemi erişimi olan saldırgana karşı uygulama oturumu tek başına koruma değildir.

PR CI'si yalnız GitHub hosted geçici runner, salt okunur token ve sentetik veriler kullanır. Üretim sırrı, self-hosted işletme bilgisayarı veya ayrıcalıklı yayın ortamı dış PR'a verilmez. `pull_request_target` ile katkıcı kodu çalıştırılmaz. Tarama sonuçları bütün olası sırları yakalama garantisi değildir; dosya ve yayın geçmişi incelemesi sürdürülmelidir.

[GitHub özel bildirim belgesi](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) · [Actions güvenli kullanım](https://docs.github.com/en/actions/reference/security/secure-use)
