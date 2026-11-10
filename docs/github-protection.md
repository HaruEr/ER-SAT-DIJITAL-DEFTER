# GitHub yayın ve depo koruma kapıları

**Durum: yerel yapılandırma önerisi. GitHub'da etkinleştirilmedi.** Uzak depo URL'si, sahibi, görünürlüğü ve planı doğrulanmış değildir. Yayın/push için ayrıca kullanıcı onayı gerekir. Aşağıdaki kutular kanıtla doldurulmadan uygulanmış sayılmaz.

## Yayın öncesi

- [ ] Tam aktif kaynak/eşdeğerlik ve temiz klon kabul raporları incelendi; eksik veya başarısız modül yok.
- [ ] Yayın dosya listesi, içerikler ve yeni Git geçmişi tarandı; gerçek veri/kimlik/sır yok. Eski özel geçmiş kopyalanmadı.
- [ ] Kullanıcı kod lisansı, telif sahibi ve marka/varlık haklarını seçti; tam LICENSE ve gerekli üçüncü taraf bildirimleri var.
- [ ] GitHub sahibi ve hedef depo açıkça doğrulandı; kullanıcı somut yayın kesitini onayladı.
- [ ] `.github/CODEOWNERS` içindeki yorum örnekleri gerçek sahibiyle etkin satırlara çevrildi; GitHub syntax/erişim denetimi geçti.

## Ana dal ayarı

GitHub planına ve depo türüne göre branch protection veya ruleset kullanılabilir. Public depolarda GitHub Free ile branch protection ve CODEOWNERS mümkündür; private depo koşulları plana göre değişir. Bu olanağın hesabınızda etkin olması ayrıca denetlenmelidir. [Resmî koruma belgesi](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

`main` için önerilen somut ayarlar:

- [ ] Birleştirme öncesi PR zorunlu.
- [ ] En az **1 onay** ve **Code Owner review** zorunlu. `*` dahil tüm kurallar yalnız gerçek depo sahibine bağlanır; finansal dosyalar ayrıca görünür biçimde listelenir.
- [ ] Yeni commit gelince eski onaylar düşürülür; son incelenebilir push için bağımsız onay aranır.
- [ ] Gerekli status check: **windows-tests**. İlk gerçek koşudan sonra GitHub'ın gösterdiği tam check adı/App doğrulanıp seçilir; dosyada job adının bulunması yeterli değildir.
- [ ] Açık review konuşmaları çözülmeden merge yok.
- [ ] Force push ve ana dal silme kapalı.
- [ ] Yönetici/bypass istisnaları kapalı; dış katkıcılara write/maintain/admin rolü verilmez.
- [ ] Desteklenen hesap türünde push yapabilen hesaplar depo sahibiyle sınırlandırılır; doğrudan push PR kuralı nedeniyle yine reddedilir.
- [ ] Otomatik merge kapalı; dış katkıcı PR'ı yalnız depo sahibinin kabulünden sonra birleştirilir.

Birden fazla Code Owner yazmak tümünün onayı demek değildir; herhangi birinin onayı yeterli olabilir. Bu nedenle sahibin zorunlu onayını başka ekip ismiyle gevşetmeyin. PR yazarı kendi PR'ını onaylayamaz; sahibin kendi değişiklikleri için ek yetkili inceleyici veya ayrıca kararlaştırılmış süreç gerekir. [CODEOWNERS davranışı](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

## CI ve güvenlik ayarları

Workflow yalnız `pull_request`, `push main` ve manuel dispatch kullanır. GitHub hosted Windows runner, salt okunur contents token, `persist-credentials: false`, sır içermeyen sentetik testler; yayın veya merge adımı yoktur. Dış PR için işletme bilgisayarı self-hosted runner olarak bağlanmaz. Fork workflow onay politikası dış kod çalıştırmadan önce gözden geçirilir. CI kodu PR içinde değiştirilebilir; CI değişiklikleri dahil tüm dosyalarda sahibi review'u önemlidir.

Checkout v4.2.2 ve setup-node v4.4.0 tam commit SHA'ları 11 Kasım 2026'da resmî depoların tag referanslarına karşı `git ls-remote` ile doğrulandı. Bunlar bilinçli sabit pinlerdir; “en yeni sürüm” iddiası değildir. Güncelleme değişiklik/güvenlik incelemesiyle yapılır. [Checkout sürümü](https://github.com/actions/checkout/releases/tag/v4.2.2), [setup-node sürümü](https://github.com/actions/setup-node/releases/tag/v4.4.0), [GitHub güvenli kullanım](https://docs.github.com/en/actions/reference/security/secure-use).

- [ ] Private vulnerability reporting etkin; SECURITY.md'deki yol gerçek depoda denendi.
- [ ] Uygun planda secret scanning/push protection etkin; yoksa sınır açık yazıldı.
- [ ] Dependency graph/uyarılar ve bağımlılık değişiklik incelemesi etkinliği kontrol edildi.
- [ ] Dış PR üzerinde CI gerçekten çalıştı; fail olan PR merge edilemedi.
- [ ] Sahip onayı olmadan bir dış PR merge edilemedi; doğrudan push/force push/silme reddi kontrollü denendi.

Son dört kontrol yerel YAML veya Markdown ile kanıtlanamaz. Uzak işlem onayından sonra gerçek GitHub ayar/koşu kayıtları gerekir. Bu hazırlık sırasında depo oluşturma, push, PR veya ayar değişikliği yapılmaz.
