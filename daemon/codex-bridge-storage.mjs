import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const transient = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

// A Windows reader may temporarily deny rename. Never unlink the old record:
// it remains the authoritative checkpoint until replacement succeeds.
export function atomicWriteText(file, value, { io = fs, wait = ms => Atomics.wait(sleeper, 0, 0, ms) } = {}) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    io.writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { io.renameSync(tmp, file); return; }
      catch (error) {
        if (!transient.has(error.code) || attempt === 4) throw error;
        wait(10 * 2 ** attempt);
      }
    }
  } finally {
    try { io.rmSync(tmp, { force: true }); } catch {}
  }
}

export function atomicWriteJson(file, value, options) {
  atomicWriteText(file, `${JSON.stringify(value)}\n`, options);
}

// Telemetry must not abort business processing. Durable queue writes above
// still throw: their callers must retry without advancing a source cursor.
export function createStatusPublisher(file, { write = atomicWriteJson, now = Date.now, onError = () => {}, intervalMs = 5000 } = {}) {
  let nextAt = 0;
  let failures = 0;
  let lastFailure = null;
  return value => {
    const at = now();
    if (at < nextAt) return false;
    nextAt = at + intervalMs;
    try {
      write(file, { ...value, status_write_failures: failures, last_status_write_error: lastFailure });
      return true;
    } catch (error) {
      failures++;
      lastFailure = { at: new Date(at).toISOString(), code: error.code ?? 'WRITE_FAILED' };
      try { onError(lastFailure); } catch {}
      return false;
    }
  };
}
