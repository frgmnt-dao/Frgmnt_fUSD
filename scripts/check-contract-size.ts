// EIP-170: a contract's deployed (runtime) bytecode may not exceed 24,576 bytes,
// or every call into it reverts post-deployment regardless of what the code does.
// EIP-3860: a contract's *init code* (constructor bytecode, i.e. `bytecode` in the
// Hardhat artifact) may not exceed 49,152 bytes, or CREATE/CREATE2 itself reverts.
//
// This repo has hit the EIP-170 limit more than once (see the per-file `runs: 1` +
// `viaIR` overrides in hardhat.config.ts for PoolLogic.sol and two asset guards) —
// this script turns "discovered at deploy time" into "caught in CI, before merge".
//
// Usage: npx hardhat run scripts/check-contract-size.ts
// Exit code: 0 if every contract is within both limits (the warning margin is
// advisory only), 1 if any contract exceeds either hard limit.

import * as fs from 'fs';
import * as path from 'path';

interface HardhatArtifact {
  contractName: string;
  sourceName: string;
  bytecode: string;
  deployedBytecode: string;
}

interface SizeRow {
  name: string;
  source: string;
  deployedLen: number;
  initLen: number;
}

const ARTIFACTS_DIR = path.join(__dirname, '..', 'artifacts', 'contracts', 'contracts');

const DEPLOYED_BYTECODE_LIMIT = 24576; // EIP-170
const INIT_CODE_LIMIT = 49152; // EIP-3860
const WARN_HEADROOM_BYTES = 1500; // advisory only — flags a shrinking margin early

function findArtifactJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findArtifactJsonFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.json') &&
      !entry.name.endsWith('.dbg.json')
    ) {
      out.push(full);
    }
  }
  return out;
}

function hexByteLength(hex: string | undefined): number {
  if (!hex || hex === '0x') return 0;
  return (hex.length - 2) / 2;
}

function main() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    console.error(
      `check-contract-size: ${ARTIFACTS_DIR} does not exist — run "npm run compile" first.`,
    );
    process.exit(1);
  }

  const files = findArtifactJsonFiles(ARTIFACTS_DIR);
  const rows: SizeRow[] = [];

  for (const file of files) {
    const artifact: HardhatArtifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Abstract contracts, interfaces, and libraries with no external/deployed
    // presence all compile to empty bytecode — nothing to size-check.
    const deployedLen = hexByteLength(artifact.deployedBytecode);
    if (deployedLen === 0) continue;

    const initLen = hexByteLength(artifact.bytecode);
    rows.push({
      name: artifact.contractName,
      source: artifact.sourceName,
      deployedLen,
      initLen,
    });
  }

  rows.sort((a, b) => b.deployedLen - a.deployedLen);

  const failures: string[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    const deployedHeadroom = DEPLOYED_BYTECODE_LIMIT - row.deployedLen;
    const initHeadroom = INIT_CODE_LIMIT - row.initLen;

    if (row.deployedLen > DEPLOYED_BYTECODE_LIMIT) {
      failures.push(
        `  ${row.name} (${row.source}): deployed bytecode ${row.deployedLen} bytes ` +
          `exceeds the EIP-170 limit of ${DEPLOYED_BYTECODE_LIMIT} by ${-deployedHeadroom} bytes`,
      );
    } else if (deployedHeadroom <= WARN_HEADROOM_BYTES) {
      warnings.push(
        `  ${row.name} (${row.source}): ${row.deployedLen} bytes deployed, ` +
          `only ${deployedHeadroom} bytes of EIP-170 headroom left`,
      );
    }

    if (row.initLen > INIT_CODE_LIMIT) {
      failures.push(
        `  ${row.name} (${row.source}): init code ${row.initLen} bytes ` +
          `exceeds the EIP-3860 limit of ${INIT_CODE_LIMIT} by ${-initHeadroom} bytes`,
      );
    }
  }

  console.log(`check-contract-size: checked ${rows.length} deployable contracts.`);
  console.log(`Top 5 by deployed bytecode size:`);
  for (const row of rows.slice(0, 5)) {
    console.log(
      `  ${String(row.deployedLen).padStart(6)} bytes  (${DEPLOYED_BYTECODE_LIMIT - row.deployedLen} headroom)  ${row.name}`,
    );
  }

  if (warnings.length > 0) {
    console.log(`\nWarnings (within limit, but headroom is low — advisory only):`);
    warnings.forEach((w) => console.log(w));
  }

  if (failures.length > 0) {
    console.error(`\nFAIL: ${failures.length} contract(s) exceed a hard-coded EVM size limit:`);
    failures.forEach((f) => console.error(f));
    console.error(
      `\nA contract over these limits will fail to deploy regardless of correctness. ` +
        `See the per-file optimizer overrides in hardhat.config.ts (runs: 1, viaIR: true) ` +
        `for the pattern already used to claw back headroom on oversized contracts.`,
    );
    process.exit(1);
  }

  console.log(
    '\ncheck-contract-size: OK — every contract is within both EIP-170 and EIP-3860 limits.',
  );
}

main();
