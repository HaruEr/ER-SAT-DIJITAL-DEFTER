import { IdentityStore, IdentityError } from './identity.mjs';
import { deny, requireSession, DownloadTickets, checkoutState, customerChoices, customerDetail, requireWorkerTrade, requireWorkerAccounts } from './editor-access.mjs';
import http from 'node:http';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Repository, BACKUP_MAX_BYTES } from './repository.mjs';
import { DomainError, fail, isWorkerCustomerCreation } from './domain.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url));
const diagnosticCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE', 'ERR_SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CORRUPT', 'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_IOERR', 'BACKUP_HISTORY_INVALID', 'STORED_HISTORY_INVALID']);
const operations = new Map(['state', 'summary', 'backup', 'command', 'restore', 'recovery'].map(name => [`/api/${name}`, name]));
operations.set('/api/archive', 'archive');
operations.set('/api/archive/restore', 'archive-restore');
operations.set('/api/journal', 'journal');
operations.set('/api/item-photo', 'item-photo');
operations.set('/api/account-statement', 'account-statement');
const staticFiles = new Map([
  ['/', ['login.html', 'text/html; charset=utf-8']],
  ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/access-client.js', ['access-client.js', 'text/javascript; charset=utf-8']],
  ['/draft-store.js', ['draft-store.js', 'text/javascript; charset=utf-8']],
  ['/amount-codec.js', ['amount-codec.js', 'text/javascript; charset=utf-8']],
  ['/date-format.js', ['date-format.js', 'text/javascript; charset=utf-8']],
  ['/ui-kit.js', ['ui-kit.js', 'text/javascript; charset=utf-8']],
  ['/search-norm.js', ['search-norm.js', 'text/javascript; charset=utf-8']],
  ['/combobox.js', ['combobox.js', 'text/javascript; charset=utf-8']],
  ['/command-palette.js', ['command-palette.js', 'text/javascript; charset=utf-8']],
  ['/users', ['users.html', 'text/html; charset=utf-8']],
  ['/users.js', ['users.js', 'text/javascript; charset=utf-8']],
  ['/access.css', ['access.css', 'text/css; charset=utf-8']],
  ['/motion.css', ['motion.css', 'text/css; charset=utf-8']],
  ['/ui-prefs.js', ['ui-prefs.js', 'text/javascript; charset=utf-8']],
  ['/checkout', ['checkout.html', 'text/html; charset=utf-8']],
  ['/checkout.js', ['checkout.js', 'text/javascript; charset=utf-8']],
  ['/owner', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/suppliers.js', ['suppliers.js', 'text/javascript; charset=utf-8']],
  ['/supplier-pdf.js', ['supplier-pdf.js', 'text/javascript; charset=utf-8']],
  ['/vendor/pdfmake/pdfmake.min.js', ['vendor/pdfmake/pdfmake.min.js', 'text/javascript; charset=utf-8']],
  ['/vendor/pdfmake/vfs_fonts.js', ['vendor/pdfmake/vfs_fonts.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
export function createApp({ dataDirectory = path.join(directory, 'data'), logger = record => console.error(JSON.stringify(record)), jsonBodyTimeoutMs = 15000 } = {}) {
  mkdirSync(dataDirectory, { recursive: true });
  let identities;
  const downloads = new DownloadTickets();
  const repositories = new Map();
  function repo(workspace) {
    if (!['demo', 'dukkan'].includes(workspace)) fail('Çalışma alanı demo veya dukkan olmalı.');
    if (!repositories.has(workspace)) repositories.set(workspace, new Repository(path.join(dataDirectory, `${workspace}.sqlite`), workspace));
    return repositories.get(workspace);
  }
  const server = http.createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
    let operation = 'request', workspace = null;
    function json(status, value, extra = {}) {
      // Serialization can fail; do it before committing response headers.
      const content = JSON.stringify(value);
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
      res.end(content);
    }
    async function readJson(bodyLimit) {
      const chunks = []; let length = 0;
      const expired = Symbol('json-body-timeout'); let bodyTimer;
      const deadline = new Promise(resolve => { bodyTimer = setTimeout(() => resolve(expired), jsonBodyTimeoutMs); });
      const iterator = req[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await Promise.race([iterator.next(), deadline]);
          if (next === expired) {
            res.once('finish', () => req.destroy());
            json(408, { error: 'İstek zamanında tamamlanmadı. Kayıt oluşturulmadı.' }, { Connection: 'close' });
            return;
          }
          if (next.done) break;
          length += next.value.length;
          if (length > bodyLimit) {
            res.once('finish', () => req.destroy());
            json(413, { error: bodyLimit > 8 * 1024 * 1024 ? 'Geri yükleme isteği desteklenen 64 MiB yedek ve işlem bilgisi sınırını aşıyor.' : 'İstek boyut sınırını aşıyor.' }, { Connection: 'close' });
            return;
          }
          chunks.push(next.value);
        }
      } finally { clearTimeout(bodyTimer); }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('JSON dosyası okunamadı.'); }
      if (!data || Array.isArray(data) || typeof data !== 'object') fail('Geçersiz işlem içeriği.');
      return data;
    }
    try {
      // Editing is local-only. Serve/proxy traffic belongs to the separate reader.
      const proxyMarked = req.rawHeaders.some((name, index) => index % 2 === 0 && /^(?:forwarded$|x-forwarded-|x-real-ip$|tailscale-)/i.test(name));
      const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (!localPeer || proxyMarked) return json(403, { error: 'Bu adres yalnız ana bilgisayarda düzenleme içindir. Uzak erişimde rapor portalını kullanın.' });
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) return json(403, { error: 'Yalnız bu cihazdaki yerel adres destekleniyor.' });
      const base = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== base) return json(403, { error: 'Farklı kaynaktan isteğe izin verilmiyor.' });
      const url = new URL(req.url, base);
      operation = operations.get(url.pathname) || 'request';
      const requestedWorkspace = url.searchParams.get('workspace') || 'demo';
      if (['demo', 'dukkan'].includes(requestedWorkspace)) workspace = requestedWorkspace;
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        const content = readFileSync(path.join(directory, 'public', file));
        res.writeHead(200, { ...headers, 'Content-Type': type }); return res.end(content);
      }
      if (!url.pathname.startsWith('/api/')) return json(404, { error: 'Sayfa bulunamadı.' });
      identities ??= new IdentityStore(dataDirectory);
      let token = req.headers.authorization?.match(/^Bearer ([-_A-Za-z0-9]+)$/)?.[1];
      if (req.method === 'GET' && (operation === 'backup' || operation === 'archive') && url.searchParams.has('ticket')) {
        token = downloads.consume(url.searchParams.get('ticket'), operation, requestedWorkspace);
      }
      if (url.pathname === '/api/auth/users' && req.method === 'GET') {
        const currentActor = identities.session(token);
        const canList = Boolean(currentActor && currentActor.role === 'owner' && !currentActor.mustChangePin);
        return json(200, { setup: identities.needsSetup(), users: canList ? identities.listUsers() : [] });
      }
      const authAction = url.pathname.slice('/api/auth/'.length);
      if (url.pathname.startsWith('/api/auth/')) {
        if (authAction === 'session' && req.method === 'GET') return json(200, requireSession(identities, token));
        if (req.method !== 'POST' || !['setup','login','logout','employees','disable','change-pin','reset-pin','rename'].includes(authAction)) {
          return json(404, { error: 'İşlem bulunamadı.' });
        }
        if (['employees','disable','reset-pin','rename','logout','change-pin'].includes(authAction)) {
          const actor = requireSession(identities, token);
          if (['employees','disable','reset-pin','rename'].includes(authAction) && (actor.role !== 'owner' || actor.mustChangePin)) deny();
        }
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(415, { error: 'JSON içeriği gerekli.' });
        const data = await readJson(8192);
        if (!data) return;
        if (authAction === 'logout') { identities.logout(token); return json(200, { ok: true }); }
        if (authAction === 'change-pin') return json(200, { actor: await identities.changePin(token, data) });
        if (authAction === 'reset-pin') return json(200, await identities.resetEmployeePin(token, data));
        if (authAction === 'rename') return json(200, { user: identities.renameUser(token, data) });
        if (authAction === 'employees') return json(201, await identities.createEmployee(token, data));
        if (authAction === 'disable') { identities.disableUser(token, data.id); return json(200, { ok: true }); }
        const pin = data.pin ?? data.password;
        let session;
        if (authAction === 'setup') {
          const owner = await identities.initializeOwner(data);
          session = await identities.login(owner.id, pin);
        } else if (typeof data.id === 'string' && data.id.trim()) {
          session = await identities.login(data.id, pin);
        } else {
          session = await identities.loginByName(data.name, pin);
        }
        if (!session) return json(401, { error: 'Giriş başarısız. Kullanıcı adı ve 6 haneli PIN kodunu kontrol edip yeniden deneyin.' });
        return json(authAction === 'setup' ? 201 : 200, session);
      }
      let actor = requireSession(identities, token);
      if (actor.mustChangePin) return json(403, { error: 'Devam etmek için geçici PIN kodunuzu değiştirmeniz gerekiyor.', code: 'PIN_CHANGE_REQUIRED' });
      const revokeForRestore = () => {
        if (requireSession(identities, token).role !== 'owner') deny();
        // Invalidate before financial COMMIT: a process crash must not preserve a stale writer.
        identities.invalidateSessions();
      };
      const worker = actor.role === 'employee';
      if (actor.role !== 'owner' && !worker) deny();
      if (worker && !(req.method === 'POST' && (operation === 'command' || url.pathname === '/api/pending-approvals')) &&
          !(req.method === 'GET' && ['/api/checkout','/api/customers','/api/pending-approvals'].includes(url.pathname))) deny();
      if (req.method === 'GET' && url.pathname === '/api/pending-approvals') {
        const repository = repo(requestedWorkspace);
        const userNamesById = new Map(identities.listUsers().map(u => [u.id, u.name]));
        if (worker) {
          const items = repository.listPending({ status: 'all', submittedById: actor.id, limit: 30, userNamesById });
          return json(200, { items });
        }
        const status = url.searchParams.get('status') || 'pending';
        const submittedById = url.searchParams.get('employeeId') || '';
        const type = url.searchParams.get('type') || 'all';
        const startDate = url.searchParams.get('startDate') || '';
        const endDate = url.searchParams.get('endDate') || '';
        const summaryOnly = url.searchParams.get('summary') === '1';
        const pendingCount = repository.pendingCount();
        if (summaryOnly) return json(200, { pendingCount });
        const items = repository.listPending({ status, submittedById, type, startDate, endDate, limit: 200, userNamesById, includeComparison: true });
        const analytics = repository.employeeAnalytics({ submittedById, startDate, endDate, userNamesById });
        const knownEmployees = new Map();
        for (const u of identities.listUsers()) if (u.id !== actor.id) knownEmployees.set(u.id, u.name);
        for (const emp of analytics.byEmployee) if (!knownEmployees.has(emp.id)) knownEmployees.set(emp.id, emp.name);
        const employees = [...knownEmployees.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
        return json(200, { pendingCount, items, analytics, employees });
      }
      if (req.method === 'POST' && ['/api/pending-approvals', '/api/pending-approvals/approve', '/api/pending-approvals/reject'].includes(url.pathname)) {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON içeriği gerekli.' });
        const data = await readJson(2 * 1024 * 1024);
        if (!data) return;
        actor = requireSession(identities, token);
        const repository = repo(requestedWorkspace);
        if (url.pathname === '/api/pending-approvals') {
          if (data.command?.type === 'dailyCount') {
            const submitted = repository.submitPending(data, { actor });
            return json(201, submitted);
          }
          requireWorkerTrade(data.command);
          if (data.command?.type === 'account') fail('Yeni müşteri kartı doğrudan kaydedilir.');
          requireWorkerAccounts(data.command, repository.state({ compact: true }));
          const submitted = repository.submitPending(data, { actor });
          return json(201, submitted);
        }
        if (actor.role !== 'owner') deny();
        if (url.pathname === '/api/pending-approvals/approve') {
          const compact = url.searchParams.get('view') === 'compact';
          const result = repository.approvePending({ id: data.id, commandOverride: data.command || null, revision: data.revision, actor }, { compact });
          result.state.pendingApprovalCount = repository.pendingCount();
          return json(200, result);
        }
        return json(200, repository.rejectPending({ id: data.id, reason: data.reason, actor }));
      }
      if (req.method === 'POST' && url.pathname === '/api/download-ticket') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(415, { error: 'JSON içeriği gerekli.' });
        const data = await readJson(1024);
        if (!data) return;
        requireSession(identities, token);
        return json(200, { url: downloads.issue(token, data.operation, requestedWorkspace) });
      }
      // Defer opening financial files until write authorization is decided.
      const repository = operation === 'command' ? null : repo(requestedWorkspace);
      if (req.method === 'GET' && url.pathname === '/api/item-photo') return json(200, repository.itemPhoto(url.searchParams.get('code')));
      if (req.method === 'GET' && url.pathname === '/api/checkout') return json(200, checkoutState(repository.state({ compact: true }), { hidePrivatePools: worker }));
      if (req.method === 'GET' && url.pathname === '/api/customers') {
        const state = repository.state({ compact:true });
        if (url.searchParams.has('id')) return json(200, customerDetail(state, url.searchParams.get('id')));
        const limitParam = url.searchParams.get('limit');
        if (limitParam !== null && (!/^\d+$/.test(limitParam) || Number(limitParam) < 1)) fail('Geçerli sayfa boyutu seçin.');
        const limit = limitParam === null ? 20 : Math.min(50, Number(limitParam));
        const meta = url.searchParams.get('meta') === '1';
        return json(200, customerChoices(state, url.searchParams.get('q') || '', { limit, meta }));
      }
      const compact = url.searchParams.get('view') === 'compact';
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const st = repository.state({ compact });
        if (compact) st.pendingApprovalCount = repository.pendingCount();
        return json(200, st);
      }
      if (req.method === 'GET' && url.pathname === '/api/suppliers') {
        const limit = url.searchParams.get('limit');
        if (limit !== null && !/^\d+$/.test(limit)) fail('Geçerli sayfa boyutu seçin.');
        const documents=url.searchParams.get('documents');
        if(documents!==null&&documents!=='omit')fail('Belge görünümü geçersiz.');
        return json(200, repository.supplierDetail({ supplierId:url.searchParams.get('supplierId') || '', editOriginalId:url.searchParams.get('editOriginalId') || undefined, startDate:url.searchParams.get('startDate') || '', endDate:url.searchParams.get('endDate') || '', limit:limit === null ? 50 : Number(limit), cursor:url.searchParams.get('cursor') || undefined, includeDocuments:documents!=='omit' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/journal') {
        const limit = url.searchParams.get('limit');
        if (limit !== null && !/^\d+$/.test(limit)) fail('Geçerli defter sayfa boyutu seçin.');
        return json(200, repository.journalPage({ scope: url.searchParams.get('scope') || 'today', q: url.searchParams.get('q') || '', type: url.searchParams.get('type') || 'all', limit: limit === null ? 50 : Number(limit), cursor: url.searchParams.get('cursor') || undefined, startDate: url.searchParams.get('startDate') || '', endDate: url.searchParams.get('endDate') || '', accountId: url.searchParams.get('accountId') || '', unit: url.searchParams.get('unit') || '', status: url.searchParams.get('status') || 'all', scrapForSale:url.searchParams.get('scrapForSale') || '', scrapForAdvance:url.searchParams.get('scrapForAdvance') || '' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/account-statement') return json(200, repository.accountStatement({ accountId: url.searchParams.get('accountId') || '', startDate: url.searchParams.get('startDate') || '', endDate: url.searchParams.get('endDate') || '' }));
      if (req.method === 'GET' && url.pathname === '/api/recovery') return json(200, repository.recoveryInfo());
      if (req.method === 'GET' && url.pathname === '/api/archive') {
        const temporaryRoot = path.join(dataDirectory, '.archive-temp'); mkdirSync(temporaryRoot, { recursive: true });
        const temporaryDirectory = mkdtempSync(path.join(temporaryRoot, 'ledger-export-'));
        try {
          const filename = path.join(temporaryDirectory, 'ledger.ndjson');
          const result = repository.exportArchive(filename);
          res.writeHead(200, { ...headers, 'Content-Type': 'application/x-ndjson', 'Content-Length': result.bytes, 'Content-Disposition': `attachment; filename="kuyumcu-${repository.workspace}-${new Date().toISOString().slice(0, 10)}.ndjson"` });
          await pipeline(createReadStream(filename), res);
        } finally {
          if (path.dirname(path.resolve(temporaryDirectory)) !== path.resolve(temporaryRoot)) throw new Error('Invalid temporary archive directory.');
          rmSync(temporaryDirectory, { recursive: true, force: true });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/archive/restore') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/x-ndjson') return json(415, { error: 'NDJSON arşiv içeriği gerekli.' });
        const revision = url.searchParams.get('revision');
        if (!revision || !/^\d+$/.test(revision)) fail('Geçerli ekran sürümü gerekli.');
        const receipt = await repository.restoreArchive(req, { beforeCommit: revokeForRestore, revision: Number(revision), confirmation: url.searchParams.get('confirmation'), temporaryDirectory: path.join(dataDirectory, '.archive-temp') });
        return json(200, { ...receipt, reauthenticate:true });
      }
      if (req.method === 'GET' && url.pathname === '/api/summary') {
        const paginated = url.searchParams.get('paginated') === '1' || url.searchParams.has('page') || url.searchParams.has('pageSize');
        if (!paginated) return json(200, repository.workdaySummary(url.searchParams.get('date') || undefined));
        const pageParam = url.searchParams.get('page');
        const pageSizeParam = url.searchParams.get('pageSize');
        if (pageParam !== null && (!/^\d+$/.test(pageParam) || Number(pageParam) < 1)) fail('Geçerli sayfa numarası seçin.');
        if (pageSizeParam !== null && (!/^\d+$/.test(pageSizeParam) || Number(pageSizeParam) < 1)) fail('Geçerli sayfa boyutu seçin.');
        return json(200, repository.workdaySummary(url.searchParams.get('date') || undefined, {
          paginated: true,
          page: pageParam ? Number(pageParam) : 1,
          pageSize: pageSizeParam ? Math.min(200, Number(pageSizeParam)) : 50,
          kind: url.searchParams.get('kind') || 'all',
          unit: url.searchParams.get('unit') || '',
          q: url.searchParams.get('q') || '',
          active: url.searchParams.get('active') === '1' || url.searchParams.get('active') === 'true'
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/backup') return json(200, repository.backup(), { 'Content-Disposition': `attachment; filename="kuyumcu-${url.searchParams.get('workspace') || 'demo'}-${new Date().toISOString().slice(0, 10)}.json"` });
      if (req.method !== 'POST' || !['/api/command', '/api/restore'].includes(url.pathname)) return json(404, { error: 'İşlem bulunamadı.' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON içeriği gerekli.' });
      // Restore includes a small JSON envelope around a supported backup file.
      const bodyLimit = url.pathname === '/api/restore' ? BACKUP_MAX_BYTES + 64 * 1024 : 8 * 1024 * 1024;
      const data = await readJson(bodyLimit);
      if (!data) return;
      actor = requireSession(identities, token);
      if (url.pathname === '/api/command') {
        if (worker) {
          if (!isWorkerCustomerCreation(data.command)) {
            return json(403, { error: 'Çalışan satış ve alış işlemleri doğrudan deftere işlenemez; Yönetici Onay Kuyruğuna gönderilmelidir.', code: 'APPROVAL_REQUIRED' });
          }
          requireWorkerTrade(data.command);
        }
        const repository = repo(requestedWorkspace);
        if (!worker && data.command?.type === 'close' && repository.pendingCount() > 0) {
          return json(409, { error: 'Onay bekleyen çalışan işlemleri var. Gün kapanışından önce Onay Bekleyenler ekranından tüm bildirimleri onaylayın veya reddedin.', code: 'PENDING_APPROVALS_EXIST' });
        }
        if (worker) requireWorkerAccounts(data.command, repository.state({ compact: true }));
        const result = repository.execute(data, { compact: compact || worker, actor });
        if (!worker && compact && result?.state) result.state.pendingApprovalCount = repository.pendingCount();
        if (worker) {
          const account = data.command.type === 'account' ? result.state.accounts.find(a => a.id === 'cari-' + data.id) : null;
          return json(200, { id:data.id, revision:result.state.revision, duplicate:result.duplicate,
            ...(account && {account:{id:account.id,name:account.name,unit:account.unit}}) });
        }
        if (data.command.type === 'close') {
          // Closing is already durable. A backup failure must never pretend it rolled back.
          try {
            const backupDirectory = path.join(dataDirectory, 'backups', repository.workspace);
            mkdirSync(backupDirectory, { recursive: true });
            const filename = `kapanis-${data.command.date}-${randomUUID()}.json`;
            const backup = repository.backup();
            const fullPath = path.join(backupDirectory, filename);
            // The exact file uses the same compact representation checked by backup().
            writeFileSync(fullPath, JSON.stringify(backup), { encoding: 'utf8', flag: 'wx', flush: true });
            if (JSON.stringify(JSON.parse(readFileSync(fullPath, 'utf8'))) !== JSON.stringify(backup)) throw new Error('Yedek doğrulaması başarısız.');
            result.backupStatus = { saved: true, filename };
          } catch (backupError) {
            result.backupStatus = { saved: false, error: backupError instanceof DomainError && backupError.code === 'BACKUP_TOO_LARGE'
              ? 'Gün kapandı ve kayıtlar SQLite’a işlendi; geçmiş desteklenen 64 MiB JSON yedek sınırını aşıyor. Bu geçmiş için ayrı kurtarma desteği gerekir; kayıtları silmeyin veya kaynak veritabanını değiştirmeyin.'
              : 'Gün kapandı ve kayıtlar SQLite’a işlendi; dosya yedeği alınamadı. Yedek indir düğmesiyle hemen ayrı bir kopya alın.' };
          }
        }
        return json(200, result);
      }
      return json(200, { state: repository.restore(data, { compact, beforeCommit:revokeForRestore }), reauthenticate:true });
    } catch (e) {
      const expected = e instanceof DomainError || e instanceof IdentityError;
      if (!expected) {
        // Never log raw messages, stacks, file paths, request IDs or ledger data.
        try {
          const code = diagnosticCodes.has(e?.code) ? e.code : 'INTERNAL_ERROR';
          logger({ event: 'request_failed', operation, workspace, code });
        } catch { /* A failed diagnostic sink cannot alter the request outcome. */ }
      }
      if (res.destroyed || res.headersSent) { res.destroy(); return; }
      return json(expected ? e.status : 500, { error: expected ? e.message : 'İşlem tamamlanamadı. Son isteğin sonucunu Yenile ile kontrol edin; gerekirse aynı işlem anahtarıyla yeniden deneyin.' });
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.on('close', () => { identities?.close(); for (const r of repositories.values()) r.close(); });
  return { server, repositories };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 1024–65535 arasında olmalı.');
  const { server } = createApp();
  server.on('error', e => { console.error(`Yerel sunucu başlatılamadı: ${e.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Kuyumcu günlük defter: http://127.0.0.1:${port}\nÖrnek ve dükkân verileri ayrı SQLite dosyalarındadır. Kapatmak için Ctrl+C.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
