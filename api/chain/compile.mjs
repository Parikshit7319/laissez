// Compiles contracts/*.sol with the solc npm package and writes ABIs and bytecode to api/chain/artifacts.json.
// Usage: node api/chain/compile.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../contracts');
const out = path.join(here, 'artifacts.json');

function collect(dir, base = dir, acc = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, base, acc);
    else if (entry.name.endsWith('.sol')) acc[path.relative(base, full).split(path.sep).join('/')] = { content: fs.readFileSync(full, 'utf8') };
  }
  return acc;
}

export function compile() {
  const sources = collect(root);
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const result = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (result.errors ?? []).filter((e) => e.severity === 'error');
  for (const w of (result.errors ?? []).filter((e) => e.severity !== 'error')) console.warn(w.formattedMessage);
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    throw new Error(`Solidity compilation failed with ${errors.length} error(s).`);
  }
  const wanted = ['LaissezCash', 'LaissezOnboarder', 'LaissezDvP', 'AuditAnchor', 'Multicall3Lite'];
  const artifacts = { compiler: solc.version(), contracts: {} };
  for (const [file, contracts] of Object.entries(result.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      if (!wanted.includes(name)) continue;
      artifacts.contracts[name] = { source: `contracts/${file}`, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedSize: c.evm.deployedBytecode.object.length / 2 };
    }
  }
  for (const n of wanted) if (!artifacts.contracts[n]) throw new Error(`Contract ${n} was not found in contracts/.`);
  fs.writeFileSync(out, JSON.stringify(artifacts, null, 1));
  return artifacts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = compile();
  for (const [n, c] of Object.entries(a.contracts)) console.log(`${n.padEnd(18)} ${String(c.deployedSize).padStart(6)} bytes  ${c.source}`);
  console.log(`Compiled with solc ${a.compiler}. Wrote ${path.relative(process.cwd(), out)}`);
}
