# GitHub yayın ve depo koruma kapıları

**Durum: yerel yapılandırma önerisi. GitHub'da etkinleştirilmedi.** Uzak depo URL'si, sahibi, görünürlüğü ve planı doğrulanmış değildir. Yayın/push için ayrıca kullanıcı onayı gerekir. Aşağıdaki kutular kanıtla doldurulmadan uygulanmış sayılmaz.

## Yayın öncesi

- [ ] Tam aktif kaynak/eşdeğerlik ve temiz klon kabul raporları incelendi; eksik veya başarısız modül yok.
- [ ] Yayın dosya listesi, içerikler ve yeni Git geçmişi tarandı; gerçek veri/kimlik/sır yok. Eski özel geçmiş kopyalanmadı.
- [ ] Kullanıcı kod lisansı, telif sahibi ve marka/varlık haklarını seçti; tam LICENSE ve gerekli üçüncü taraf bildirimleri var.
- [ ] GitHub sahibi ve hedef depo açıkça doğrulandı; kullanıcı somut yayın kesitini onayladı.
- [x] Yerel `.github/CODEOWNERS` tek etkin kuralı `* @HaruEr`; finansal çekirdek, DB, kimlik/yetki, Actions ve CODEOWNERS dahil bütün dosyaları kapsar. Konum ve yerel sözdizimi doğrulandı.
- [ ] Gerçek depoda HaruEr write erişimi, CODEOWNERS dosyasının PR hedef dalında bulunması ve GitHub parser sonucu doğrulandı.

## Ana dal ayarı

GitHub planına ve depo türüne göre branch protection veya ruleset kullanılabilir. Public depolarda GitHub Free ile branch protection ve CODEOWNERS mümkündür; private depo koşulları plana göre değişir. Bu olanağın hesabınızda etkin olması ayrıca denetlenmelidir. [Resmî koruma belgesi](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

`main` için önerilen somut ayarlar:

- [ ] Birleştirme öncesi PR zorunlu.
- [ ] En az **1 onay** ve **Code Owner review** zorunlu. Tek `* @HaruEr` kuralı bütün dosyaları kapsar; sonradan eklenen kural bu sahipliği geçersiz kılmamalı. Dış katkıcı değişiklikleri HaruEr onayı olmadan resmî ana dala birleştirilememeli.
- [ ] Yeni commit gelince eski onaylar düşürülür; son incelenebilir push için bağımsız onay aranır.
- [ ] Gerekli status check: **windows-tests**. İlk gerçek koşudan sonra GitHub'ın gösterdiği tam check adı/App doğrulanıp seçilir; dosyada job adının bulunması yeterli değildir.
- [ ] Açık review konuşmaları çözülmeden merge yok.
- [ ] Force push ve ana dal silme kapalı.
- [ ] Ruleset enforcement Active ve bypass listesi boş veya klasik korumada yöneticiler dahil bypass engeli etkin. Yönetici/bypass istisnaları kapalı; dış katkıcılara write/maintain/admin rolü verilmez.
- [ ] Desteklenen hesap türünde push yapabilen hesaplar HaruEr ile sınırlandırılır; doğrudan push PR kuralı nedeniyle yine reddedilir.
- [ ] Otomatik merge kapalı; dış katkıcı PR'ı yalnız depo sahibinin kabulünden sonra birleştirilir.

Birden fazla Code Owner yazmak tümünün onayı demek değildir; herhangi birinin onayı yeterli olabilir. Bu nedenle sahibin zorunlu onayını başka ekip ismiyle gevşetmeyin. PR yazarı kendi PR'ını onaylayamaz; HaruEr kendi PR'ında tek zorunlu kod sahibi olarak kendini onaylayamaz. Bu durumda merge engelli kalır; kullanıcı ayrıca süreç kararı vermeden ikinci sahip veya bypass eklenmez. [CODEOWNERS davranışı](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

## CI ve güvenlik ayarları

Workflow yalnız `pull_request`, `push main` ve manuel dispatch kullanır. GitHub hosted Windows runner, salt okunur contents token, `persist-credentials: false`, sır içermeyen sentetik testler; yayın veya merge adımı yoktur. Dış PR için işletme bilgisayarı self-hosted runner olarak bağlanmaz. Fork workflow onay politikası dış kod çalıştırmadan önce gözden geçirilir. CI kodu PR içinde değiştirilebilir; CI değişiklikleri dahil tüm dosyalarda sahibi review'u önemlidir.

Checkout v4.2.2 ve setup-node v4.4.0 tam commit SHA'ları 11 Kasım 2026'da resmî depoların tag referanslarına karşı `git ls-remote` ile doğrulandı. Bunlar bilinçli sabit pinlerdir; “en yeni sürüm” iddiası değildir. Güncelleme değişiklik/güvenlik incelemesiyle yapılır. [Checkout sürümü](https://github.com/actions/checkout/releases/tag/v4.2.2), [setup-node sürümü](https://github.com/actions/setup-node/releases/tag/v4.4.0), [GitHub güvenli kullanım](https://docs.github.com/en/actions/reference/security/secure-use).

- [ ] Private vulnerability reporting etkin; SECURITY.md'deki yol gerçek depoda denendi.
- [ ] Uygun planda secret scanning/push protection etkin; yoksa sınır açık yazıldı.
- [ ] Dependency graph/uyarılar ve bağımlılık değişiklik incelemesi etkinliği kontrol edildi.
- [ ] Dış PR üzerinde CI gerçekten çalıştı; fail olan PR merge edilemedi.
- [ ] Sahip onayı olmadan bir dış PR merge edilemedi; doğrudan push/force push/silme reddi kontrollü denendi.

Otomatik inceleme isteği atanması teknik merge engeli değildir. Plan veya ruleset özellikleri hedefi karşılamıyorsa yayın kapısı açık kalır. Başarılı CI olup HaruEr onayı olmayan dış PR, onay sonrası değişen PR ve başarısız CI içeren PR için ret davranışı ayrı doğrulanır.

Uzak kontroller yerel YAML veya Markdown ile kanıtlanamaz. Uzak işlem onayından sonra gerçek GitHub ayar/koşu kayıtları gerekir. Bu hazırlık sırasında depo oluşturma, push, PR veya ayar değişikliği yapılmaz.
