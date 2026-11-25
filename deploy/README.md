# ER ŞAT Dijital Defter — Linux LTS Üretim ve İşletim Kılavuzu

Bu doküman, ER ŞAT Dijital Defter uygulamasını Linux LTS sunucularında (ör. **Hetzner CX33** üzerinde **0 açık gelen port** ile **Cloudflare Tunnel + Zero Trust Access** veya sağlayıcıdan bağımsız **Caddy + Tailscale Serve**) **Node.js 24** ve **systemd** kullanarak kurma, güncelleme, yedekleme, kurtarma ve çevrimdışı mutabakat prosedürlerini tanımlar.

---

## 1. Linux LTS ve Node.js 24 Kurulumu

### 1.1 Sistem Kullanıcısı ve Dizinler

Uygulama ayrıcalıksız `er-sat` kullanıcısı altında çalışır; canlı veritabanları ve yedekler kod klasörünün dışında tutulur:

```bash
sudo useradd --system --home /opt/er-sat-defter --shell /usr/sbin/nologin er-sat

sudo mkdir -p /opt/er-sat-defter /var/lib/er-sat-defter /var/backups/er-sat-defter /etc/er-sat-defter
sudo chown er-sat:er-sat /opt/er-sat-defter /var/lib/er-sat-defter /var/backups/er-sat-defter
sudo chown root:er-sat /etc/er-sat-defter
sudo chmod 0750 /opt/er-sat-defter
sudo chmod 0700 /var/lib/er-sat-defter /var/backups/er-sat-defter
sudo chmod 0750 /etc/er-sat-defter
```

### 1.2 Uygulama Kodunu Yerleştirme ve Bağımlılık Kurulumu

Node.js **24 LTS** (`node -v` >= `v24.0.0`, `package.json` `engines.node`) kurulduktan sonra kilitli bağımlılıkları yaşam döngüsü betikleri kapalı biçimde kurun:

```bash
cd /opt/er-sat-defter
# Kaynak kodu bu dizine açın/çekin, ardından bağımlılıkları kurun:
sudo -u er-sat env \
  TEMP=/tmp/er-sat-npm \
  TMP=/tmp/er-sat-npm \
  npm_config_cache=/tmp/er-sat-npm/cache \
  npm ci --ignore-scripts

# Sözdizimi ve yayın güvenliği doğrulaması:
node scripts/check-syntax.mjs
node scripts/release-check.mjs   # (Git deposundan kurulduysa)
```

### 1.3 Ortam Dosyalarını Hazırlama (Git Dışında, `0600`)

Ortam dosyalarını **kesinlikle Git deposunun içine koymayın**; `/etc/er-sat-defter/` altında oluşturup `chmod 0600` ile koruyun (`chown er-sat:er-sat`).

**Seçenek A — Tailscale + Caddy (`/etc/er-sat-defter/editor.env` ve `reports.env`):**

**`/etc/er-sat-defter/editor.env`** (`er-sat-defter.service` tarafından okunur):

```ini
PORT=4317
DATA_DIRECTORY=/var/lib/er-sat-defter
DEPLOY_MODE=cloud-proxy

# Tailscale yönetici kanalı (tailscale-owner; varsayılan OWNER_AUTH_PROVIDER=tailscale)
OWNER_AUTH_PROVIDER=tailscale
OWNER_ALLOWED_LOGINS=owner@example.com
OWNER_ALLOWED_HOSTS=yonetim.example-tailnet.ts.net:8443

# Mağaza kasa kanalı (store-checkout) — OWNER_ALLOWED_HOSTS ile tamamen ayrık olmalı
CHECKOUT_ALLOWED_HOSTS=kasa.example.com
STORE_PROXY_SECRET=<EN_AZ_16_KARAKTERLIK_GUCLU_RASTGELE_SIR>
STORE_IP_HEADER=x-real-ip
STORE_ALLOWED_IPS=203.0.113.10/32

# İsteğe bağlı: dış sağlık ucu kullanılacaksa (en az 16 karakter; boş bırakılırsa yalnız loopback)
# HEALTHZ_TOKEN=<EN_AZ_16_KARAKTERLIK_SAGLIK_ANAHTARI>
```

**`/etc/er-sat-defter/reports.env`** (`er-sat-reports.service` tarafından okunur):

```ini
REPORT_ENABLED=1
REPORT_PORT=4318
REPORT_DATA_DIRECTORY=/var/lib/er-sat-defter
REPORT_AUTH_PROVIDER=tailscale
REPORT_ORIGIN=https://yonetim.example-tailnet.ts.net
REPORT_ALLOWED_LOGINS=owner@example.com
```

**Seçenek B — Cloudflare Tunnel + Zero Trust Access (Hetzner CX33, 0 açık gelen port):**

> **Takım adı kuralı:** `OWNER_CF_TEAM_DOMAIN` ve `REPORT_CF_TEAM_DOMAIN` yalnızca küçük harf, rakam ve tire (`-`) içeren `<team-slug>.cloudflareaccess.com` biçimini kabul eder (`_` alt çizgi reddedilir). `REPORT_ORIGIN` yalnızca `https://<alanadi>` biçiminde olmalıdır (port numarası ve sondaki `/` kabul edilmez).

**`/etc/er-sat-defter/editor.env`** (`er-sat-defter.service` tarafından okunur):

```ini
PORT=4317
DATA_DIRECTORY=/var/lib/er-sat-defter
DEPLOY_MODE=cloud-proxy

# Cloudflare Zero Trust Access yönetici kanalı (cloudflare-owner)
OWNER_AUTH_PROVIDER=cloudflare-access
OWNER_CF_TEAM_DOMAIN=<team-slug>.cloudflareaccess.com
OWNER_CF_AUD=<YONETIM-CF-AUD>
OWNER_ALLOWED_LOGINS=owner@example.com
OWNER_ALLOWED_HOSTS=yonetim.example.com

# Mağaza kasa kanalı (store-checkout) — Zero Trust Access KAPALI; OWNER_ALLOWED_HOSTS ile ayrık
CHECKOUT_ALLOWED_HOSTS=kasa.example.com
STORE_PROXY_SECRET=<EN_AZ_16_KARAKTERLIK_GUCLU_RASTGELE_SIR>
STORE_IP_HEADER=cf-connecting-ip
STORE_ALLOWED_IPS=203.0.113.10/32

# İsteğe bağlı: dış sağlık ucu kullanılacaksa (en az 16 karakter; boş bırakılırsa yalnız loopback)
# HEALTHZ_TOKEN=<EN_AZ_16_KARAKTERLIK_SAGLIK_ANAHTARI>
```

**`/etc/er-sat-defter/reports.env`** (`er-sat-reports.service` tarafından okunur):

```ini
REPORT_ENABLED=1
REPORT_PORT=4318
REPORT_DATA_DIRECTORY=/var/lib/er-sat-defter
REPORT_AUTH_PROVIDER=cloudflare-access
REPORT_CF_TEAM_DOMAIN=<team-slug>.cloudflareaccess.com
REPORT_CF_AUD=<RAPOR-CF-AUD>
REPORT_ORIGIN=https://rapor.example.com
REPORT_ALLOWED_LOGINS=owner@example.com
```

**`/etc/er-sat-defter/backup.env`** (`er-sat-backup.service` tarafından okunur):

```ini
DATA_DIRECTORY=/var/lib/er-sat-defter
BACKUP_OUT_DIR=/var/backups/er-sat-defter
BACKUP_PASSPHRASE=<UZUN_VE_GUCLU_YEDEK_PAROLASI>
```

İzinleri kilitleyin:

```bash
sudo chown er-sat:er-sat /etc/er-sat-defter/*.env
sudo chmod 0600 /etc/er-sat-defter/*.env
```

### 1.4 Systemd Birimlerini Etkinleştirme

```bash
sudo cp deploy/systemd/er-sat-defter.service /etc/systemd/system/
sudo cp deploy/systemd/er-sat-reports.service /etc/systemd/system/
sudo cp deploy/systemd/er-sat-backup.service /etc/systemd/system/
sudo cp deploy/systemd/er-sat-backup.timer /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now er-sat-defter.service
sudo systemctl enable --now er-sat-reports.service

# Canlılık doğrulaması (loopback üzerinden proxy başlığı olmadan):
curl -fsS http://127.0.0.1:4317/healthz
```

> **İlk kurulum notu:** İlk yönetici kurulumu yapılıp `/var/lib/er-sat-defter/dukkan.sqlite` ve `identity.sqlite` dosyaları oluştuktan sonra zamanlayıcıyı açın:
> ```bash
> sudo systemctl enable --now er-sat-backup.timer
> ```
> Bulut üretim ortamında 10 dakikalık RPO için birim dosyasını değiştirmeden systemd drop-in (`/etc/systemd/system/er-sat-backup.timer.d/override.conf`) ekleyin (boş `OnCalendar=` satırı varsayılan 6 saatlik takvimi sıfırlamak için zorunludur):
> ```ini
> [Timer]
> OnCalendar=
> OnCalendar=*:0/10
> RandomizedDelaySec=30s
> ```
> Ardından `sudo systemctl daemon-reload && sudo systemctl restart er-sat-backup.timer` çalıştırın.

### 1.5 `restic` Durumu Hakkında Şeffaf Not

Çekirdek şifreli yedekleme doğrudan `scripts/backup-bundle.mjs` içindeki yerleşik **AES-256-GCM + scrypt** katmanıyla çalışır ve harici bir araca bağlı değildir. İsteğe bağlı pilot araç kontrolü:

```bash
node /opt/er-sat-defter/scripts/backup-bundle.mjs check-restic
```

Yerel sistemde `restic` ikili dosyası yoksa bu komut çökmeden ve internetten indirme yapmadan şeffaf biçimde `"status": "BLOCKED (binary eksik)"` çıktısı verir.

---

## 2. Sağlayıcıdan Bağımsız Ağ ve Kanal Ayrımı

`DEPLOY_MODE=cloud-proxy` fail-closed çalışır: eksik veya tutarsız yapılandırmada sunucu başlamaz ve `dataDirectory` oluşturmaz. Varsayılan `local` modunda (`DEPLOY_MODE` boş veya `local`) tüm vekil başlıkları engellenir.

- **Yönetici Kanalı (`tailscale-owner`) ve Mobil Raporlar (`report-server.mjs`):**
  - Ayrıntılı kurulum için `deploy/tailscale-serve.cloud.example.md` dosyasına bakın.
  - `tailscale funnel` kesinlikle kapalı kalmalıdır (`Tailscale-Funnel-Request` tüm rotalarda `403` ile reddedilir).
  - `REPORT_ALLOWED_LOGINS` büyük/küçük harf duyarlıdır; Tailscale kullanıcı adını küçük harf girin.
  - `tailscale-owner` üzerinde `allowMasterFallback` kapalıdır (`viaMasterPin` çalışmaz); yalnız yönetici oturumları ve tüm yönetici/tedarikçi/denetim uçları (`/api/security/audit` dahil) açılır.
- **Mağaza Kasa Kanalı (`store-checkout`):**
  - Ayrıntılı Caddy şablonu için `deploy/Caddyfile.cloud.example` dosyasına bakın.
  - Caddy dışarıdan `/healthz` erişimini keser, `Tailscale-*` başlıklarını siler, tekil `X-Store-Proxy-Secret` ve `X-Real-IP` (`{remote_host}`) başlıklarını yazar.
  - `STORE_ALLOWED_IPS` sağlayıcıdan bağımsız olarak şu üç modelden biriyle çalışır:
    1. **Statik mağaza WAN IP:** `STORE_ALLOWED_IPS=203.0.113.10/32`
    2. **WireGuard tüneli:** `STORE_ALLOWED_IPS=198.51.100.0/24` (tünel eş adresi/alt ağı)
    3. **Tailscale ağ geçidi / subnet router:** `STORE_ALLOWED_IPS=198.51.100.25/32`
  - Bu kanalda `/owner`, `/users`, `/api/state`, `/api/suppliers`, `/api/backup`, `/api/archive`, `/api/restore`, `/api/recovery`, `/api/journal`, `/api/summary`, `/api/security/*` ve yönetici girişi sunucu katmanında `403`/`404` ile engellenir.

### 2.1 Hetzner CX33 + Cloudflare Tunnel + Cloudflare Zero Trust Access

Bu mimaride sunucuda **hiçbir gelen port açılmaz**; hem yönetim hem mağaza kasa hem de rapor trafiği dışa giden şifreli `cloudflared` tünelinden geçirilir:

1. **Hetzner CX33 UFW Güvenlik Duvarı (0 Açık Gelen Port):**
   ```bash
   sudo ufw default deny incoming
   sudo ufw default allow outgoing
   sudo ufw --force enable
   sudo ufw status verbose
   ```
   *(Yönetim ve acil müdahale için Hetzner Cloud Console veya Cloudflare Access SSH / Tailscale SSH kullanın; `80`, `443` ve `22` portlarını internete açmayın.)*

2. **`cloudflared` Tünel Kurulumu:**
   - `deploy/cloudflared-config.example.yml` şablonunu `/etc/cloudflared/config.yml` konumuna kopyalayın; `<CLOUDFLARE-TUNNEL-UUID>` ve `example.com` değerlerini kendi alan adınızla değiştirin.
   - Tünel kimlik dosyasını (`/etc/cloudflared/<CLOUDFLARE-TUNNEL-UUID>.json`) `chmod 0600` ile koruyun (Git deposuna eklemeyin) ve `sudo systemctl enable --now cloudflared` ile başlatın.

3. **Kanal, Zero Trust Access ve WAF Kuralları:**
   - **`yonetim.example.com` (`cloudflare-owner`):** Cloudflare Zero Trust Access **Application #1** (`OWNER_CF_AUD`) bağlanır. `server.mjs`, `Cf-Access-Jwt-Assertion` (`RS256` + JWKS) imzasını kriptografik olarak doğrular ve `email` adresini `OWNER_ALLOWED_LOGINS` içinde arar. `Cf-Access-Authenticated-User-Email` başlığına tek başına asla güvenilmez (varsa JWT `email` ile eşleşmesi zorunludur; uyuşmazlıkta `403`). Bu kanalda `allowMasterFallback: false` korunur; `x-store-proxy-secret`, `x-real-ip` ve `tailscale-*` başlıkları reddedilir.
   - **`rapor.example.com` (`cloudflare-access`):** Cloudflare Zero Trust Access **Application #2** (`REPORT_CF_AUD` — `OWNER_CF_AUD`'dan ayrı bir Application ve AUD) bağlanır. `report-server.mjs` yalnız `GET` isteklerini, `PRAGMA query_only=ON` salt okunur bağlantıyı ve sıkı CSP'yi korur; `tailscale-*` başlıklarını reddeder; `REPORT_ORIGIN` portsuz ve sondaki `/` olmadan (`https://rapor.example.com`) tanımlanır.
   - **`kasa.example.com` (`store-checkout`):** Bu alt alan adında **Cloudflare Zero Trust Access KESİNLİKLE KAPALI** olmalıdır (`server.mjs`, `cf-access-*` başlıklarını `403` ile reddeder). Erişimi şu iki yöntemden biriyle kilitleyin:
     - **Seçenek A (1-atlama WAF + Transform Rule):** Cloudflare WAF ile yalnızca mağaza statik WAN IP'sine (`203.0.113.10/32`) izin verin; Cloudflare Transform Rule (Modify Request Header) ile tekil `X-Store-Proxy-Secret` = `STORE_PROXY_SECRET` enjekte edin ve `editor.env` içinde `STORE_IP_HEADER=cf-connecting-ip` kullanın.
     - **Seçenek B (Yerel Caddy döngüsü):** `cloudflared` içinde `kasa.example.com` -> `http://127.0.0.1:4319` yönlendirin; yerel Caddy `X-Store-Proxy-Secret` başlığını ekleyip `CF-Connecting-IP` başlığını **değiştirmeden** `http://127.0.0.1:4317` adresine iletsin (`STORE_IP_HEADER=cf-connecting-ip`; Caddy içinde `X-Real-IP {remote_host}` yazmayın!).
   - **Başlık Sınırı (M1 Hizalaması):** Hem `server.mjs` hem de `report-server.mjs`, `maxHeadersCount = 100` ve `rawHeaders > 80 -> 431` (en fazla 40 başlık çifti) sınırı uygular; Transform Kuralları ile gereksiz ek başlık eklemeyin.

---

## 3. Sürümlü Güncelleme, Ön-Yedek ve Geri Dönüş (Rollback)

Her sürüm güncellemesinden önce mutlaka şifreli ön-yedek alın.

### 3.1 Güncelleme Öncesi Şifreli Yedek

```bash
sudo -u er-sat /bin/bash -euo pipefail -c '
  set -a; source /etc/er-sat-defter/backup.env; set +a
  STAGE_DIR="$(mktemp -d /var/backups/er-sat-defter/.upgrade-stage.XXXXXX)"
  cleanup() { rm -rf -- "${STAGE_DIR}"; }
  trap cleanup EXIT
  CREATE_JSON="$(/usr/bin/node /opt/er-sat-defter/scripts/backup-bundle.mjs create \
    --data-dir /var/lib/er-sat-defter --out-dir "${STAGE_DIR}" --temp-dir "${STAGE_DIR}")"
  BUNDLE_DIR="$(/usr/bin/node -e "const d = JSON.parse(process.argv[1]); if (!d.bundleDirectory) process.exit(1); process.stdout.write(d.bundleDirectory);" "${CREATE_JSON}")"
  /usr/bin/node /opt/er-sat-defter/scripts/backup-bundle.mjs encrypt \
    --bundle-dir "${BUNDLE_DIR}" \
    --out-file "/var/backups/er-sat-defter/pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).enc" \
    --passphrase-env BACKUP_PASSPHRASE \
    --temp-dir "${STAGE_DIR}"
'
```

*(Veya doğrudan `sudo systemctl start er-sat-backup.service` çalıştırıp oluşan `.enc` dosya adını kaydedin.)*

### 3.2 Sürümlü Güncelleme

```bash
cd /opt/er-sat-defter
# Yeni etiketli sürümü çekin / açın, ardından bağımlılıkları ve sözdizimini doğrulayın:
sudo -u er-sat env \
  TEMP=/tmp/er-sat-npm \
  TMP=/tmp/er-sat-npm \
  npm_config_cache=/tmp/er-sat-npm/cache \
  npm ci --ignore-scripts
node scripts/check-syntax.mjs

sudo systemctl restart er-sat-defter.service er-sat-reports.service
curl -fsS http://127.0.0.1:4317/healthz
journalctl -u er-sat-defter.service -n 50 --no-pager
```

### 3.3 Geri Dönüş (Rollback)

Güncelleme sonrasında sorun görülürse servisleri durdurun, ön-yedekten geri yükleyin (SHA-256, `PRAGMA integrity_check`, tam `replay()` mutabakatı ve `session_generation` döndürmesi otomatik uygulanır), kodu önceki etikete alın ve servisleri başlatın:

```bash
sudo systemctl stop er-sat-defter.service er-sat-reports.service

sudo -u er-sat /bin/bash -euo pipefail -c '
  set -a; source /etc/er-sat-defter/backup.env; set +a
  /usr/bin/node /opt/er-sat-defter/scripts/backup-bundle.mjs restore \
    --encrypted-file /var/backups/er-sat-defter/pre-upgrade-YYYYMMDDTHHMMSSZ.enc \
    --passphrase-env BACKUP_PASSPHRASE \
    --target-dir /var/lib/er-sat-defter
'

# /opt/er-sat-defter kodunu önceki sürüm etiketine geri alın ve npm ci --ignore-scripts çalıştırın.
sudo systemctl start er-sat-defter.service er-sat-reports.service
curl -fsS http://127.0.0.1:4317/healthz
```

> **Not:** `restore` işlemi `session_generation` değerini artırdığı için önceki tüm yönetici ve çalışan oturumları geçersiz kılınır; kullanıcılar yeniden giriş yapmalıdır.

---

## 4. Mağaza PC'sine Yerel Şifreli Yedek Çekme ve Çevrimdışı Doğrulama

Sunucudaki `/var/backups/er-sat-defter/*.enc` dosyalarını düzenli olarak mağazadaki yerel PC'ye çekin (hiçbir zaman düz metin SQLite paketi kopyalamayın). `er-sat` servis kullanıcısı `--shell /usr/sbin/nologin` ile kilitli olduğu ve `/var/backups/er-sat-defter` dizini `0700` (`er-sat:er-sat`) izinli olduğu için, uzak bağlantı `er-sat@...` yerine SSH yetkili bir yönetici/operatör kullanıcısı (`<admin_user>`) üzerinden yapılmalıdır:

```bash
# Tailscale / SSH üzerinden yalnız .enc dosyalarını çekme (`sudo rsync` ile):
mkdir -p ./er-sat-enc-backups
rsync -av --include='*.enc' --exclude='*' \
  --rsync-path='sudo rsync' \
  <admin_user>@yonetim.example-tailnet.ts.net:/var/backups/er-sat-defter/ \
  ./er-sat-enc-backups/

# Alternatif (sunucuda `sudo cp` ile geçici sahne kopyası hazırlayıp `scp` ile çekme):
# Sunucuda:
#   sudo install -d -m 0700 -o <admin_user> /tmp/er-sat-pull
#   sudo cp /var/backups/er-sat-defter/er-sat-backup-*.enc /tmp/er-sat-pull/
#   sudo chown <admin_user>:<admin_user> /tmp/er-sat-pull/*.enc
#   sudo chmod 0600 /tmp/er-sat-pull/*.enc
# Mağaza PC'sinde:
scp <admin_user>@yonetim.example-tailnet.ts.net:/tmp/er-sat-pull/er-sat-backup-*.enc ./er-sat-enc-backups/
# Çekim tamamlandıktan sonra sunucudaki geçici kopyayı kaldırın:
ssh <admin_user>@yonetim.example-tailnet.ts.net 'rm -rf /tmp/er-sat-pull'

# Yerel PC'de çekilen `.enc` dosyalarının sahiplik/izinlerini sıkılaştırın (gerekiyorsa `chown` ile):
chmod 0700 ./er-sat-enc-backups
chmod 0600 ./er-sat-enc-backups/*.enc
```

Çekilen `.enc` dosyasını **yalnız izole bir geçici klasörde** doğrulayın (asla canlı `data/` veya `/var/lib/er-sat-defter` üzerinde çalıştırmayın):

```bash
# Seçenek A — Şifre çözme + manifest/SHA-256 doğrulama:
BACKUP_PASSPHRASE='<YEDEK_PAROLASI>' \
  node scripts/backup-bundle.mjs decrypt \
    --encrypted-file ./er-sat-enc-backups/er-sat-backup-YYYYMMDDTHHMMSSZ.enc \
    --out-dir /tmp/er-sat-verify-dec \
    --passphrase-env BACKUP_PASSPHRASE

# Seçenek B — Tam finansal replay() + integrity_check geri yükleme tatbikatı:
BACKUP_PASSPHRASE='<YEDEK_PAROLASI>' \
  node scripts/backup-bundle.mjs restore \
    --encrypted-file ./er-sat-enc-backups/er-sat-backup-YYYYMMDDTHHMMSSZ.enc \
    --passphrase-env BACKUP_PASSPHRASE \
    --target-dir /tmp/er-sat-verify-restore
```

Çıktıda Seçenek A (`decrypt`) için `bundleId` ve `manifest` alanlarını, Seçenek B (`restore`) için `"ok": true` ve `reconciliations` özetini doğruladıktan sonra geçici doğrulama klasörlerini temizleyin (`rm -rf /tmp/er-sat-verify-dec /tmp/er-sat-verify-restore`). Sunucu diskini doldurmamak için günlük/haftalık `.enc` kopyalarını yerel PC'de arşivleyip sunucudaki eski `.enc` dosyaları için saklama süresi (ör. 30 gün) belirleyin.

### 4.1 Cloudflare R2 (EU) + Object/Bucket Lock + Append-Only Restic (10 dk RPO)

Bulut üretim ortamında fidye yazılımı veya yanlış silme riskine karşı **değiştirilemez (immutable)** uzak yedekleme önerilir:

1. **EU Konumlu R2 Bucket ve Bucket Lock:** Cloudflare R2 üzerinde **EU** konumlu bir bucket oluşturun ve **Object Lock / Bucket Lock** korumasını (ör. 30–90 günlük saklama kilidi) etkinleştirin.
2. **En Az Yetkili İki Ayrı R2 API Anahtarı:**
   - **VPS Append-Only Yazma Anahtarı:** Yalnız yeni nesne yazma/ekleme yetkisine sahip (`delete` yetkisi olmayan) anahtar oluşturun; parolayı `/etc/er-sat-defter/restic.env` (`chmod 0600`, `chown er-sat:er-sat`, Git dışında) içinde tutun.
   - **Mağaza PC Salt Okunur Çekme Anahtarı:** Yalnızca okuma/indirme yetkili ayrı bir R2 API anahtarı oluşturun.
3. **Systemd Drop-In ile Otomatik R2 Aktarımı:** `er-sat-backup.service` çekirdek birimini değiştirmeden `/etc/systemd/system/er-sat-backup.service.d/r2-sync.conf` dosyası ekleyin:
   ```ini
   [Service]
   EnvironmentFile=/etc/er-sat-defter/restic.env
   ExecStartPost=/usr/bin/restic --repo s3:https://<CF-ACCOUNT-ID>.r2.cloudflarestorage.com/<R2-BUCKET> backup /var/backups/er-sat-defter --tag er-sat-enc
   ExecStartPost=/usr/bin/find /var/backups/er-sat-defter -maxdepth 1 -type f -name 'er-sat-backup-*.enc' -mtime +7 -delete
   ```
   *(İlk kullanımda `restic init` çalıştırın; `.enc` dosyaları `backup-bundle.mjs` tarafından zaten AES-256-GCM ile şifrelenmiş olduğundan çift katmanlı koruma sağlanır.)*

### 4.2 Canlılık ve Yedek Alarmı (Healthchecks.io + UptimeRobot)

- **Yedekleme Nabzı (Dead-Man's Switch):** `/etc/systemd/system/er-sat-backup.service.d/r2-sync.conf` sonuna bir sinyal satırı ekleyerek yedekleme + R2 aktarımı başarılı olduğunda **Healthchecks.io**'yu bilgilendirin (ör. 15 dakika içinde sinyal gelmezse Telegram/e-posta uyarısı):
  ```ini
  ExecStartPost=/usr/bin/curl -fsS -m 10 --retry 3 https://hc-ping.com/<HEALTHCHECKS-UUID>
  ```
- **UptimeRobot / Harici Sağlık İzleme:** `/healthz` ucunu dışarı açmak istemiyorsanız tünel katmanında kapalı bırakın; dış izleme gerekiyorsa `editor.env` içinde `HEALTHZ_TOKEN` tanımlayıp tekil `Authorization: Bearer <token>` veya `X-Healthz-Token: <token>` başlığıyla sorgulayın.

### 4.3 Mağaza Windows PC Yerel 3. Kopya Çekme (`C:\er-sat-backups`)

Mağaza Windows bilgisayarında Görev Zamanlayıcı (Task Scheduler) ile R2 EU bucket'ındaki şifreli yedekleri **yalnız salt okunur R2 anahtarı** kullanarak (`$0` egress) yerel **`C:\er-sat-backups`** klasörüne düzenli çekin:

- Hedef klasörü kullanıcı profil klasörleri yerine doğrudan **`C:\er-sat-backups`** olarak oluşturun ve NTFS izinlerini yalnızca yönetici hesabı ile sınırlayın (`icacls C:\er-sat-backups /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F"`).
- Çekilen `.enc` dosyasını izole bir geçici klasörde PowerShell üzerinden doğrulayıp temizleyin:
  ```powershell
  $env:BACKUP_PASSPHRASE = '<YEDEK_PAROLASI>'
  node scripts/backup-bundle.mjs restore `
    --encrypted-file C:\er-sat-backups\er-sat-backup-YYYYMMDDTHHMMSSZ.enc `
    --passphrase-env BACKUP_PASSPHRASE `
    --target-dir C:\er-sat-verify-tmp
  Remove-Item -Recurse -Force C:\er-sat-verify-tmp
  Remove-Item Env:BACKUP_PASSPHRASE
  ```

---

## 5. Acil Yönetici PIN Sıfırlama (`scripts/reset-owner-pin.mjs`)

Bulut proxy modunda yönetici PIN'i unutulduğunda veya kademeli deneme kilidine takıldığında yalnız sunucuda yerel SSH/terminal erişimiyle acil kurtarma yapılır (HTTP ucu yoktur):

```bash
# Önerilen yöntem: gizli TTY girişi (PIN kabuk geçmişine düşmez)
sudo -u er-sat node /opt/er-sat-defter/scripts/reset-owner-pin.mjs \
  --data-dir /var/lib/er-sat-defter \
  --must-change-pin
```

Alternatif olarak ortam değişkeni üzerinden (`--pin` doğrudan argümanı kabuk geçmişinde kalabileceğinden yalnızca otomasyonda tercih edilmelidir):

```bash
NEW_OWNER_PIN='<6_HANELI_PIN>' sudo -u er-sat --preserve-env=NEW_OWNER_PIN \
  node /opt/er-sat-defter/scripts/reset-owner-pin.mjs \
    --data-dir /var/lib/er-sat-defter \
    --pin-env NEW_OWNER_PIN \
    --must-change-pin
```

Bu işlem:
- Tüm kademeli PIN kilitleme kayıtlarını (`login_limits`) temizler,
- `session_generation` değerini döndürerek aktif tüm yönetici ve çalışan oturumlarını anında iptal eder,
- `auth_audit_log` tablosuna ham PIN yazmadan `owner_pin_reset` ve `sessions_invalidated` denetim kayıtları ekler,
- `--must-change-pin` verildiyse bir sonraki girişte yeni PIN belirlenmesini zorunlu kılar.

---

## 6. İnternet Kesintisi Manuel Mutabakat Prosedürü

İnternet veya mağaza bağlantısı kesildiğinde bulut kasasına erişilemez. Veri tutarsızlığı ve hesap karışıklığı yaşamamak için aşağıdaki sırayı izleyin:

1. **Kesinti Sırasında (Kağıt / Çevrimdışı Fiş Defteri):**
   - Her işlemi **kronolojik sıra numaralı** kağıt fiş/makbuza kaydedin:
     - Tam **tarih ve saat**
     - İşlemi yapan **çalışan / operatör adı**
     - **Müşteri / karşı taraf adı** ve işlem türü (satış, alış/hurda, tahsilat, ödeme, emanet)
     - **Ürün / hesap adı, miktar/gram ve kesin birim** (`ADET`, `GRAM`, `HAS`, `TL`, `USD`, `EUR`, `SILVER`)
   - **Birim İzolasyonu Kuralı (Zorunlu):** `HAS`, `TL`, `USD`, `EUR` ve `SILVER` birimlerini kafadan veya otomatik kurla asla tek birimde birleştirmeyin. Farklı para/maden birimleriyle yapılan işlemlerde her birimi ayrı satır olarak veya müşteriyle mutabık kalınan açık kur/dönüşüm fişiyle kaydedin.
   - **Toptancı İşlemleri:** Toptancı hesap hareketleri (`supplier*`) yalnızca yönetici yetkisindedir; kasa ekranından girilmez, ayrı kağıt fişte yönetici onayı için tutulur.

2. **Bağlantı Geri Geldiğinde (Sıralı Giriş ve Mutabakat):**
   - Önce yönetici `/healthz` ve sunucu durumunu kontrol eder.
   - Çevrimdışı fişler **kronolojik sırayla** `/checkout` (çalışan girişi -> yönetici onay kuyruğu) veya `/owner` üzerinden sisteme girilir; her kaydın `note` (açıklama) alanına **orijinal fiş numarası ve işlem saati** yazılır.
   - Toptancı fişleri yalnız `/owner` üzerinden ilgili toptancı modülüne işlenir.
   - Gün sonu kapatılmadan (`close`) önce kasa çekmecesindeki fiziksel `TL`, `USD`, `EUR`, gram/has altın ve adet stokları sistem bakiyeleriyle kalem kalem karşılaştırılıp mutabakat tamamlanır.
