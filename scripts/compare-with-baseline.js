#!/usr/bin/env node
// Compares two compiled checkouts of this repository (for example the CertiK-validated baseline
// and a feature branch) and reports what changed in the compiled contracts:
//
//   1. runtime bytecode of every contract (identical / metadata-hash-only / different),
//   2. PoolLogic's storage layout (baseline variables must be unchanged, new ones appended),
//   3. PoolLogic's ABI (nothing removed or changed).
//
// Usage:  node scripts/compare-with-baseline.js <baseline-checkout> <branch-checkout>
// Both checkouts must have been compiled with `npx hardhat compile` (the storage layout comes
// from the build info the OpenZeppelin upgrades plugin requests). Read-only: it only reads the
// artifacts directories.

const fs = require('fs');
const path = require('path');

const [baseDir, newDir] = process.argv.slice(2);
if (!baseDir || !newDir) {
    console.error(
        'usage: node scripts/compare-with-baseline.js <baseline-checkout> <branch-checkout>',
    );
    process.exit(2);
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (entry.name.endsWith('.json') && !entry.name.endsWith('.dbg.json')) out.push(p);
    }
    return out;
}

// The compiler appends CBOR metadata whose last two bytes give its length; it changes whenever
// any imported source changes, even when the executable code is identical.
function stripMetadata(hex) {
    const n = parseInt(hex.slice(-4), 16);
    return hex.slice(0, hex.length - 4 - n * 2);
}

function loadArtifacts(root) {
    const base = path.join(root, 'artifacts', 'contracts');
    const map = {};
    for (const file of walk(base)) {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!json.deployedBytecode || json.deployedBytecode === '0x') continue;
        map[path.relative(base, file)] = json;
    }
    return map;
}

const a = loadArtifacts(baseDir);
const b = loadArtifacts(newDir);
const identical = [];
const metadataOnly = [];
const different = [];
for (const key of Object.keys(a)) {
    if (!b[key]) continue;
    const x = a[key].deployedBytecode;
    const y = b[key].deployedBytecode;
    if (x === y) identical.push(key);
    else if (stripMetadata(x) === stripMetadata(y)) metadataOnly.push(key);
    else different.push(key);
}
const isMock = (k) => k.includes(`${path.sep}mocks${path.sep}`) || k.includes('/mocks/');
const onlyNew = Object.keys(b).filter((k) => !a[k]);
const onlyBase = Object.keys(a).filter((k) => !b[k]);

console.log('== Runtime bytecode (contracts present in both)');
console.log(
    `identical: ${identical.length}   metadata-hash only: ${metadataOnly.length}   different: ${different.length}`,
);
console.log(
    'different, non-mock :',
    different.filter((k) => !isMock(k)),
);
console.log('different, mock     :', different.filter(isMock));
console.log(
    'only in branch (non-mock):',
    onlyNew.filter((k) => !isMock(k)),
);
console.log('only in baseline    :', onlyBase);

function poolLogicLayout(root) {
    const dir = path.join(root, 'artifacts', 'build-info');
    let layout = null;
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json') || f.endsWith('.output.json')) continue;
        const info = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const c = info.output?.contracts?.['contracts/contracts/PoolLogic.sol']?.PoolLogic;
        if (c?.storageLayout) layout = c.storageLayout;
    }
    return layout;
}

console.log('\n== PoolLogic storage layout');
const la = poolLogicLayout(baseDir);
const lb = poolLogicLayout(newDir);
if (!la || !lb) {
    console.log(
        'storage layout not found in build info (compile with the upgrades plugin enabled)',
    );
} else {
    // Type identifiers embed compiler AST ids ("t_struct(X)1234_storage") that differ between two
    // builds of identical declarations, so they are normalised before comparing.
    const norm = (t) => t.replace(/\)\d+_storage/g, ')_storage');
    const fmt = (l) =>
        l.storage.map((s) => `${s.label}|slot ${s.slot}|offset ${s.offset}|${norm(s.type)}`);
    const x = fmt(la);
    const y = fmt(lb);
    const mismatches = x.filter((line, i) => line !== y[i]);
    console.log(`baseline variables: ${x.length}   branch variables: ${y.length}`);
    console.log(
        `baseline variables unchanged in label, slot, offset and type: ${mismatches.length === 0}`,
    );
    console.log(
        'appended:',
        y.slice(x.length).map((l) => l.split('|').slice(0, 2).join(' @ ')),
    );
}

console.log('\n== PoolLogic ABI');
const abiOf = (root) =>
    JSON.parse(
        fs.readFileSync(
            path.join(
                root,
                'artifacts',
                'contracts',
                'contracts',
                'PoolLogic.sol',
                'PoolLogic.json',
            ),
            'utf8',
        ),
    ).abi;
const typeOf = (i) => (i.type === 'tuple' ? `(${i.components.map(typeOf).join(',')})` : i.type);
const sig = (e) =>
    `${e.type}:${e.name || ''}(${(e.inputs || []).map(typeOf).join(',')})` +
    `${e.outputs ? '>' + e.outputs.map(typeOf).join(',') : ''}${e.stateMutability ? '#' + e.stateMutability : ''}`;
const sa = new Set(abiOf(baseDir).map(sig));
const sb = new Set(abiOf(newDir).map(sig));
const removed = [...sa].filter((s) => !sb.has(s));
const added = [...sb].filter((s) => !sa.has(s));
console.log(`baseline entries: ${sa.size}   branch entries: ${sb.size}`);
console.log(`removed or changed: ${removed.length}`, removed);
console.log(`added: ${added.length}`);
