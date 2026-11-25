# ER ŞAT Dijital Defter — Bulut Hazırlık Kararları ve Adım 8–11 Yol Haritası

Bu belge, `feat/cloud-phase1-data-safety` dalında tamamlanan Faz 0–3 mühendislik çalışmalarını, kesinleşen altyapı/maliyet kararlarını, bağımsız QA bulgularını ve sıradaki **Adım 8–11** (Sentetik Bulut Pilotu → Bağımsız Yedekleme → RPO/RTO Kabulü → Kontrollü Üretime Geçiş) yol haritasını özetler.

> **Güvenlik Sınırı:** Bu belge yalnızca mimari kararları ve teknik özeti içerir; canlı veri, parola, PIN, API anahtarı veya gerçek IP adresi barındırmaz.

---

## 1. Kesinleşen Nihai Mimari ve Maliyet Kararı (Adım 7)

**Seçilen Mimari:** Bulut merkezli tek yazma kaynağı (**Hetzner CX33**) + **Cloudflare** (Tunnel + Zero Trust Access + DNS/SSL/WAF + R2 EU) + **Mağaza Windows PC** yerel şifreli kopya + bağımsız izleme.

| Bileşen | Seçilen Sağlayıcı / Yapı | Özellikler | Tahmini Aylık Maliyet |
|---|---|---|---|
| **Ana Sunucu (VPS)** | **Hetzner Cloud `CX33`** (Almanya — Falkenstein/Nuremberg) | 4 vCPU, 8 GB RAM, 80 GB NVMe, Ubuntu 24.04 LTS, **0 açık gelen port** (`cloudflared` outbound tünel), Hetzner snapshot kapalı | **€8,49 / ay** (~350–380 TL) |
| **Tunnel + Zero Trust Access + DNS/WAF** | **Cloudflare Free / Zero Trust Free** | 50 kullanıcıya kadar ücretsiz; `yonetim` ve `rapor` için `RS256` JWT doğrulaması, ER ŞAT web sitesinden (Pages) ayrı erişim politikaları | **0 TL** |
| **Bağımsız Bulut Yedeği** | **Cloudflare R2 (EU)** | İlk 10 GB ücretsiz, `$0,015/GB/ay`, **$0 egress**, **Bucket Locks** + ayrı append-only Restic anahtarı | **~0 – 25 TL / ay** |
| **3. Veri Kopyası (Yerel)** | **Mağaza Windows PC** | R2'den periyodik otomatik şifreli çekme (`rclone` / `restic`, `$0` egress) — Cloudflare hesabından bağımsız kurtarma güvencesi | **0 TL** |
| **Mağaza Çalışan Erişimi (`store-checkout`)** | **ISP Statik IP + Cloudflare Tunnel** | `kasa.<alanadiniz>` → `cf-connecting-ip` ∈ `STORE_ALLOWED_IPS` + `x-store-proxy-secret` çift kilidi (çalışan telefonuna VPN kurulumu yok) | **~100 – 200 TL / ay** (ISP) |
| **Bağımsız İzleme & Alarm** | **Healthchecks.io** (RPO) + **UptimeRobot / Better Stack** (`/healthz`) | Telegram + E-posta çift kanallı uyarı (yedekleme hatası `/healthz` canlılığını etkilemez) | **0 TL** |
| **TOPLAM TAHMİNİ BÜTÇE** | — | — | **~450 – 605 TL / ay** |

### Korunan Çekirdek İşletme ve Güvenlik İlkeleri
- Tek mağaza (gelecekte şube genişlemesine açık), 3–7 eşzamanlı kullanıcı, 20–200 günlük işlem.
- **Node.js 24 + SQLite (`WAL`, `synchronous=FULL`, `busy_timeout=3000`)** korunur; PostgreSQL, Redis veya çift yönlü hibrit senkronizasyon kullanılmaz.
- Finansal çekirdek (`domain.mjs`, tam sayı aritmetiği, birim izolasyonu, append-only `events` & `replay()`, toptancı yazma kapısı), 2 rol (`owner`, `employee`), 6 haneli PIN, maker-checker onay kuyruğu, kör sayım, RAM oturumları (`#sessions`) ve salt okunur `report-server.mjs` (`GET`, `PRAGMA query_only=ON`) aynen korunur.
- Hedefler: **RPO ≤ 15 dk** (operasyonel hedef 5–15 dk), **RTO ≤ 4 saat** (operasyonel hedef ≤ 60 dk), **5+ yıl** veri saklama.

---

## 2. Tamamlanan Yazılım Aşamaları (`feat/cloud-phase1-data-safety` · PR #6)

| Commit | Kapsam | Özet |
|---|---|---|
| `801b8b5` | **Faz 1** | Atomik `approvePending`/`rejectPending`/`submitPending` (`#executeInTransaction`), `PRAGMA busy_timeout=3000`, sıfır DB soğuk WAL açılış retry, `createConsistentBackup()` (`VACUUM INTO`), çapraz-DB tutarlı `scripts/backup-bundle.mjs` (`bundle-manifest.json`, `AES-256-GCM` + `scrypt`), Master PIN `viaMasterPin`/`masterActorId` gerçek aktör izi. |
| `d172c22` | **Faz 2** | Kademeli PIN kilidi (`5 → 60 sn`, `10 → 5 dk`, `15+ → 15 dk`), `identity.sqlite` `user_version=4` (`auth_audit_log`), yerel `scripts/reset-owner-pin.mjs` (canlı RAM oturumlarını süreçler arası iptal eder), fail-closed `DEPLOY_MODE=cloud-proxy` kanal izolasyonu, `/healthz`, `ubuntu-latest` Linux CI, `deploy/` şablonları. |
| `4f9fa26` | **CI Fix** | Yalnız 3 test dosyasında çapraz-OS CI uyumu (Node 24.x `maxHeadersCount=100` `431`, POSIX `chmod 0o500` swap testi, macOS deterministik `stdin` kilit bırakma). |
| `ab7a7d7` | **Faz 3 (CF)** | Sıfır harici bağımlılıklı `cloudflare-access.mjs` (`node:crypto` `RS256` JWKS + `aud` + `iss` + `exp` + `email` doğrulayıcısı), `server.mjs` (`OWNER_AUTH_PROVIDER=cloudflare-access`, `STORE_IP_HEADER=cf-connecting-ip`), `report-server.mjs` & `report-launcher.mjs` Cloudflare Access desteği, `test/phase3-cloudflare-access.test.mjs`. |
| `d85f4ac` | **QA Sertleştirme & Deploy** | `scripts/backup-bundle.mjs` (`0o600`/`0o700` düz metin izinleri, `key`/`plaintext` `.fill(0)` bellek sıfırlama, 16-bayt FD başlık okuması), `deploy/cloudflared-config.example.yml`, `deploy/README.md` ve `deploy/systemd/*` güncellemeleri. |

### Doğrulama ve Açık Teknik Notlar
- **3-OS GitHub Actions CI (`d85f4ac` — `run/45599577133`):** `windows-tests`, `linux-tests` (`ubuntu-latest`) ve `macos-tests` (`macos-26`) **3/3 `success`** (`796` backend testi geçti, `0` hata, `npm audit` `0` açık).
- **Atlanan Opt-in Test:** `test/supplier-pdf-layout.test.mjs:48` (`10k receipt PDF performance budget`, `skip: !process.env.PDF_LAYOUT_BENCHMARK`) — `PDF_LAYOUT_BENCHMARK=1 node --test test/supplier-pdf-layout.test.mjs` ile çalıştırılır.
- **Restic Yerel Windows Pilotu:** `tools/restic_0.19.1_windows_amd64.exe` yerel diskte bulunmadığı için `BLOCKED (binary eksik)` olarak kayıtlıdır; gerçek Linux `restic` doğrulaması Adım 8–9'da Ubuntu 24.04 pilot sunucusunda yapılacaktır.
- **Kalan Teknik Riskler (Adım 8–10'da Takip Edilecek):**
  1. `scripts/backup-bundle.mjs` içindeki yerleşik `.enc` şifrelemesi sıkıştırmasız tam anlık görüntüdür ve RAM'de 3–4x DB boyutu tamponlar — üretimde sıkıştırma, artımlı yedekleme ve tekilleştirme **Linux `restic`** katmanıyla sağlanmalıdır.
  2. `restoreBackupBundle` sırasında `tempDirectory` ile `targetDirectory` aynı dosya sisteminde (`/var/lib/er-sat-defter/`) konumlandırılmalıdır (`EXDEV` kopyala-sil penceresini önlemek için).
  3. Canlı Linux `systemd` + `cloudflared` + Cloudflare Access + R2 Bucket Lock + RPO/RTO tatbikatı Adım 8–10'da gerçek pilot sunucuda doğrulanmadan üretim Linux kabulü tamamlanmış sayılmaz.

---

## 3. Sıradaki Adımlar (Adım 8 – Adım 11)

### Adım 8 — Sentetik Bulut Pilotu (Sıfır Canlı Veri)
1. Hetzner Cloud (2FA aktif) üzerinde `CX33` Ubuntu 24.04 LTS pilot sunucusu açılır (SSH yalnız anahtar, `UFW` tüm gelen portları kapalı).
2. Cloudflare (2FA aktif) üzerinde:
   - Cloudflare Tunnel (`cloudflared`) kurulur ve `deploy/cloudflared-config.example.yml` ile `yonetim`, `kasa`, `rapor` subdomain'leri yönlendirilir.
   - `yonetim` ve `rapor` için ayrı Cloudflare Zero Trust Access uygulamaları (politika + `AUD` etiketi) tanımlanır.
   - `kasa` için Cloudflare WAF / IP kuralı ile yalnız mağaza statik IP'sine izin verilir ve `x-store-proxy-secret` başlığı yapılandırılır.
3. `deploy/README.md` adımlarıyla Node.js 24, `ersat` servis kullanıcısı, `er-sat-defter.service` (`DEPLOY_MODE=cloud-proxy`, `OWNER_AUTH_PROVIDER=cloudflare-access`, `STORE_IP_HEADER=cf-connecting-ip`) ve `er-sat-reports.service` ayağa kaldırılır.
4. Yalnız **sentetik verilerle** PC/tablet/telefon üzerinden 3 kanal ve 7 eşzamanlı kullanıcı testi yapılır.

### Adım 9 — Bağımsız Yedekleme, Yerel Kurtarma ve İzleme Kurulumu
1. Cloudflare R2 (EU) bucket + **Bucket Lock** + iki ayrı erişim anahtarı (`backup-writer` yalnız yazma/append-only, `backup-reader` salt okunur) oluşturulur.
2. Linux `restic` (SHA-256 doğrulamalı) + `er-sat-backup.timer` (5–15 dk) ile `scripts/backup-bundle.mjs` + R2 şifreli artımlı yedekleme devreye alınır.
3. Mağaza Windows PC'de periyodik `rclone`/`restic` görevi ile R2'den yerel şifreli çekme (`$0` egress) kurulur.
4. Healthchecks.io (RPO > 15 dk alarmı) ve UptimeRobot/Better Stack (`/healthz` canlılık alarmı) Telegram + E-posta kanallarına bağlanır.

### Adım 10 — RPO/RTO ve Güvenlik Kabulü (20 Maddelik Üretim Kapısı)
1. **Temiz 2. Test VPS'inde Felaket Kurtarma Tatbikatı:** Yalnız R2 yedeği + şifreleme anahtarıyla sıfırdan tam kurulum ve geri yükleme; ölçülmüş **RPO ≤ 15 dk**, **RTO ≤ 4 saat** kanıtı; geri yükleme sonrası eski oturumların `401` reddi ve bakiye mutabakatı.
2. **Canlı Güvenlik Testleri:** Mağaza dışı IP'den `kasa` → `403`; `kasa`'dan `/owner`, `/api/suppliers`, `owner` PIN → `403`/`404`; sahte/süresi dolmuş JWT → `403`; kademeli PIN kilidi; R2 `backup-writer` ile silme denemesi → `403 AccessDenied`.

### Adım 11 — Kontrollü Gerçek İşletme Kurulumu (İşletme Sahibi Onayıyla)
1. Mağaza ana PC'sindeki mevcut canlı veritabanının çift kopya (yerel + harici disk) yedeği alınır.
2. Mağaza PC temel güvenliği (standart Windows çalışan hesabı, ayrı yönetici hesabı, BitLocker, misafir Wi-Fi ayrımı) tamamlanır.
3. Canlı veriler şifreli kanaldan doğrulanmış üretim VPS'ine aktarılır; kasa, stok, cari, toptancı ve has altın bakiyeleri eski defterle kuruşu kuruşuna / miligramı miligramına doğrulanır.
4. Yönetici onayıyla eski yerel sunucu kapatılır, tek aktif yazma merkezi olarak bulut sunucusu devreye alınır ve ilk 15 dk R2 + mağaza PC yedeği doğrulanır.

---

## 4. macOS (Apple Silicon) Üzerinden Devam Etme Komutları

```bash
git fetch origin
git switch -C feat/cloud-phase1-data-safety origin/feat/cloud-phase1-data-safety
nvm use
npm ci --ignore-scripts
git log --oneline -n 7
```
