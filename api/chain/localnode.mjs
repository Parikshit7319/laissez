// Starts a throwaway Hardhat node for tests and stops it on exit.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { HERE } from './lib.mjs';

/** Hardhat's well-known development keys (accounts #0 and #1). Never use them on a public network. */
export const DEV_KEYS = {
  operator: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  claim: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
};

async function rpcUp(url) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
    return r.ok;
  } catch { return false; }
}

export async function startNode(port = 8546) {
  const url = `http://127.0.0.1:${port}`;
  if (await rpcUp(url)) throw new Error(`Something is already listening on port ${port}. Stop it or pick another port.`);
  const bin = path.join(HERE, 'node_modules', '.bin', 'hardhat');
  const child = spawn(bin, ['node', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true' } });
  let output = '';
  child.stdout.on('data', (d) => { output = (output + d).slice(-4000); });
  child.stderr.on('data', (d) => { output = (output + d).slice(-4000); });
  const stop = () => { if (!child.killed) child.kill('SIGTERM'); };
  process.on('exit', stop);
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Hardhat node exited early:\n${output}`);
    if (await rpcUp(url)) return { url, stop };
    await new Promise((r) => setTimeout(r, 250));
  }
  stop();
  throw new Error(`Hardhat node did not start on ${url}:\n${output}`);
}
