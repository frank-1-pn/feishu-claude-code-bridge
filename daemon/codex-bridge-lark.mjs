import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { cliFailure } from './codex-bridge-retry.mjs';

export function capture(file, args, { cwd, env = process.env, input, timeoutMs = 120000, children } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children?.add(child);
    const decoder = new StringDecoder('utf8'); let stdout = '', bytes = 0, failure;
    const timer = setTimeout(() => { failure = Object.assign(Error('request_timeout'), { code: 'ETIMEDOUT' }); child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { failure = Error('response_too_large'); child.kill(); return; }
      stdout += decoder.write(chunk);
    });
    child.stderr.resume(); // Do not retain credential-bearing raw diagnostics.
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); children?.delete(child); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); children?.delete(child); stdout += decoder.end();
      if (failure) { reject(failure); return; }
      // A nonzero CLI can still return a useful structured API error.
      resolve({ code, stdout });
    });
    child.stdin.end(input);
  });
}

export function createLarkTransport(executable, { run = capture, children, cwd: defaultCwd } = {}) {
  return async (binding, originalArgs, cwd = defaultCwd) => {
    const args = [...originalArgs]; let input;
    const data = args.indexOf('--data');
    if (data >= 0) { input = args[data + 1]; args[data + 1] = '-'; }
    const result = await run(executable, [...(binding.profile ? ['--profile', binding.profile] : []), ...args, '--as', 'bot'],
      { cwd, input, children, env: { ...process.env, LARK_CLI_NO_PROXY: '1' } });
    let response;
    try { response = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, '')); }
    catch { throw Object.assign(Error('invalid_cli_response'), { code: 'INVALID_RESPONSE' }); }
    if (result.code !== 0 || response.ok === false) throw cliFailure(response);
    const dataBody = response.data ?? response;
    if (typeof dataBody.code === 'number' && dataBody.code !== 0) throw cliFailure(dataBody);
    if (typeof response.code === 'number' && response.code !== 0) throw cliFailure(response);
    return dataBody.code === 0 && dataBody.data ? dataBody.data : dataBody;
  };
}
