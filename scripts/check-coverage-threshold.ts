// Fails CI if overall Solidity test coverage drops below a fixed floor.
//
// `npm run coverage` (solidity-coverage) writes the raw Istanbul coverage map
// to ./coverage.json at the repo root. This script turns that into a
// coverage/coverage-summary.json via sc-istanbul's own "report" command
// (solidity-coverage's bundled Istanbul fork — no extra dependency needed),
// then checks each of the four metrics against THRESHOLDS below.
//
// Usage: npm run coverage && npx hardhat run scripts/check-coverage-threshold.ts
// Exit code: 0 if every metric meets its threshold, 1 otherwise.

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.join(__dirname, '..');
const COVERAGE_JSON = path.join(REPO_ROOT, 'coverage.json');
const SUMMARY_JSON = path.join(REPO_ROOT, 'coverage', 'coverage-summary.json');
const ISTANBUL_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'istanbul');

// Measured baseline on 2026-09-12 (full suite): 97.45 / 87.48 / 98.41 / 98.11.
// Set a few points under that so routine work has margin before this gate
// turns red — branches gets the widest buffer since new code tends to add
// untested edge-case branches before it adds untested whole functions.
// Raise these as real coverage grows; this should only ever go up.
const THRESHOLDS = {
  statements: 95,
  branches: 82,
  functions: 95,
  lines: 95,
};

interface Metric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

interface CoverageSummary {
  total: {
    lines: Metric;
    statements: Metric;
    functions: Metric;
    branches: Metric;
  };
}

function main() {
  if (!fs.existsSync(COVERAGE_JSON)) {
    console.error(
      `check-coverage-threshold: ${COVERAGE_JSON} not found — run "npm run coverage" first.`,
    );
    process.exit(1);
  }

  execFileSync(
    ISTANBUL_BIN,
    ['report', '--root', REPO_ROOT, '--include', COVERAGE_JSON, 'json-summary'],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );

  const summary: CoverageSummary = JSON.parse(fs.readFileSync(SUMMARY_JSON, 'utf8'));

  let failed = false;
  console.log('check-coverage-threshold: overall coverage vs configured floor');
  for (const key of Object.keys(THRESHOLDS) as (keyof typeof THRESHOLDS)[]) {
    const pct = summary.total[key].pct;
    const floor = THRESHOLDS[key];
    const ok = pct >= floor;
    if (!ok) failed = true;
    console.log(
      `  ${ok ? 'OK  ' : 'FAIL'} ${key.padEnd(10)} ${pct.toFixed(2)}% (floor ${floor}%)`,
    );
  }

  if (failed) {
    console.error('\ncheck-coverage-threshold: coverage dropped below the configured floor.');
    process.exit(1);
  }
  console.log('\ncheck-coverage-threshold: OK — every metric meets its floor.');
}

main();
