// Every run creates a new synthetic ledger. It accepts no existing data path.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
const seed = spawnSync(process.execPath, [fileURLToPath(new URL('../qa-temp/supplier-uat-seed.mjs', import.meta.url))], {encoding:'utf8',windowsHide:true});
if (seed.status !== 0) throw new Error(seed.stderr || 'Synthetic seed failed');
const fixture = JSON.parse(seed.stdout);
const {server} = createApp({dataDirectory:fixture.directory});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`, ...fixture})));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close());
