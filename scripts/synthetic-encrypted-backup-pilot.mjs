import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, createReadStream, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Repository } from '../repository.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { DomainError, INITIAL_ACCOUNTS, currentCountPolicy, workdaySummary } from '../domain.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = resolve(sourceRoot, '..', 'temp');
const sentinel = 'PRIVATE_SYNTHETIC_LEDGER_MARKER';
const expectedBalances = { bilezikAdet: 9, bilezik22: 89000, ceyrek: 1, nakit: 950000, 'cari-buyer': 20000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pathKey = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
const samePath = (a,b) => pathKey(a) === pathKey(b);
function failure(code) { return Object.assign(new Error(`Synthetic backup pilot: ${code}`), { code }); }
function assertNoLinks(path) {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !samePath(realpathSync(current), current)) throw failure('PILOT_PATH_REJECTED');
    }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
function assertDevelopmentRoot() {
  assertNoLinks(sourceRoot);
}
export function validatePilotParent(parentDirectory = tempRoot) {
  assertDevelopmentRoot();
  if (typeof parentDirectory !== 'string' || !isAbsolute(parentDirectory)) throw failure('PILOT_PATH_REJECTED');
  const parent = resolve(parentDirectory), fromTemp = relative(tempRoot, parent);
  if (fromTemp === '..' || fromTemp.startsWith(`..${sep}`) || isAbsolute(fromTemp)) throw failure('PILOT_PATH_REJECTED');
  assertNoLinks(parent);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) throw failure('PILOT_PARENT_MISSING');
  return parent;
}
function pinnedTool(resticBinary) {
  assertDevelopmentRoot();
  let pin;
  try { pin = JSON.parse(readFileSync(join(sourceRoot, 'scripts', 'restic-pilot-tool.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw failure('PILOT_TOOL_MANIFEST_INVALID'); }
  if (!pin.version || !/^[a-f0-9]{64}$/i.test(pin.binarySha256 || '') || typeof pin.binaryPath !== 'string' || !pin.binaryPath) throw failure('PILOT_TOOL_MANIFEST_INVALID');
  // An explicit tool path is permitted, but its bytes must match the reviewed pin.
  // No download, PATH lookup, installation, or write to the supplied location occurs.
  const binary = resolve(sourceRoot, resticBinary || process.env.RESTIC_PILOT_BINARY || pin.binaryPath);
  assertNoLinks(binary);
  if (!existsSync(binary) || !lstatSync(binary).isFile()) throw failure('PILOT_TOOL_UNAVAILABLE');
  if (hash(readFileSync(binary)).toUpperCase() !== pin.binarySha256.toUpperCase()) throw failure('PILOT_TOOL_HASH_MISMATCH');
  return { binary, version: pin.version, binarySha256: pin.binarySha256.toUpperCase() };
}
export function validatePilotToolCopy(filename) {
  const tool=pinnedTool();validatePilotParent(dirname(filename));assertNoLinks(filename);
  if(!lstatSync(filename).isFile()||hash(readFileSync(filename)).toUpperCase()!==tool.binarySha256)throw failure('PILOT_TOOL_HASH_MISMATCH');
  return true;
}
function filesUnder(directory) {
  assertNoLinks(directory);
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const path = join(directory, item.name); assertNoLinks(path);
    if (item.isDirectory()) return filesUnder(path);
    if (!item.isFile()) throw failure('PILOT_UNEXPECTED_ARTIFACT');
    return [path];
  });
}
function checkOracle(state) {
  for (const [id,value] of Object.entries(expectedBalances)) assert.equal(state.balances[id], value, `Synthetic oracle: ${id}`);
  assert.equal(state.date, '2026-10-28');
  assert.equal(workdaySummary(state, '2026-10-27').totals.sales, 100000);
  assert.equal(workdaySummary(state, '2026-10-28').totals.sales, -40000);
}
const manifestLimit = 4096;
const manifestFilename = 'backup-manifest.json';
const manifestExclusions = ['restore_archive', 'identity', 'settings'];
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
function validateManifest(filename, archiveBytes, trustedManifest) {
  if (!existsSync(filename)) throw failure('MANIFEST_MISSING');
  assertNoLinks(filename);
  if (!lstatSync(filename).isFile()) throw failure('MANIFEST_INVALID');
  if (lstatSync(filename).size > manifestLimit) throw failure('MANIFEST_TOO_LARGE');
  // Bound the actual read as well as stat: never read arbitrary manifest size.
  const fd = openSync(filename, 'r'), buffer = Buffer.alloc(manifestLimit + 1);
  let length = 0;
  try {
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
  } finally { closeSync(fd); }
  if (length > manifestLimit) throw failure('MANIFEST_TOO_LARGE');
  let manifest;
  try { manifest = JSON.parse(buffer.subarray(0, length).toString('utf8')); }
  catch { throw failure('MANIFEST_INVALID'); }
  if (!exactKeys(manifest, ['manifestVersion', 'syntheticOnly', 'localOnly', 'coverage', 'exclusions', 'archive'])) throw failure('MANIFEST_INVALID');
  if (manifest.manifestVersion !== 1) throw failure('MANIFEST_VERSION_UNSUPPORTED');
  if (manifest.syntheticOnly !== true || manifest.localOnly !== true || manifest.coverage !== 'active-ledger-only'
      || JSON.stringify(manifest.exclusions) !== JSON.stringify(manifestExclusions)) throw failure('MANIFEST_SCOPE_INVALID');
  if (!exactKeys(manifest.archive, ['filename', 'byteHash', 'workspace', 'sourceRevision', 'captureAt', 'eventSchema'])) throw failure('MANIFEST_INVALID');
  if (manifest.archive.filename !== 'ledger.ndjson') throw failure('MANIFEST_ARCHIVE_NAME_INVALID');
  let header;
  try { header = JSON.parse(archiveBytes.toString('utf8').split('\n')[0]); }
  catch { throw failure('MANIFEST_BINDING_MISMATCH'); }
  const binding = { filename: 'ledger.ndjson', byteHash: hash(archiveBytes), workspace: header.workspace,
    sourceRevision: header.sourceRevision, captureAt: header.exportedAt, eventSchema: header.eventSchema };
  if (Object.keys(binding).some(key => manifest.archive[key] !== binding[key] || manifest.archive[key] !== trustedManifest.archive[key])) throw failure('MANIFEST_BINDING_MISMATCH');
  return manifest;
}
function createSyntheticSource(filename) {
  const repo = new Repository(filename, 'demo');
  try {
    const execute = (id,command) => repo.execute({ id, revision: repo.state().revision, command });
    const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,'0']));
    Object.assign(balances,{bilezikAdet:'10',bilezik22:'100',nakit:'10000'});
    execute('opening',{type:'opening',date:'2026-10-27',balances});
    execute('buyer',{type:'account',date:'2026-10-27',name:'Synthetic backup buyer',unit:'TL',partyType:'customer',opening:'0'});
    execute('sale',{type:'sale',date:'2026-10-27',counterpartyId:'cari-buyer',counterpartyType:'customer',
      items:[{accountId:'bilezikAdet',quantity:'2',weightAccount:'bilezik22',weight:'20',value:'1000'}],
      received:[{accountId:'ceyrek',quantity:'1',valueTL:'900'}],given:[{accountId:'nakit',quantity:'100',valueTL:'100'}],
      credits:[{accountId:'cari-buyer',quantity:'200',valueTL:'200'}],debts:[],note:sentinel});
    const counts=Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired&&a.physical&&currentCountPolicy(a)==='daily').map(a=>[a.id,'0']));
    Object.assign(counts,{bilezikAdet:'8',ceyrek:'1',nakit:'9900'});
    execute('close',{type:'close',date:'2026-10-27',nextDate:'2026-10-28',counts,reasons:{},approvedBy:'Synthetic backup count'});
    execute('return',{type:'saleReturn',date:'2026-10-28',originalId:'sale',items:[{lineIndex:0,quantity:'1',weight:'9',value:'400'}],refunds:[{accountId:'nakit',quantity:'400',valueTL:'400'}],note:'Synthetic measured partial return'});
    checkOracle(repo.state());return repo;
  } catch (error) { repo.close();throw error; }
}
function storedSnapshot(repo) {
  return JSON.stringify({ events:repo.db.prepare('SELECT * FROM events ORDER BY seq').all(),meta:repo.db.prepare('SELECT * FROM meta').all(),archives:repo.db.prepare('SELECT * FROM restore_archive').all() });
}
function seedProtectedTarget(repo) {
  const balances=Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'42':'0']));
  repo.execute({id:'protected-opening',revision:0,command:{type:'opening',date:'2026-10-26',balances}});
  repo.restore({backup:repo.backup(),revision:1,confirmation:'GERİ YÜKLE'});
  assert.equal(repo.state().revision,2);assert.equal(repo.state().balances.nakit,4200);
  assert.equal(repo.db.prepare('SELECT count(*) AS n FROM restore_archive').get().n,1);
}
function unchangedAfterReopen(repo,filename,workspace,before) {
  if(storedSnapshot(repo)!==before)return false;
  const reopened=new ReportRepository(filename,workspace);
  try {return storedSnapshot(reopened)===before&&reopened.overview().accounts.find(a=>a.id==='nakit').balance===4200;}
  finally {reopened.close();}
}

export async function runSyntheticEncryptedBackupPilot({ parentDirectory = tempRoot, resticBinary, exerciseFailures = false } = {}) {
  const parent = validatePilotParent(parentDirectory), tool = pinnedTool(resticBinary);
  const artifactDirectory = mkdtempSync(join(parent,'encrypted-backup-pilot-'));
  const directory = name => { const value=join(artifactDirectory,name);mkdirSync(value);return value; };
  const sourceDirectory=directory('synthetic-source'),payloadDirectory=directory('payload'),keyDirectory=directory('key-material');
  const repositoryDirectory=directory('encrypted-repository'),restoreDirectory=directory('restored-payload'),targetDirectory=directory('restored-database'),processTemp=directory('process-temp');
  const password=randomBytes(32).toString('hex'),passwordFile=join(keyDirectory,'key');
  writeFileSync(passwordFile,password+'\n',{flag:'wx',mode:0o600});
  const childEnvironment={SystemRoot:process.env.SystemRoot||'C:\\Windows',WINDIR:process.env.WINDIR||'C:\\Windows',TEMP:processTemp,TMP:processTemp};
  function inspectInFreshProcess(databaseFile, fault) {
    const before=hash(readFileSync(databaseFile)),helper=join(sourceRoot,'scripts','synthetic-restored-reader.mjs');
    assertNoLinks(helper);
    let args=[helper,databaseFile];
    // Fault wrappers still run the genuine readonly helper first. No user input
    // is interpolated as code, and these modes are not exposed by either CLI.
    if(fault==='malformed'||fault==='oracle') {
      const wrapper=fault==='malformed'
        ? "const {inspectSyntheticRestoredDatabase:inspect}=await import(process.argv[1]);inspect(process.argv[2]);console.log('{');"
        : "const {inspectSyntheticRestoredDatabase:inspect}=await import(process.argv[1]);const result=inspect(process.argv[2]);result.revision=2;console.log(JSON.stringify(result));";
      args=['--input-type=module','-e',wrapper,pathToFileURL(helper).href,databaseFile];
    }
    const child=spawnSync(process.execPath,args,{cwd:sourceRoot,env:childEnvironment,shell:false,windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:16384});
    if(hash(readFileSync(databaseFile))!==before)throw failure('CHILD_DATABASE_CHANGED');
    if(child.error||child.status!==0)throw Object.assign(failure('CHILD_READER_FAILED'),{childExit:child.status??null});
    let result;
    try {result=JSON.parse(child.stdout);}catch {throw failure('CHILD_RESULT_INVALID');}
    if(!exactKeys(result,['verified','pid','integrity','date','revision','balances','previousRevenue','currentRevenue','eventsHash'])
        ||!Number.isSafeInteger(result.pid)||result.pid<=0||result.pid===process.pid||result.pid!==child.pid)throw failure('CHILD_RESULT_INVALID');
    if(result.verified!==true||result.integrity!=='ok'||result.date!=='2026-10-28'||result.revision!==1
        ||result.previousRevenue!==100000||result.currentRevenue!==-40000||result.eventsHash!==sourceEventsHash
        ||!exactKeys(result.balances,Object.keys(expectedBalances))||Object.entries(expectedBalances).some(([id,value])=>result.balances[id]!==value))throw failure('CHILD_ORACLE_MISMATCH');
    return {...result,databaseBytesUnchanged:true};
  }
  function restic(operation,args,{repository=repositoryDirectory,key=passwordFile,cwd=payloadDirectory,binary=tool.binary}={}) {
    const result=spawnSync(binary,['--repo',repository,'--password-file',key,'--no-cache',...args],{cwd,env:childEnvironment,shell:false,windowsHide:true,encoding:'utf8',timeout:45000,maxBuffer:8*1024*1024});
    if(result.error||result.status!==0)throw Object.assign(failure(result.error?.code==='ENOENT'?'PILOT_TOOL_UNAVAILABLE':result.error?.code==='ETIMEDOUT'?'PILOT_TOOL_TIMEOUT':`RESTIC_${operation}_FAILED`),{childExit:result.status??null});
    return result.stdout;
  }
  const archive=join(payloadDirectory,'ledger.ndjson'),sourceFile=join(sourceDirectory,'synthetic.sqlite');
  let source=createSyntheticSource(sourceFile);
  const captureStart=performance.now();
  let sourceState,sourceEventsHash,exported;
  try { sourceState=source.state();sourceEventsHash=hash(JSON.stringify(source.events()));exported=source.exportArchive(archive); }
  finally { source.close();source=null; }
  const header=JSON.parse(readFileSync(archive,'utf8').split('\n')[0]);
  assert.equal(header.sourceRevision,sourceState.revision);
  const sourceByteHash=hash(readFileSync(sourceFile)),archiveByteHash=hash(readFileSync(archive));
  // This describes this pilot's active ledger only; it is not a full-system backup.
  const manifest = { manifestVersion: 1, syntheticOnly: true, localOnly: true, coverage: 'active-ledger-only',
    exclusions: [...manifestExclusions], archive: { filename: 'ledger.ndjson', byteHash: archiveByteHash,
      workspace: header.workspace, sourceRevision: header.sourceRevision, captureAt: header.exportedAt, eventSchema: header.eventSchema } };
  writeFileSync(join(payloadDirectory, manifestFilename), JSON.stringify(manifest), { flag: 'wx' });
  restic('INIT',['init','--json']);
  function createSnapshot(input=['ledger.ndjson', manifestFilename]) {
    const output=restic('BACKUP',['backup','--json','--host','synthetic-defter-pilot','--tag','synthetic-only',...input]);
    let summary;
    try { summary=output.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).find(value=>value.message_type==='summary'); }
    catch { throw failure('RESTIC_BACKUP_RESPONSE_INVALID'); }
    if(!/^[a-f0-9]{64}$/.test(summary?.snapshot_id||''))throw failure('RESTIC_SNAPSHOT_MISSING');
    return summary.snapshot_id;
  }
  const snapshotId=createSnapshot();
  const targetFile=join(targetDirectory,'synthetic-restored.sqlite');
  const verifiedPointFile=join(artifactDirectory,'last-verified-point.json');
  // Both the normal attempt and the fault-injected verification attempt use
  // this pipeline. A successful backup alone cannot publish a recovery point.
  async function verifyAndPublishSnapshot(candidateSnapshotId,restoreTo,databaseFile,alterRestoredBytes=false,manifestFault,childFault) {
    restic('RESTORE',['restore',candidateSnapshotId,'--target',restoreTo]);
    const candidates=filesUnder(restoreTo).filter(path=>path.endsWith('ledger.ndjson'));
    if(candidates.length!==1)throw failure('RESTIC_RESTORE_PAYLOAD_INVALID');
    const restoredArchive=candidates[0];
    const restoredManifestFile=join(dirname(restoredArchive),manifestFilename);
    // Private semantic fault injection after actual exact-snapshot decryption.
    // This does not claim ciphertext tamper authentication (tested separately).
    if(manifestFault)manifestFault(restoredManifestFile);
    const restoredManifest=validateManifest(restoredManifestFile,readFileSync(restoredArchive),manifest);
    const snapshotPayloadFiles=filesUnder(restoreTo).map(path=>relative(dirname(restoredArchive),path)).sort();
    if(JSON.stringify(snapshotPayloadFiles)!==JSON.stringify([manifestFilename,'ledger.ndjson']))throw failure('MANIFEST_PAYLOAD_INVALID');
    if(alterRestoredBytes){const bytes=readFileSync(restoredArchive);writeFileSync(restoredArchive,Buffer.concat([bytes,Buffer.from('synthetic verification fault')]));}
    const restoredArchiveByteHash=hash(readFileSync(restoredArchive));
    if(restoredArchiveByteHash!==archiveByteHash)throw failure('ARCHIVE_BYTE_HASH_MISMATCH');
    const target=new Repository(databaseFile,'demo');let restoredState,restoredEventsHash;
    try {
      await target.restoreArchive(createReadStream(restoredArchive),{revision:0,confirmation:'GERİ YÜKLE',temporaryDirectory:processTemp});
      restoredState=target.state();checkOracle(restoredState);restoredEventsHash=hash(JSON.stringify(target.events()));assert.equal(restoredEventsHash,sourceEventsHash);
    } finally { target.close(); }
    // All parent target handles are closed before the independent Node reader.
    if(childFault==='corrupt')writeFileSync(databaseFile,Buffer.from('synthetic corrupted candidate database'));
    const childVerification=inspectInFreshProcess(databaseFile,childFault),reopenedBalances=childVerification.balances;
    assert.equal(hash(readFileSync(sourceFile)),sourceByteHash);
    restic('VERIFY_CHECK',['check','--read-data']);
    if(filesUnder(repositoryDirectory).some(path=>readFileSync(path).includes(Buffer.from(sentinel))))throw failure('ENCRYPTED_REPO_PLAINTEXT_MARKER');
    const verifiedAt=new Date().toISOString(),point={captureAt:header.exportedAt,sourceRevision:exported.revision,snapshotId:candidateSnapshotId,verifiedAt,localOnly:true};
    const pending=join(artifactDirectory,`verified-point-${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(pending,JSON.stringify(point,null,2),{flag:'wx'});renameSync(pending,verifiedPointFile);
    return {restoredArchive,restoredArchiveByteHash,restoredState,restoredEventsHash,reopenedBalances,verifiedAt,point,restoredManifest,snapshotPayloadFiles,childVerification};
  }
  const {restoredArchive,restoredArchiveByteHash,restoredState,restoredEventsHash,reopenedBalances,verifiedAt,point,restoredManifest,snapshotPayloadFiles,childVerification}=await verifyAndPublishSnapshot(snapshotId,restoreDirectory,targetFile);
  const verifiedTargetHash=hash(readFileSync(targetFile));
  const pointHash=hash(readFileSync(verifiedPointFile)),failureChecks={};
  async function recordFailure(name,attempt,targetSnapshot=()=>hash(readFileSync(targetFile))===verifiedTargetHash,expectedCode) {
    let caught;
    try { await attempt(); } catch(error) { caught=error; }
    if(!caught)throw failure('EXPECTED_FAILURE_NOT_OBSERVED');
    const expectedCodes={wrongPassword:'RESTIC_WRONG_PASSWORD_FAILED',corruptEncryptedCopy:'RESTIC_CORRUPT_COPY_FAILED',unavailableTool:'PILOT_TOOL_UNAVAILABLE',unavailableRepository:'RESTIC_UNAVAILABLE_REPOSITORY_FAILED',failedBackup:'RESTIC_BACKUP_FAILED',successfulBackupFailedVerification:'ARCHIVE_BYTE_HASH_MISMATCH',staleRevision:'REVISION_CONFLICT',truncatedArchive:'ARCHIVE_INVALID'};
    const expectedCause=name==='wrongWorkspace'
      ? caught instanceof DomainError&&caught.status===400&&caught.message==='Arşivin çalışma alanı eşleşmiyor. Örnek ve dükkân kayıtları birbirine yüklenemez.'
      : caught.code===(expectedCode||expectedCodes[name]);
    if(!expectedCause)throw failure('UNEXPECTED_FAILURE_CAUSE');
    const unchanged=hash(readFileSync(verifiedPointFile))===pointHash;
    assert.equal(unchanged,true);
    const outcome={rejected:true,code:name==='wrongWorkspace'?'WORKSPACE_MISMATCH':caught.code,childExit:caught.childExit??null,lastVerifiedPointUnchanged:unchanged};
    outcome.targetUnchanged=targetSnapshot();assert.equal(outcome.targetUnchanged,true);
    failureChecks[name]=outcome;
  }
  if(exerciseFailures) {
    const wrongKey=join(keyDirectory,'wrong-key');writeFileSync(wrongKey,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
    await recordFailure('wrongPassword',()=>restic('WRONG_PASSWORD',['snapshots','--json'],{key:wrongKey}));
    const copiedRepository=join(artifactDirectory,'corrupted-repository-copy');
    filesUnder(repositoryDirectory);cpSync(repositoryDirectory,copiedRepository,{recursive:true,errorOnExist:true,force:false});
    const pack=filesUnder(join(copiedRepository,'data'))[0];if(!pack)throw failure('PILOT_PACK_MISSING');
    const corrupted=readFileSync(pack);corrupted[Math.floor(corrupted.length/2)]^=0xff;writeFileSync(pack,corrupted);
    await recordFailure('corruptEncryptedCopy',()=>restic('CORRUPT_COPY',['check','--read-data'],{repository:copiedRepository}));
    await recordFailure('unavailableTool',()=>restic('UNAVAILABLE',['snapshots','--json'],{binary:join(artifactDirectory,'absent-restic.exe')}));
    await recordFailure('unavailableRepository',()=>restic('UNAVAILABLE_REPOSITORY',['snapshots','--json'],{repository:join(artifactDirectory,'absent-repository')}));
    await recordFailure('failedBackup',()=>createSnapshot(['absent-synthetic-ledger.ndjson']));
    const candidateSnapshotId=createSnapshot(),faultRestore=directory('verification-failure-payload'),faultTarget=join(targetDirectory,'must-not-exist.sqlite');
    await recordFailure('successfulBackupFailedVerification',()=>verifyAndPublishSnapshot(candidateSnapshotId,faultRestore,faultTarget,true),()=>!existsSync(faultTarget)&&hash(readFileSync(targetFile))===verifiedTargetHash);
    failureChecks.successfulBackupFailedVerification.candidateSnapshotCreated=true;
    failureChecks.successfulBackupFailedVerification.candidateSnapshotId=candidateSnapshotId;
    for(const [name,mode,code] of [['childCorruptDatabase','corrupt','CHILD_READER_FAILED'],['childMalformedResult','malformed','CHILD_RESULT_INVALID'],['childOracleMismatch','oracle','CHILD_ORACLE_MISMATCH']]) {
      const candidateDirectory=directory(`fault-${name}`),candidateDatabase=join(targetDirectory,`${name}.sqlite`);
      await recordFailure(name,()=>verifyAndPublishSnapshot(snapshotId,candidateDirectory,candidateDatabase,false,undefined,mode),
        ()=>hash(readFileSync(targetFile))===verifiedTargetHash,code);
      Object.assign(failureChecks[name],{childAttempted:true,faultStage:'fresh-process-validation'});
    }
    const modifyManifest = change => filename => {
      const value=JSON.parse(readFileSync(filename,'utf8'));change(value);writeFileSync(filename,JSON.stringify(value));
    };
    const manifestFaults = {
      manifestMissing: ['MANIFEST_MISSING', filename=>unlinkSync(filename)],
      manifestMalformed: ['MANIFEST_INVALID', filename=>writeFileSync(filename,'{')],
      manifestOversized: ['MANIFEST_TOO_LARGE', filename=>writeFileSync(filename,' '.repeat(manifestLimit+1))],
      manifestVersion: ['MANIFEST_VERSION_UNSUPPORTED', modifyManifest(value=>value.manifestVersion=2)],
      manifestScope: ['MANIFEST_SCOPE_INVALID', modifyManifest(value=>value.coverage='full-system')],
      manifestPath: ['MANIFEST_ARCHIVE_NAME_INVALID', modifyManifest(value=>value.archive.filename='../ledger.ndjson')],
      manifestRevision: ['MANIFEST_BINDING_MISMATCH', modifyManifest(value=>value.archive.sourceRevision=6)],
      manifestWorkspace: ['MANIFEST_BINDING_MISMATCH', modifyManifest(value=>value.archive.workspace='dukkan')],
      manifestHash: ['MANIFEST_BINDING_MISMATCH', modifyManifest(value=>value.archive.byteHash='0'.repeat(64))],
      manifestCapture: ['MANIFEST_BINDING_MISMATCH', modifyManifest(value=>value.archive.captureAt='2026-01-01T00:00:00.000Z')],
      manifestEventSchema: ['MANIFEST_BINDING_MISMATCH', modifyManifest(value=>value.archive.eventSchema=99)],
      manifestUnknownField: ['MANIFEST_INVALID', modifyManifest(value=>value.keyMaterial='included')],
      manifestExclusions: ['MANIFEST_SCOPE_INVALID', modifyManifest(value=>value.exclusions=[])],
      manifestExtraPayload: ['MANIFEST_PAYLOAD_INVALID', filename=>writeFileSync(join(dirname(filename),'unexpected.txt'),'synthetic')],
      manifestCoherentHeader: ['MANIFEST_BINDING_MISMATCH', filename=>{
        const ledgerFile=join(dirname(filename),'ledger.ndjson'),lines=readFileSync(ledgerFile,'utf8').split('\n');
        const changedHeader=JSON.parse(lines[0]);changedHeader.sourceRevision=6;lines[0]=JSON.stringify(changedHeader);
        const changedBytes=Buffer.from(lines.join('\n'));writeFileSync(ledgerFile,changedBytes);
        modifyManifest(value=>{value.archive.sourceRevision=6;value.archive.byteHash=hash(changedBytes);})(filename);
      }]
    };
    for(const [name,[code,inject]] of Object.entries(manifestFaults)) {
      const faultDirectory=directory(`fault-${name}`),absentTarget=join(targetDirectory,`${name}-must-not-exist.sqlite`);
      await recordFailure(name,()=>verifyAndPublishSnapshot(snapshotId,faultDirectory,absentTarget,false,inject),
        ()=>!existsSync(absentTarget)&&hash(readFileSync(targetFile))===verifiedTargetHash,code);
      Object.assign(failureChecks[name],{targetCreated:false,restoredFromSnapshot:true,faultStage:'decrypted-manifest-validation'});
    }
    const wrongWorkspaceFile=join(targetDirectory,'wrong-workspace.sqlite'),wrongWorkspace=new Repository(wrongWorkspaceFile,'dukkan');
    try {
      seedProtectedTarget(wrongWorkspace);
      const before=storedSnapshot(wrongWorkspace);
      await recordFailure('wrongWorkspace',()=>wrongWorkspace.restoreArchive(createReadStream(restoredArchive),{revision:2,confirmation:'GERİ YÜKLE',temporaryDirectory:processTemp}),()=>unchangedAfterReopen(wrongWorkspace,wrongWorkspaceFile,'dukkan',before));
      Object.assign(failureChecks.wrongWorkspace,{protectedEventCount:1,protectedArchiveCount:1,protectedRevision:2,reopenedTargetUnchanged:true});
    } finally {wrongWorkspace.close();}
    const invalidTargetFile=join(targetDirectory,'negative-import.sqlite'),invalidTarget=new Repository(invalidTargetFile,'demo');
    try {
      seedProtectedTarget(invalidTarget);
      const before=storedSnapshot(invalidTarget);
      await recordFailure('staleRevision',()=>invalidTarget.restoreArchive(createReadStream(restoredArchive),{revision:1,confirmation:'GERİ YÜKLE',temporaryDirectory:processTemp}),()=>unchangedAfterReopen(invalidTarget,invalidTargetFile,'demo',before));
      const truncated=join(artifactDirectory,'truncated.ndjson'),bytes=readFileSync(restoredArchive);writeFileSync(truncated,bytes.subarray(0,Math.floor(bytes.length/2)),{flag:'wx'});
      await recordFailure('truncatedArchive',()=>invalidTarget.restoreArchive(createReadStream(truncated),{revision:2,confirmation:'GERİ YÜKLE',temporaryDirectory:processTemp}),()=>unchangedAfterReopen(invalidTarget,invalidTargetFile,'demo',before));
      for(const name of ['staleRevision','truncatedArchive'])Object.assign(failureChecks[name],{protectedEventCount:1,protectedArchiveCount:1,protectedRevision:2,reopenedTargetUnchanged:true});
    } finally {invalidTarget.close();}
  }
  restic('FINAL_CHECK',['check','--read-data']);
  assert.equal(hash(readFileSync(sourceFile)),sourceByteHash);assert.equal(hash(readFileSync(archive)),archiveByteHash);
  const encryptedRepoContainsSentinel=filesUnder(repositoryDirectory).some(path=>readFileSync(path).includes(Buffer.from(sentinel)));
  assert.equal(encryptedRepoContainsSentinel,false);
  const evidenceFile=join(artifactDirectory,'evidence.json');
  const evidence={status:'LOCAL_VERIFIED',syntheticOnly:true,localOnly:true,cloudVerified:false,rpoAccepted:false,rtoAccepted:false,
    captureAt:point.captureAt,sourceRevision:point.sourceRevision,snapshotId,verifiedAt,restoredRevision:restoredState.revision,
    toolVersion:tool.version,toolBinarySha256:tool.binarySha256,archiveEventHash:exported.sha256,archiveByteHash,restoredArchiveByteHash,
    sourceUnchanged:true,freshProcessVerified:true,failureChecks,localPilotDurationMs:Math.round(performance.now()-captureStart),artifactDirectory,evidenceFile,
    limits:'Local synthetic pilot only; no network provider, scheduler or real data. Artifacts retained. Sentinel absence is a smoke check, not an encryption proof. Key recovery and cloud RPO/RTO remain unverified.'};
  const serialized=JSON.stringify(evidence,null,2);assert.equal(serialized.includes(password),false);assert.equal(serialized.includes(passwordFile),false);
  writeFileSync(evidenceFile,serialized,{flag:'wx'});
  return {evidence,inspection:{childVerification,restoredManifest,snapshotPayloadFiles,sourceBalances:sourceState.balances,restoredBalances:restoredState.balances,reopenedBalances,
    sourceEventsHash,restoredEventsHash,previousRevenue:workdaySummary(restoredState,'2026-10-27').totals.sales,currentRevenue:workdaySummary(restoredState,'2026-10-28').totals.sales,
    evidenceContainsCredential:serialized.includes(password)||serialized.includes(passwordFile),encryptedRepoContainsSentinel}};
}

if(process.argv[1]&&samePath(process.argv[1],fileURLToPath(import.meta.url))) {
  try {
    const options={};
    for(let i=2;i<process.argv.length;i+=2){const flag=process.argv[i],value=process.argv[i+1];if(!value||!['--parent','--restic-bin'].includes(flag))throw failure('PILOT_ARGUMENT_REJECTED');options[flag==='--parent'?'parentDirectory':'resticBinary']=value;}
    const {evidence}=await runSyntheticEncryptedBackupPilot(options);console.log(JSON.stringify(evidence,null,2));
  } catch(error) {console.error(JSON.stringify({status:'FAILED',code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'PILOT_VERIFICATION_FAILED',localOnly:true,syntheticOnly:true}));process.exitCode=1;}
}
