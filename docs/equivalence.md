# Tam sürüm kaynak eşdeğerliği

11 Kasım 2026. Karşılaştırma kaynağı 8ddbdec uygulama kesitidir. Yayın için mali motor, HTTP yönlendirmeleri, rol sınırları, ekranlar veya olay uyumluluğu değiştirilmedi. Makineye özel test araçları taşınabilirleştirildi; dağıtım belgeleri ve denetimleri eklendi. Eşdeğerlik dosya sayısından ibaret değildir: aşağıdaki ekran/API/işlev/test matrisi, SHA256 karşılaştırması ve kabul raporundaki gerçek koşular birlikte değerlendirilir.

## Kapsam dışında bırakılan özel geliştirme materyali

Gerçek data/, .local/, .env, SQLite dosyaları, eski Git geçmişi, yerel yedekler, loglar, ekran görüntüleri, iş kayıtları ve önceki geliştirme kanıtları kopyalanmadı. AGENTS.md içindeki makine/işletme yönergeleri dağıtılmadı; geliştirici kuralları CONTRIBUTING.md içinde yeniden yazıldı.

Altı tarihsel doğrulayıcı yalnız belirli eski kabul snapshotlarını tüketiyordu; gerekli özel kanıtları yayımlamamak için pakete alınmadı: qa-temp/supplier-uat-checkpoint-independent.mjs, supplier-uat-e07-independent.mjs, supplier-uat-final-independent.mjs, supplier-uat-g07-independent.mjs, supplier-uat-independent-verifier.mjs ve supplier-ux-independent-verifier.mjs. Bu dosyalar aktif uygulama özelliği değildir. Mevcut backend/UI/supplier-oracle komutlarının bütün kaynakları ve finansal regresyonları korunmuştur.

Yerel şifreli yedek pilotunun sabit makine yolu kaldırıldı; sabit Restic sürüm/hash kontrolü ve yalnız sentetik dizin sınırı korundu. Mobil raporun mevcut özel ağ/kimlik proxy gereksinimi değişmedi; public editör servisine dönüştürülmedi.
## Ekran / işlev / API / test eşdeğerlik envanteri

Tüm satırların statik kaynak karşılığı adayda bulunur. Aşağıdaki tablo runtime PASS tablosu değildir.

| Ekran veya yetenek | Kaynak / API | Mevcut test karşılığı |
| --- | --- | --- |
| Giriş, ilk owner, çalışan yönetimi | login.html/js, users.html/js, identity.mjs; GET auth/users, auth/session; POST auth/setup, login, logout, employees, disable | identity, editor-auth, actor-audit |
| Günün Görünümü | index.html data-view=overview, app.js; GET state, summary, journal | ui-d04, ui-d06, summary-api |
| İşlem Ekranı: satış, müşteri alışı, karma para/ürün/hurda, gider ve tahsilat | app.js, domain.mjs, sale-pricing.mjs; POST command | purchase, sale-pricing, manual-exchange-domain, mixed-return-crossday, ui-purchase, manual-mixed-ui |
| Sayım ve Kapanış: adet/gram, terazi, gerekçeli fark, ertesi gün | data-view=closing; stocktake/close/opening | workday, workday-bank-choice, master-ux-count, ui-d08o |
| Müşteri: kart, birim, cari, geçmiş/ekstre, sipariş/avans | data-view=accounts; account/accountUpdate/customerOrder/orderAdvance/orderRefund/orderCancel/scrapAdvanceTransfer/scrapAdvanceUndo; GET account-statement | customer-orders, scrap-advance, prior-scrap-trace, ui-prior-scrap, ui-scrap-advance |
| Toptancılar: firma/birim, ürün alış, ödeme/avans, tahsis/mahsup, iade, düzeltme, ekstre/mutabakat | suppliers.js, supplier-ledger.mjs, supplier-view.mjs; GET suppliers; supplierFirm/FirmUpdate/Unit/Purchase/Payment/Allocation/Offset/Return/Reverse/Amend/LegacyReceiptLink | supplier-native-domain, supplier-view, supplier-rebuild-integration, supplier-write-gate, supplier-multiday-independent, supplier-edit-preview-independent; 5 supplier-workspace/app UI betiği |
| Stok: adet/gram/ayar/HAS, stok kartı, tekil envanter/fotoğraf, maliyet bağlantısı | data-view=stocks; inventory.mjs; stockAccount/stockUpdate/registerItem/itemCostSource/releaseItem/stock/nominalOpening; GET item-photo | inventory-item, item-cost-source, inventory-native-supplier, inventory-item-smoke |
| Banka/POS/Kasa, döviz ve transfer | data-view=banks; fundAccount/fundUpdate/transfer/settlement/movement | core-account-journal, manual-review-bank-has, ui-d07 |
| Günlük İşlemler: sayfalama, arama, bağlı fiş, düzeltme/ters kayıt | data-view=journal; GET journal; amend/reverse | ledger-view, statement-related-events, compact-financial, ui-compact |
| Günlük İşletme Özeti ve çıktı | data-view=summary; GET summary; receipt/statement render, CSV | summary-api, receipt-statement-smoke, master-ux-report-filters |
| Müşteri iade/değişim | domain.mjs, retail-exchange.mjs; saleReturn/retailExchange/undoExchange | sale-return, return-customer-consideration, mixed-return-crossday, ui-returns |
| Yedek ve Çalışma Alanı | data-view=backup; GET backup/archive/recovery; POST download-ticket/restore/archive/restore | backup-limits, recovery-api, recovery-drill, archive-api, ui-backup, ui-recovery |
| Çalışan tezgâhı: stok, sıfır müşteri, çok satırlı satış/alış | checkout.html/js, editor-access.mjs; GET checkout/customers, POST command allowlist | editor-auth, actor-audit, ui-checkout-trade |
| Mobil salt okunur Genel bakış/Stok/Cariler/Hareketler | reports.html/js/css, report-server/repository/launcher; GET reports/overview, summary, journal | reports, report-launcher, master-security-boundaries, ui-reports |
| Yerel PDF/CSV | supplier-pdf.js, suppliers.js, pdfmake.min.js/vfs_fonts.js; GET suppliers exact snapshot | supplier-export-api, supplier-pdf, supplier-pdf-layout, supplier-workspace-documents |
| Olay sürümleri 1–17, atomiklik, duplicate/revision, eski kayıt uyumu | domain/repository/archive + bütün finansal modüller | ledger, v3, archive, supplier-multi-unit, supplier-write-gate, master-financial-acceptance |

Statik endpoint envanteri ayrıca /api/state, /api/summary, /api/backup, /api/command, /api/restore, /api/recovery, /api/archive, /api/archive/restore, /api/journal, /api/item-photo, /api/account-statement, /api/download-ticket, /api/checkout, /api/customers, /api/suppliers ve auth ailesini içerir. Statik dosyaların sunulması ile API yetkisi farklıdır; sayfa kabuğu public olsa da hassas veri requireSession arkasındadır.
