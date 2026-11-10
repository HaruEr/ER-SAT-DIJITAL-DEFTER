import {createHash} from 'node:crypto';
import {eventVersion,replay} from '../domain.mjs';

// Test-only historical fixtures use the real restore validator. Never bypass
// current command policy or enable legacy writes in the application.
export function appendHistoricalEvent(repo,id,command,{actor}={}) {
  const backup=repo.backup();
  backup.events.push({id,command,schemaVersion:eventVersion(command,replay(backup.events)),timestamp:'2026-10-31T10:00:00.000Z',...(actor&&{audit:{version:1,actor}})});
  backup.sha256=createHash('sha256').update(JSON.stringify(backup.events)).digest('hex');
  repo.restore({backup,revision:repo.state().revision,confirmation:'GERİ YÜKLE'});
  return {state:repo.state()};
}
