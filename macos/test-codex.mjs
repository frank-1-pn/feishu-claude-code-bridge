import fs from 'node:fs';import os from 'node:os';import {spawnSync} from 'node:child_process';
import path from 'node:path';import {fileURLToPath} from 'node:url';
const daemon=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../daemon');
const tests=fs.readdirSync(daemon).filter(n=>n.endsWith('.test.mjs')).map(n=>path.join(daemon,n));
process.exitCode=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit',env:{...process.env,TMPDIR:fs.realpathSync(os.tmpdir())}}).status??1;
