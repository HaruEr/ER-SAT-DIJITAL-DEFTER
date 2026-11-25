# Tailscale Serve Örnek Yapılandırması (`tailscale-owner` ve `report-server.mjs`)

Bu rehber, `DEPLOY_MODE=cloud-proxy` altındaki **yönetici kanalı (`tailscale-owner`, `127.0.0.1:4317`)** ile **salt okunur mobil rapor sunucusu (`report-server.mjs`, `127.0.0.1:4318`)** için `tailscale serve` yapılandırmasını tanımlar.

---

## 1. Port ve Alan Adı Kısıtları (`server.mjs` vs `report-server.mjs`)

İki sunucunun `Host` ve `Origin` doğrulama kuralları farklıdır:

| Bileşen | Dinlediği Adres | Zorunlu HTTPS / Host Sözleşmesi |
|---|---|---|
| `report-server.mjs` | `127.0.0.1:4318` | `REPORT_ORIGIN` **yalnız** `https://<host>.<tailnet>.ts.net` biçimini kabul eder (`report-server.mjs:15-16`: varsayılan `:443` portu, alt yol yok, açık `:443` veya özel port yok). |
| `server.mjs` (`tailscale-owner`) | `127.0.0.1:4317` | `OWNER_ALLOWED_HOSTS` geçerli `<host>` veya `<host>:<port>` (ör. `:8443`) kabul eder ve `CHECKOUT_ALLOWED_HOSTS` (ör. `kasa.example.com`) ile tamamen ayrık olmalıdır (`server.mjs:112-142, 245-261`). |

Aynı sunucuda tek bir `<host>.<tailnet>.ts.net` adı varsa `:443` portunu `report-server.mjs` almalı, `tailscale-owner` ise ayrı bir HTTPS portu (ör. `:8443`) üzerinden yayınlanmalıdır. Alternatif olarak her ikisi de `:443` kullanacaksa Tailscale Services veya iki ayrı Tailscale düğümü ile ayrı `.ts.net` adları verilmelidir.

---

## 2. Seçenek A — Tek Sunucuda Port Ayrımı (Önerilen Basit Kurulum)

Bu kurulumda raporlar `:443`, yönetici defteri `:8443` üzerinden sunulur:

```bash
# 1. Rapor portalı (varsayılan :443 — REPORT_ORIGIN ile birebir uyumlu)
sudo tailscale serve --bg --https=443 http://127.0.0.1:4318

# 2. Yönetici defteri (:8443 — OWNER_ALLOWED_HOSTS ile uyumlu)
sudo tailscale serve --bg --https=8443 http://127.0.0.1:4317

# 3. Durumu doğrulayın (Funnel kesinlikle kapalı olmalı)
tailscale serve status
tailscale funnel status
```

Karşılık gelen `/etc/er-sat-defter/editor.env` ve `/etc/er-sat-defter/reports.env` ayarları:

```ini
# /etc/er-sat-defter/editor.env
OWNER_ALLOWED_HOSTS=yonetim.example-tailnet.ts.net:8443
CHECKOUT_ALLOWED_HOSTS=kasa.example.com
OWNER_ALLOWED_LOGINS=owner@example.com
```

```ini
# /etc/er-sat-defter/reports.env
REPORT_ENABLED=1
REPORT_PORT=4318
REPORT_DATA_DIRECTORY=/var/lib/er-sat-defter
REPORT_ORIGIN=https://yonetim.example-tailnet.ts.net
REPORT_ALLOWED_LOGINS=owner@example.com
```

Yönetici erişim adresleri:
- Yönetici defteri: `https://yonetim.example-tailnet.ts.net:8443`
- Mobil raporlar: `https://yonetim.example-tailnet.ts.net`

---

## 3. Seçenek B — Tailscale Services veya Ayrı Düğümler (Her İkisi `:443`)

İki ayrı `.ts.net` alan adı tanımlamak isterseniz Tailscale Services (`--service=svc:...`) veya ayrı Tailscale düğümleri kullanın:

```bash
# Yönetici hizmeti (:443 -> 127.0.0.1:4317)
sudo tailscale serve --bg --service=svc:er-sat-yonetim --https=443 http://127.0.0.1:4317

# Rapor hizmeti (:443 -> 127.0.0.1:4318)
sudo tailscale serve --bg --service=svc:er-sat-rapor --https=443 http://127.0.0.1:4318
```

Bu durumda env ayarları:
- `OWNER_ALLOWED_HOSTS=yonetim.example-tailnet.ts.net` (`CHECKOUT_ALLOWED_HOSTS=kasa.example.com` ile ayrık)
- `REPORT_ORIGIN=https://rapor.example-tailnet.ts.net`

---

## 4. Kritik Güvenlik ve Başlık Notları

1. **Tailscale Funnel Kesinlikle Kapalı Kalmalıdır:**
   - Hiçbir zaman `tailscale funnel` etkinleştirilmemelidir. Önceden açıksa `sudo tailscale funnel reset` ile kapatın ve `tailscale funnel status` çıktısında aktif yayın olmadığını doğrulayın.
   - Hem `server.mjs` hem `report-server.mjs`, `Tailscale-Funnel-Request` başlığı taşıyan tüm istekleri (tüm rotalar ve `/healthz` dahil) HTTP `403` ile reddeder.
2. **`REPORT_ALLOWED_LOGINS` Büyük/Küçük Harf Duyarlılığı:**
   - `server.mjs` (`tailscale-owner`) `OWNER_ALLOWED_LOGINS` ve gelen `Tailscale-User-Login` değerlerini küçük harfe çevirir (`toLowerCase()`).
   - Buna karşılık `report-server.mjs` (`report-server.mjs:19, 28`) `REPORT_ALLOWED_LOGINS` listesini **birebir büyük/küçük harf duyarlı** olarak (`Set.has(login)`) karşılaştırır. Tailscale kullanıcı giriş adını her iki dosyada da birebir küçük harf (`owner@example.com`) biçiminde yazın.
3. **`report-server.mjs:56` `maxHeadersCount = 40` Sınırı:**
   - `server.mjs` `maxHeadersCount = 100` ve açık `431` (`rawHeaders.length > 80`) koruması kullanırken, `report-server.mjs:56` `server.maxHeadersCount = 40` ayarına sahiptir.
   - `report-server.mjs` önüne ek başlık enjekte eden zincirleme vekil koymayın ve Funnel'ı kapalı tutun; aksi halde fazla sayıda ara başlık `Tailscale-User-Login` veya `Origin` başlıklarının değerlendirme sınırını zorlayabilir.
4. **`tailscale-owner` Başlık Temizliği:**
   - `server.mjs`, `tailscale-owner` kanalında `X-Store-Proxy-Secret` veya `X-Real-IP` başlığı bulunursa isteği `403` ile reddeder. Tailscale Serve yapılandırmasında mağaza vekil başlıkları eklemeyin.
