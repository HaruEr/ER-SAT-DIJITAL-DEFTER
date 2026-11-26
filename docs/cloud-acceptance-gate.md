# ER ŞAT Dijital Defter — Adım 10: 20 Maddelik Üretim Kabul Kapısı

Bu belge, **Adım 11 (Sıfırdan Temiz Üretime Geçiş)** öncesinde **Adım 8–9** pilot ortamının ve **temiz 2. Test VPS** felaket kurtarma tatbikatının geçmesi gereken **20 zorunlu kabul maddesini** tanımlar.

> **Güvenlik Sınırı:** Bu belgeye gerçek IP adresi, alan adı sırrı, parola, PIN, JWT veya API anahtarı yazmayın; yalnızca `GEÇTİ / KALDI`, tarih ve maskelenmiş ölçüm özeti kaydedin.

---

## A. Altyapı, Ağ ve Sıfır Açık Port (Madde 1–4)

| # | Kabul Kriteri | Doğrulama Yöntemi | Beklenen Sonuç | Durum |
|---|---|---|---|---|
| 1 | **UFW 0 Açık Gelen Port** | `sudo ufw status verbose` + dışarıdan port kontrolü | `Default: deny (incoming)`, gelen açık port `0` | [ ] |
| 2 | **Servis & Dizin İzinleri** | `ls -ld /var/lib/er-sat-defter /var/backups/er-sat-defter /etc/er-sat-defter/*.env` | `er-sat:er-sat`, veri/yedek `0700`, `.env` dosyaları `0600` | [ ] |
| 3 | **Systemd & `/healthz` Canlılığı** | `systemctl is-active er-sat-defter er-sat-reports cloudflared` + `curl -fsS http://127.0.0.1:4317/healthz` | 3 servis `active`, loopback `/healthz` `200 OK` | [ ] |
| 4 | **Hetzner Snapshot Kapalı** | Hetzner Cloud konsol kontrolü | Otomatik VPS snapshot kapalı (yedek yalnızca şifreli R2 + yerel PC) | [ ] |

---

## B. Kanal İzolasyonu ve Canlı Güvenlik Red Testleri (Madde 5–11)

| # | Kabul Kriteri | Doğrulama Yöntemi | Beklenen Sonuç | Durum |
|---|---|---|---|---|
| 5 | **Mağaza Dışı IP → `kasa` Reddi** | Mağaza dışı ağdan (ör. mobil veri) `https://kasa.<alanadi>/` | `403` (Cloudflare WAF veya `STORE_ALLOWED_IPS` reddi) | [ ] |
| 6 | **`kasa` → Yönetici/Toptancı Uçları Reddi** | Mağaza IP'sinden `kasa` üzerinden `/owner`, `/users`, `/api/suppliers`, `/api/backup`, `/api/security/audit` | `403` veya `404` | [ ] |
| 7 | **`kasa` → Yönetici PIN Reddi** | `kasa` ekranında `owner` kullanıcısı ile giriş denemesi | `403` (yalnız `employee` girişi kabul edilir) | [ ] |
| 8 | **Sahte / Süresi Dolmuş JWT Reddi** | `yonetim` ve `rapor` kanallarına geçersiz `Cf-Access-Jwt-Assertion` | `403` | [ ] |
| 9 | **`rapor` Salt Okunur Sınırı** | `rapor` kanalına `POST`/`PUT`/`DELETE` denemesi + `PRAGMA query_only=ON` kontrolü | `405` / `403` (yazma tamamen kapalı) | [ ] |
| 10 | **Kademeli PIN Kilidi** | 5, 10, 15 hatalı PIN denemesi | `60 sn` → `5 dk` → `15 dk` kademeli kilit + `auth_audit_log` kaydı | [ ] |
| 11 | **Acil Yerel PIN Sıfırlama** | Sunucuda `scripts/reset-owner-pin.mjs --must-change-pin` | Kilitler temizlenir, eski oturumlar `401` olur, yeni PIN zorlanır | [ ] |

---

## C. Bağımsız Yedekleme, Bucket Lock ve Yerel 3. Kopya (Madde 12–16)

| # | Kabul Kriteri | Doğrulama Yöntemi | Beklenen Sonuç | Durum |
|---|---|---|---|---|
| 12 | **10 dk RPO Otomatik Yedek** | `systemctl list-timers er-sat-backup.timer` + `journalctl -u er-sat-backup.service` | Her 10 dk'da `.enc` + R2 `restic` başarılı | [ ] |
| 13 | **R2 `backup-writer` Silme Reddi** | `backup-writer` anahtarıyla R2 nesnesi silme / `restic forget --prune` denemesi | **`403 AccessDenied`** (append-only + Bucket Lock kanıtı) | [ ] |
| 14 | **Mağaza PC Yerel 3. Kopya (`$0` Egress)** | Mağaza PC'de `pull-and-verify-r2.ps1` çalıştırma | `C:\er-sat-backups\er-sat-backup-*.enc` iner, `restore` `"ok": true` | [ ] |
| 15 | **Mağaza PC NTFS Kilidi** | Standart Windows çalışan hesabıyla `C:\er-sat-backups` açma/silme denemesi | Erişim engellendi (`Access Denied`) | [ ] |
| 16 | **Çift Kanallı İzleme Alarmları** | Healthchecks.io gecikme testi + UptimeRobot kesinti testi | Telegram ve E-posta uyarıları ≤ 15 dk içinde ulaşır | [ ] |

---

## D. Temiz 2. Test VPS Felaket Kurtarma (DR) Tatbikatı (Madde 17–20)

| # | Kabul Kriteri | Doğrulama Yöntemi | Beklenen Sonuç | Durum |
|---|---|---|---|---|
| 17 | **Sıfırdan 2. Test VPS Kurulumu** | Yalnızca R2 yedeği + şifreleme parolalarıyla temiz Ubuntu 24.04 VPS kurulumu | Uygulama ve veritabanları sıfırdan ayağa kalkar | [ ] |
| 18 | **Ölçülmüş RPO ≤ 15 dk ve RTO ≤ 4 saat** | Son sentetik işlem zamanı ↔ kurtarılan kayıt farkı (RPO) ve toplam kurtarma süresi (RTO) | `RPO ≤ 15 dk` ve `RTO ≤ 4 saat` (hedef ≤ 60 dk) | [ ] |
| 19 | **Geri Yükleme Sonrası Oturum İptali** | Eski pilot oturum çerezi/token'ı ile 2. VPS'e istek | `401` (`session_generation` döndürülmüş) | [ ] |
| 20 | **Tam Bakiye ve 7 Kullanıcı Mutabakatı** | `backup-bundle.mjs restore` `reconciliations` + sentetik kasa/stok/cari/toptancı karşılaştırması | Kuruşu kuruşuna / miligramı miligramına `0` sapma | [ ] |

---

## Tatbikat Onay Kaydı
- **Tatbikat Tarihi:** `YYYY-AA-GG`
- **Ölçülen RPO:** `___ dk`
- **Ölçülen RTO:** `___ dk`
- **Sonuç:** `[ ] 20/20 GEÇTİ — Adım 11'e geçiş onaylandı` / `[ ] EKSİK VAR`
