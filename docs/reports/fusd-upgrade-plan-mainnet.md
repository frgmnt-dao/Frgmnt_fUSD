# fUSD — Mainnet Upgrade Plan (Core Contracts, Guards, Multisig Execution)

**Status: planning only. Nothing in this document has been executed. No transaction described below has been sent, and no contract has been deployed on Base mainnet as part of this plan.** Every address, role, and on-chain value in Section 1 was read directly from Base mainnet (chain 8453) immediately before this report was written — none of it is taken from prior notes without re-checking.

The live fUSD/sfUSD deployment has never been upgraded since its original launch. Every fix closed during this engagement — both SoftStack's findings (Stage 1 and Stage 2, numbered M-XX/L-XX) and CertiK's findings (numbered FNA-01 through FNA-60) — exists only in source code today; none of it is live. This plan describes exactly what needs to be redeployed, registered, and signed to bring the live system up to the current branch — and, because the deployment is governed by a multisig rather than a single key, how to actually build and execute those transactions through Gnosis Safe.

## 1. Current live state (verified on-chain)

### 1.1 Core proxies — all four still on the original implementation

Read directly via each proxy's EIP-1967 implementation slot (`cast implementation`), not inferred:

| Proxy | Proxy address | Live implementation | Matches `docs/deployments.md` |
| --- | --- | --- | --- |
| AssetHandler | `0x387174F4B3676c7F6e06da9c6c855375B5b10AAB` | `0x938A17D2830302828A7c3C2DC688517eF363236C` | Yes — original |
| PoolManagerLogic | `0x9530E699E519D7BCF621BA7CA17e119B6865b5C7` | `0xB49Db5579a99c30Fb4204eC400a398D404acc08b` | Yes — original |
| PoolLogic (sfUSD) | `0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E` | `0x3dE5AB1b21f3AeA66b69c90550A93425109a00C2` | Yes — original |
| TokenLogic (fUSD, UUPS) | `0xeB82611A2B2dC9FBEAF5903d5decDf801765B759` | `0x4DC02b3450B0659095096C474Da2C31E817BCd6c` | Yes — original |

Confirms none of the SoftStack/FNA fixes are live yet. Current `TokenLogic.totalSupply()`: 118,808.395510829777144311 fUSD.

### 1.2 Custody — two Safes and one EOA, not "everything needs the same multisig"

| Role | Holder | What it is | Confirmed |
| --- | --- | --- | --- |
| `AssetHandler.owner()` | `0x74aF72D91D5FB263fBa09Ed43aD1C1ea079058B3` | **DAO Safe** — Gnosis Safe v1.4.1, 4 owners, threshold **3**, nonce **12** | `getOwners`/`getThreshold`/`nonce` read live |
| `PoolLogic.owner()` | same DAO Safe | — | read live |
| `Governance.owner()` | same DAO Safe | — | read live |
| All 4 ProxyAdmins' `owner()` (AssetHandler, PoolManagerLogic, PoolLogic, NftTrackerStorage) | same DAO Safe | — | read live, all 4 |
| `TokenLogic`'s `DEFAULT_ADMIN_ROLE` | same DAO Safe | `hasRole(0x00, DAO_SAFE)` returns `true` | read live |
| `PoolManagerLogic.manager()` | `0x18f84Ea9D3351081780d817e5edd554112CF81Ab` | **Pool Manager Safe** — a genuinely separate Gnosis Safe v1.4.1, 3 owners, threshold **2**, nonce **4** | `getOwners`/`getThreshold`/`nonce` read live; confirmed by its bytecode (`GnosisSafeProxy`), not assumed |
| `MorphoBlueManager.owner()`, `SlippageAccumulator.owner()`, `NftTrackerStorage.owner()` | same Pool Manager Safe | — | read live, all 3 |
| `PoolManagerLogic.trader()` | `0x4D444F4a7e13d0Fd0c06eC301e6047Db62f636a0` | **Plain EOA** — zero bytecode, confirmed | `cast code` returns `0x` |
| `AaveV3LendingPoolAssetGuard.owner()`, `UniswapV3AssetGuard.admin()` | `0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d` | **Stale, retired EOA** — the deployer wallet from launch, zero bytecode confirmed. Never consolidated onto either Safe. | `cast code` returns `0x` |

The DAO Safe owns every proxy's upgrade authority and three of the four core contracts' admin surface. The Pool Manager Safe is a second, smaller multisig that owns the manager role and a handful of guard/manager contracts — it is real multisig custody, not a single key, but it is a *different* signer group from the DAO Safe and must not be assumed to sign automatically alongside it. Two of the guard contracts are still sitting on a retired single-key EOA and need their ownership moved as part of this upgrade, not just their code.

### 1.3 Known live gaps this upgrade must close

- `AssetHandler.sequencerUptimeFeed()` reads the zero address — the Chainlink L2 sequencer-uptime check (FNA-50) is unset on the live system.
- The live `SlippageAccumulator`'s `poolFactory` is `private immutable` — set once at deployment, no public getter, and un-fixable by calling anything on the existing instance. Decoded directly from its deployed runtime bytecode (immutables are embedded as literal values, not storage reads): it holds the `PoolLogic` address, not `PoolManagerLogic` (the pool-factory-mixup bug). This blocks every slippage check the Uniswap router/NFT guards depend on, and the only fix is deploying a brand-new instance with the correct constructor argument (Phase B, Section 3).
- `NftTrackerStorage.poolFactory()` resolves to `0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E` (PoolLogic) instead of PoolManagerLogic — the same class of misconfiguration, on a different contract, and the live implementation doesn't even have the `setPoolFactory()` escape hatch yet (confirmed: the fix function does not exist in the deployed bytecode).
- `MorphoBlueManager.owner()` equals `PoolManagerLogic.manager()` (the Pool Manager Safe) — this is exactly the self-dealing condition the new `MorphoBlueManager`'s M-11 check exists to prevent. `MorphoBlueManager.getPoolMarkets(POOL_LOGIC_PROXY)` currently returns 10 real market IDs — the live pool has real Morpho exposure that must be replayed onto any replacement, not dropped.
- `AaveV3LendingPoolAssetGuard.owner()` and `UniswapV3AssetGuard.admin()` are the stale, retired EOA noted above.

### 1.4 Hard precondition: zero pending withdrawal requests at the moment Phase A executes

`scripts/utils/upgradePreflight.ts`'s `assertNoPendingWithdrawals()` — called automatically by the core upgrade script before it builds the Phase A batch — exists because of a real, specific hazard: `PoolLogic.pendingCashWithdrawCount` (introduced by FNA-60) does not exist on the live implementation, so it initializes to 0 for every asset regardless of how many withdrawal requests were already `Pending` before the upgrade. `finalizeCashWithdraw()` on any of those pre-existing requests then does a checked decrement against that zero counter and reverts with an arithmetic panic — permanently, since there is no cancel path. That requester's fUSD would stay locked until a further code change specifically rescues it.

Checked fresh for this report: `PoolLogic.lastRequestId()` currently reads **0** — no withdrawal request has ever been queued against the live pool, so there is nothing pending today. This is time-sensitive, not a one-time fact: it must be re-checked immediately before Phase A's Safe batch is actually executed (the script does this automatically and refuses to proceed otherwise, short of explicitly setting `ALLOW_PENDING_WITHDRAWALS=1` — treat needing that flag as a stop-and-investigate signal, not a routine override), not only during planning.

## 2. Phase A — core contract proxies

Despite its filename, this script carries far more than SoftStack's own findings. The bulk of CertiK's ~60 FNA findings live inside the logic of `PoolLogic`, `TokenLogic`, `PoolManagerLogic`, and `AssetHandler` themselves (NAV accrual, fee handling, deposit/withdraw accounting, asset-removal guards, and so on) — those land automatically the moment each proxy's implementation is swapped, with no separate call needed. Only the FNA fixes that need their own explicit step beyond "upgrade the implementation" are called out below (FNA-03, FNA-40, FNA-50) — the rest are simply what the new implementation bytecode already does differently from the live one.

Implemented in `scripts/upgrade_softstack_core_contracts.ts` (already in the working tree, dry-run by default, never executed). What it does, in order:

**Deploys (permissionless, anyone can pay gas):**
- Libraries: `FundCalculationLibrary`, `CallResultChecker`, `PoolTxExecutor`, `WithdrawalPlanLib`.
- A new `WithdrawalEscrow` and a new `FrgmntUserActions` (constructor-bound to the live TokenLogic and PoolLogic proxy addresses) — confirmed neither exists on mainnet today.
- New implementations: `AssetHandler`, `PoolManagerLogic`, `TokenLogic` (validated against the live proxies via `@openzeppelin/upgrades-core`'s `forceImport`/`validateUpgrade`), and `PoolLogic` (deployed directly, linked against all four libraries above — storage safety for this one rests on a manual, tool-verified slot diff rather than `forceImport`, since externally linked libraries aren't supported the same way).

**Two different upgrade mechanisms, not one** — `AssetHandler`, `PoolManagerLogic`, and `PoolLogic` are Transparent proxies, each with its own dedicated ProxyAdmin (all three confirmed `owner() == DAO_SAFE` in 1.2); their upgrade call is `ProxyAdmin.upgradeAndCall(proxy, newImplementation, data)`, sent to the **ProxyAdmin**, not to the proxy itself. `TokenLogic` is UUPS with no external ProxyAdmin at all (`docs/deployments.md` notes its admin slot is the zero address) — its upgrade call is `upgradeToAndCall(newImplementation, data)` sent directly to the **TokenLogic proxy address**, authorized by `DEFAULT_ADMIN_ROLE` (confirmed `== DAO_SAFE` in 1.2). Anyone building the Safe batch by hand rather than trusting the script's own encoding should not assume all four proxies share one calling pattern.

**Mandatory initializers that must land atomically with their proxy upgrade** (skipping any of these leaves the pool in a broken state, not a degraded one):
- `PoolLogic.initializeAutoCompounding()` — `onlyOwner`, `reinitializer(2)`. Without it, `compoundedRewardIndex` stays zero and every reward-gated action reverts.
- `TokenLogic.initializeDepositFusdCap(newCap)` — `onlyRole(DEFAULT_ADMIN_ROLE)`, `reinitializer(2)`. Without it the cap defaults to zero and every deposit reverts.
- `PoolLogic.initializeWithdrawalEscrow(escrow)` — binds the new `WithdrawalEscrow` to the pool (FNA-03).
- `PoolManagerLogic.setUserActionsRouter(router)` — `onlyFactoryOwner`, i.e. `msg.sender == factoryOwner` (a distinct field from the ProxyAdmin's own `owner()`). Re-checked fresh for this report: `PoolManagerLogic.owner()` (which returns `factoryOwner`) **is** the DAO Safe — confirming this call is correctly gated for inclusion in the same DAO Safe batch as everything else, not a separate, overlooked signer. A plain setter, not reinitializer-gated, but still bundled in the same batch. Needs the freshly deployed `FrgmntUserActions` address from this same run.
- `AssetHandler.setSequencerUptimeFeed(feed)` — closes the FNA-50 gap confirmed unset in 1.3.
- `AssetHandler.clearEurUsdAggregator()` — locks the live system into USD-only valuation permanently (FNA-40). fUSD never used EUR conversion, but this makes that basis explicit and irreversible rather than implicit.

**Storage-layout safety**, already tool-verified on this branch: `AssetHandler.__gap` shrinks 50→47 (3 new slots), `PoolManagerLogic.__gap` shrinks 20→19 (1 new slot, `userActionsRouter`), `TokenLogic.__gap` shrinks 40→38 (2 new slots). `PoolLogic` has no `__gap` at all — its safety rests on confirming every new variable is appended strictly after all pre-existing ones, which has been checked.

**Contract-size headroom**, re-checked against this exact working tree just before writing this report (`npm run check:contract-size`): `PoolLogic` compiles to 23,763 bytes, 813 bytes of EIP-170 headroom remaining. Within budget today; re-run this check before every future PoolLogic change, since this margin shrinks with each fix.

Running the script with no `SEND` env var writes a Gnosis Safe Transaction Builder batch to `deployments/softstack-upgrade-dao-safe-<chainId>.json` and, only if any role is found outside the DAO Safe (not the case here — see 1.2), a second `deployments/softstack-upgrade-governance-roles-<chainId>.json`. `SEND=1` broadcasts directly and is refused outright against `mainnet`/`base` unless `ALLOW_MAINNET_SEND=1` is also set — a deliberate double guard against ever broadcasting this with a single key by accident.

## 3. Phase B — guard redeployment and registration

Implemented in `scripts/upgrade_softstack_guards.ts` (already in the working tree, dry-run by default, never executed). Independent of Phase A — plain contracts, not part of the four proxies' storage, can be proposed before, after, or alongside it.

**What it redeploys and why:**

| Guard / manager | Finding closed | Live config replayed onto the new instance |
| --- | --- | --- |
| `SlippageAccumulator` | underlies M-09/M-12/M-14 | `decayTime`, `maxCumulativeSlippage` read from the live instance and passed to the new one's constructor |
| `UniswapV3RouterGuard` | M-09/M-12 — per-swap output floor + multi-hop validation; also incidentally fixes the live pool-factory-mixup block on all router swaps | bound to the new `SlippageAccumulator` |
| `UniswapV3NonfungiblePositionGuard` | M-14 — LP mint/increase loss accounting | bound to the new `SlippageAccumulator`, same NFT position limit (50) |
| `MorphoBlueManager` + `MorphoBlueContractGuard` | M-11 — rejects a pool whose manager/trader is its own owner | the live pool's 10 real Morpho market IDs are read and replayed via `setPoolMarkets()` onto the new manager **before** it is registered anywhere, and the replay count is checked to match exactly |
| `AaveV3LendingPoolAssetGuard` | M-08 | no swap route configured live — confirmed not needed (see note below) |
| `UniswapV3AssetGuard` | M-06, FNA-16, FNA-58 — found during a full guard-by-guard audit pass, not originally scoped into either script | no config to replay; the live instance's values already match this contract's hardcoded defaults |
| `NftTrackerStorage` implementation | fixes the pre-existing `poolFactory` misconfiguration noted in 1.3 | implementation-only upgrade; `initialize()` is not re-called, storage is preserved |

This guard's swap route is only ever needed to settle Aave V3 **debt** — the live pool's variable debt balance for USDC is confirmed 0, re-checked fresh for this report (`AaveProtocolDataProvider.getUserReserveData`), not assumed. The live Aave V3 USDC **supply** position is also negligible today (aUSDC balance ≈ $0.005) — an earlier working note calling this a "large" position no longer holds; the pool's ~$121k NAV is concentrated elsewhere (Morpho Blue has 10 live configured markets — see 1.3 — though this report didn't trace NAV to a specific breakdown). Doesn't change the guard conclusion, which rests on debt being zero, not on supply size.

**Ownership handover**, sent unconditionally by the deploying key (not owner-gated, since the deployer is the only legitimate owner of something it just deployed): every new guard/manager above is deployed owned by the deployer, then transferred to the DAO Safe in the same run — including `AaveV3LendingPoolAssetGuard` (bespoke `setOwner()`, not OZ `Ownable`) and `UniswapV3AssetGuard` (bespoke `admin`/`setAdmin()`), closing the stale-EOA custody gap from 1.3 for both, not just the two SoftStack explicitly named.

**Idempotency check**: before doing anything, the script reads Governance's current registration for each guard slot it's about to touch and compares it against the known pre-upgrade addresses. If any slot has already moved, it refuses to run (preventing a second, careless run from silently orphaning a correct prior deployment) unless `FORCE_REDEPLOY=1` is explicitly set.

### 3.1 Three more live, registered guards also changed — not yet covered by either script

The table above only lists what `upgrade_softstack_guards.ts` actually redeploys. Diffing every single file under `contracts/contracts/guards/` against `audit` (not just the ones either script already names) surfaces three more guards that are different from what's live, currently registered, and **not handled by either existing script**:

| Guard | Live registration (confirmed) | What changed |
| --- | --- | --- |
| `AaveLendingPoolGuardV3` (contract guard for the Aave V3 Pool itself, distinct from the asset guard above) | `Governance.contractGuards(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5)` = `0x7Ef5442f796bF1Ae3e00E91a5527cAa5F7aba5A4` — re-checked fresh | FNA-24: `withdraw()` used to only run its post-transaction health-factor check when Aave still reported the withdrawn reserve as collateral-enabled *after* the withdrawal — which Aave clears automatically on a withdrawal that empties the aToken balance, so a full withdrawal of a collateral asset skipped the check entirely while an otherwise-identical partial withdrawal didn't. Now unconditional on every `withdraw()`. |
| `ERC20Guard` (asset guard, Type 4 — governs every plain ERC20 the pool holds, confirmed `0x26E11DC5C05ee07Cb14A2Fd475C71aAEd2F0A98C` registered live) | `Governance.assetGuards(4)` | Two fixes: FNA-03 follow-up blocks an `approve()` from granting a spender the ability to pull more than the pool's *unreserved* balance (previously `approve()` itself moved no balance, so the existing reserved-balance post-call check could never catch an over-large allowance — the spender could call `transferFrom()` on their own schedule, long after the guarded call passed); FNA-53 removes a cross-asset dependency loop this guard used to run on every asset removal, now centralized in `PoolManagerLogic._removeAsset()` instead. |
| `MorphoBlueLendingPoolAssetGuard` (deployed and documented as **"MorphoBlueAssetGuard"**, Type 1, confirmed `0x27BeceFb6CF59b26CD73dac227Ae3597065E2850` registered live — same file/contract, just a different name in `docs/deployments.md` than the Solidity file, matching the same naming mismatch already known for the Aave V3 asset guard) | `Governance.assetGuards(1)` | Substantially rewritten (373 lines changed) relative to `audit` — distinct from `MorphoBlueManager`/`MorphoBlueContractGuard` above, which this script does redeploy. Its constructor takes `morphoManager_` as an argument, so it must be deployed **after** the new `MorphoBlueManager` in the same run, bound to that new address, not the old one — an ordering dependency this script's existing deploy sequence would need to accommodate. |

None of these three has a documented reason for being left out — they simply weren't in either script's original scope. `ERC20Guard` is the most consequential gap: it is the asset guard for every ordinary ERC20 the pool holds, and both of its fixes close a real fund-safety gap (a delayed-drain path via `approve()`, and a cross-asset removal check). Extending `upgrade_softstack_guards.ts` (or a follow-up script in the same pattern) to cover these three, following the exact same deploy → replay-if-needed → ownership-handover → Safe-batch structure already used for everything else in this section, should happen before Phase B is considered complete — this report does not treat Phase B as ready to execute until that extension exists and has itself been dry-run and reviewed.

**Two separate Safe batches, two separate signers, strict ordering** — this is the part most likely to be gotten wrong by anyone unfamiliar with the custody split in 1.2:

1. `deployments/softstack-guards-dao-safe-<chainId>.json` — signed by the **DAO Safe**. Five `Governance.setContractGuard`/`setAssetGuard` calls, plus the NftTrackerStorage `ProxyAdmin.upgradeAndCall` (the DAO Safe owns that ProxyAdmin). Must be proposed and executed **first**.
2. `deployments/softstack-guards-pool-manager-safe-<chainId>.json` — signed by the **Pool Manager Safe**, a different signer group entirely. Two calls: `NftTrackerStorage.setPoolFactory(PoolManagerLogic)` (the fix itself — this function literally does not exist on-chain until batch 1's implementation upgrade lands, so proposing this first will simply fail), then `NftTrackerStorage.transferOwnership(DAO_SAFE)` (closing the one remaining custody gap not yet consolidated onto the DAO Safe). Order between these two calls also matters: `setPoolFactory` must run while the Pool Manager Safe still owns the contract.

## 4. Phase C (optional) — the newer, dormant guard families

Not part of either SoftStack script. These exist in the current branch and were already deployed, registered, and verified for real on the separate fEURO mainnet pool this engagement set up (`docs/reports/feuro-mainnet-internal-deployment.md`); the same treatment can be mirrored for fUSD, but nothing here closes an audit finding against the live fUSD system — it's additive infrastructure, not a fix.

- **Aave V4 Spoke** and **Aave V4 Tokenization** (manager + contract guard + asset guard each). On the fEURO deployment these were deployed and registered but never used with real capital, because Aave V4 on Base has no EURC market. fUSD is USDC-denominated, and Aave V4 on Base does have USDC-side V4 markets (the Equities Hub / Tokenization Spoke) — worth re-confirming current Aave V4 market availability for USDC specifically before deciding whether to actually route capital through this, as opposed to just deploying the guards as ready infrastructure.
- **Morpho Vault V2** (manager + contract guard + asset guard). Same "deploy and register, decide separately whether to allocate" treatment.
- **MerklRewardClaimGuard** — this is not purely new infrastructure for fUSD the way it was for fEURO. fUSD's own deployment log already shows a `MorphoBlueRewardClaimGuard` deployed at `0x0F61cDAa75395f89695E89bFC85EC74044fBb2Af`, and the current branch's source confirms this was renamed to `MerklRewardClaimGuard` under FNA-19 (same contract, same doc comment — "Guard allowing PoolLogic to claim Morpho rewards (Merkl)" — now generalized to also cover Aave V4 Spoke's Merkl incentives), not a new, separate guard. **Unresolved before this is proposed**: `Governance.contractGuards(0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae)` (the real Merkl Distributor, the address this guard is *supposed* to be registered against per the current branch's own deploy script comment) reads the zero address on fUSD's live Governance today — so the old guard is not registered there. Where it actually *is* registered (if anywhere) was not established: a direct event scan for its registration was attempted and came back empty against the block range checked, and the public RPC's 200-block `eth_getLogs` cap makes a full historical scan impractical without a working block-explorer API. Find the real target (Basescan's UI, not blocked the way the API is, is the fastest path) before treating this as a routine Phase C addition — if the old guard turns out to be registered against some other address, redeploying the new one against the Merkl Distributor alone would leave that other, stale registration untouched.
- **The four Selective asset guards** (Aave V3, Morpho Blue, Uniswap V3, Aave V4 Spoke). Back the attested/selective withdrawal plan feature. Deploying them is itself the verification step (deploy with the same immutables as the live counterpart, confirm the values match, hand ownership to the same owner) — they are never installed as the *active* registered guard for their asset type, since `Governance.setAssetGuard()` is global per type and swapping one in would change live behavior for a feature not in use.

None of this is owner-gated against anything that doesn't already belong to the deployer at construction time, except the final ownership handover (DAO Safe) and, if any of these are ever promoted to *active* via `Governance.setAssetGuard`/`setContractGuard`, that promotion itself. Recommend treating Phase C as a separate, later Safe batch rather than bundling it with Phases A/B — it has no dependency on either and no urgency.

## 5. Sequencing across phases

1. **Phase A, Phase 1** (permissionless deploys) — can run anytime, at any gas price, by anyone willing to front the cost. Produces the new implementation/library addresses.
2. **Phase A, Phase 2 batch** — propose and execute via the DAO Safe. Must land before Phase B's NftTrackerStorage fix (batch 2 below) can be proposed, but has no ordering requirement relative to Phase B's guard registrations.
3. **Phase B, Phase 1** (permissionless deploys + ownership handover to the DAO Safe) — independent of Phase A, can run in parallel.
4. **Phase B, DAO Safe batch** — propose and execute. No dependency on Phase A.
5. **Phase B, Pool Manager Safe batch** — propose only after step 4 above has executed (hard dependency: `setPoolFactory` doesn't exist on-chain until then).
6. **Phase C** — whenever convenient, no dependency on the others.

Net: two batches need the DAO Safe's signatures (Phase A's and Phase B's — these can be two separate proposals or combined into one if preferred), and one batch needs the Pool Manager Safe's signatures, strictly after the DAO Safe's guard batch.

## 6. Building and executing the Gnosis Safe transactions

This is the mechanical part — how a JSON file on disk becomes an executed, multisig-approved mainnet transaction.

### 6.1 What you're actually signing

Both Safes are standard Gnosis Safe v1.4.1 contracts (confirmed via their own `VERSION()` getter) — not a custom contract, so the ordinary Safe tooling at [app.safe.global](https://app.safe.global) works unmodified. The DAO Safe requires 3 of its 4 owners to approve; the Pool Manager Safe requires 2 of its 3. A Safe transaction is only ever executed once enough owners have signed the *exact same* proposed transaction (same `to`, `value`, `data`, and the Safe's own internal nonce at proposal time) — partial signatures do nothing on their own.

### 6.2 The batch files this plan produces

Each script above (`upgrade_softstack_core_contracts.ts`, `upgrade_softstack_guards.ts`), run without `SEND=1`, writes one or more files shaped like:

```json
{
  "version": "1.0",
  "chainId": "8453",
  "createdAt": 1234567890,
  "meta": {
    "name": "...",
    "description": "...",
    "txBuilderVersion": "1.16.5"
  },
  "transactions": [
    { "to": "0x...", "value": "0", "data": "0x..." }
  ]
}
```

This is the exact format Safe's own "Transaction Builder" app consumes — not a bespoke format invented for this plan.

### 6.3 Step by step

1. **Run the script as a dry run** (no `SEND` set) against `--network base`. It reads live state, performs its preflight checks, and either refuses (if something unexpected has already changed on-chain — see each script's idempotency check) or writes its batch file(s) under `deployments/`. Nothing is sent to mainnet by this step.
2. **Read the batch file before doing anything else.** Each `transactions[].data` is ABI-encoded calldata — decode it (Etherscan's "Input Data" decoder works for this if the target contract is verified, or `cast calldata-decode`/`cast 4byte-decode` locally) and confirm it matches what this report describes for that step. Never import and sign a batch you haven't independently read.
3. **Go to [app.safe.global](https://app.safe.global)**, connect a wallet that is one of the Safe's owners, and open the correct Safe — the DAO Safe (`0x74aF72D91D5FB263fBa09Ed43aD1C1ea079058B3`) or the Pool Manager Safe (`0x18f84Ea9D3351081780d817e5edd554112CF81Ab`), matching whichever batch file you're importing. Getting this wrong fails loudly (the UI won't let you propose against a Safe your connected wallet doesn't own), not silently.
4. **Open the "Transaction Builder" app** from that Safe's Apps tab, and use its "Import batch" option to load the JSON file. The app re-displays every call in human-readable form (target address, function selector, decoded arguments where the target's ABI is known/verified) — review this against the batch's own `meta.description` and against this report before continuing.
5. **Create the batch as a single Safe transaction** (the Transaction Builder bundles all the imported calls into one `multiSend` call under the hood) and submit it for signing. This creates a pending transaction at the Safe's current nonce.
6. **Collect signatures.** Each remaining owner connects their own wallet to the same Safe UI, opens the pending transaction under the Safe's "Transactions" queue, reviews the same decoded calldata, and signs. The Safe UI shows a running count ("2 of 3 required", etc.). No on-chain action happens until the threshold is met.
7. **Execute.** Once enough signatures are collected, any owner (or any address willing to pay gas, using the already-collected signatures) can click "Execute" — this is the one step that actually broadcasts to mainnet. Before clicking it, re-confirm nothing else has changed the target contracts' state since step 2 (re-run the script's own preflight checks, or the relevant `cast call`s from Section 1, one more time).
8. **Re-verify on-chain**, not just from the Safe UI's "success" indicator — read back the specific values this batch was meant to change (new implementation addresses via `cast implementation`, new guard registrations via `Governance.contractGuards`/`assetGuards`, the new initializer values) directly against mainnet.

### 6.4 Nonce sequencing

Each Safe tracks its own nonce independently (`nonce()` — currently 12 for the DAO Safe, 4 for the Pool Manager Safe) — proposing a batch against one Safe has no effect on the other's nonce or queue. Within a single Safe, a second batch proposed while an earlier one is still pending will queue at the next nonce and simply wait its turn; it does not need to wait for the first to execute before being proposed and signed, only before *it* executes (Safe enforces strict nonce ordering for execution). This is why Section 5's "Pool Manager Safe batch must be proposed after the DAO Safe batch executes" is phrased as a hard dependency on *execution*, not just proposal — the underlying call would revert if sent before the DAO Safe's `NftTrackerStorage` implementation upgrade has actually landed, regardless of nonce.

### 6.5 What does *not* need multisig

Not every privileged action on this system goes through a Safe. `PoolManagerLogic.trader()` is a plain EOA (1.2) — any trader-gated action is a single signature, no Safe involved. None of the upgrade steps in Phases A–C touch a trader-gated function, so this plan's own transactions are entirely Safe-gated; it's included here only so the distinction isn't assumed to apply more broadly than it does.

## 7. Pre-execution and post-upgrade verification checklists

**Immediately before executing Phase A (not just during planning):**

- `PoolLogic.lastRequestId()` on the live proxy is still `0`, or every request up to that id has status `Finalized`/`Claimed`, never `Pending` (Section 1.4). If this has changed since this report was written, stop and drain the queue on the current implementation before proceeding — do not use `ALLOW_PENDING_WITHDRAWALS=1` as a routine bypass.

**Post-upgrade:**

- `cast implementation` on all four core proxies returns the new addresses, not the ones in Section 1.1.
- `PoolLogic.compoundedRewardIndex()`, `TokenLogic.maxDepositFusdSupply()`, `PoolManagerLogic.userActionsRouter()`, `PoolLogic.withdrawalEscrow()` all resolve (no revert) and return the expected initialized values.
- `AssetHandler.sequencerUptimeFeed()` is no longer the zero address; `AssetHandler.eurUsdAggregator()` (or equivalent) reads as cleared.
- `Governance.contractGuards(...)`/`assetGuards(...)` for every slot touched in Phase B resolve to the new addresses, not the old ones listed in `docs/deployments.md`.
- `MorphoBlueManager.getPoolMarkets(POOL_LOGIC_PROXY)` on the **new** manager returns the same 10 market IDs confirmed live in Section 1.3 — i.e., the replay actually took.
- `NftTrackerStorage.poolFactory()` resolves to `PoolManagerLogic`, not `PoolLogic`.
- `NftTrackerStorage.owner()`, `MorphoBlueManager.owner()` on the new instances, `SlippageAccumulator.owner()` on the new instance, `AaveV3LendingPoolAssetGuard.owner()`, `UniswapV3AssetGuard.admin()` on the new instances all resolve to the DAO Safe — none left on the retired EOA.
- `npm run check:contract-size` still passes after any further change — `PoolLogic`'s 813-byte headroom (Section 2) is the tightest margin in the system and should be rechecked before any future fix touches that contract again.

## 8. Risks and limitations

- **Phase B's script does not yet cover every guard that changed** (Section 3.1) — `AaveLendingPoolGuardV3`, `ERC20Guard`, and `MorphoBlueLendingPoolAssetGuard` are all live, registered, and different from what the current branch ships, and none of them is in `upgrade_softstack_guards.ts`'s scope today. This was found by diffing every file under `contracts/contracts/guards/` against `audit`, not by trusting either script's own stated scope — a reminder that "the script doesn't mention it" is not the same as "it doesn't need it." Treat Phase B as a plan, not a ready-to-run batch, until this extension is written and dry-run.
- **A pending withdrawal request at the moment Phase A executes would permanently lock that requester's fUSD** (Section 1.4) — zero today, but this is a live-state fact with a shelf life, not a permanent one. This is the single highest-severity risk in this plan precisely because the failure mode (a specific user's funds stuck, no cancel path) is worse than any other step's failure mode (a reverted, retryable transaction).
- **A real fork rehearsal exists, but it is three to four weeks stale.** `deployments/softstack-upgrade-dao-safe-8453.json` (2026-10-31), `deployments/softstack-guards-dao-safe-8453.json` (2026-10-31), `deployments/softstack-guards-addresses-8453.json` (2026-11-02), and `deployments/migration-test-pre-upgrade.json` (2026-11-01, a reward/NAV continuity check captured before the fork upgrade) are all real outputs from running both scripts against a local Anvil fork of Base — not placeholders. None of the seven guard addresses in that file have any bytecode on real Base mainnet today (checked fresh, all zero codesize), confirming this was fork-only, consistent with the rest of this report. But the fork's captured state (`oldTotalFundValue` ≈ 131,395, `oldFusdTotalSupply` ≈ 129,562) is measurably higher than what Section 1 reads live today (NAV ≈ 121,043, supply ≈ 118,808) — concrete proof the live system has moved since that rehearsal. The scripts are proven to work end-to-end; what isn't proven is that they still work against *today's* exact state. Re-run both as a dry run against real `--network base` (no `SEND`) immediately before proposing, and treat a fresh fork rehearsal of that exact dry-run output as cheap insurance, not a formality.
- **The DAO Safe batch and the Pool Manager Safe batch are not interchangeable and not fungible** — signing the wrong batch with the wrong Safe simply fails; there is no risk of cross-signing causing incorrect execution, but there is a real risk of confusion stalling the rollout if whoever is collecting signatures isn't told which owners belong to which Safe.
- **`FORCE_REDEPLOY=1` exists specifically to bypass the idempotency check** in Phase B's script — treat any need to use it as a signal to stop and manually re-verify current Governance registrations before proceeding, not as a routine flag.
- **Fixing `SlippageAccumulator`'s wiring without also deploying the new `UniswapV3RouterGuard` in the same rollout would reopen the unbacked-fee-minting exploit path** the M-12 fix closes — these two must land together, not as separate, independently-timed changes.
- **This plan does not include Phase C by default.** It is deliberately scoped out of the main rollout as optional, additive infrastructure; deploying it does not require re-touching anything in Phases A or B, but skipping it leaves fUSD without the newer integrations the fEURO deployment already has.

## Appendix — addresses referenced in this plan

### Currently live (Base mainnet)

| Contract | Address |
| --- | --- |
| DAO Safe | `0x74aF72D91D5FB263fBa09Ed43aD1C1ea079058B3` |
| Pool Manager Safe | `0x18f84Ea9D3351081780d817e5edd554112CF81Ab` |
| Trader (EOA) | `0x4D444F4a7e13d0Fd0c06eC301e6047Db62f636a0` |
| Retired deployer EOA (still owns 2 guards) | `0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d` |
| AssetHandler (proxy) | `0x387174F4B3676c7F6e06da9c6c855375B5b10AAB` |
| PoolManagerLogic (proxy) | `0x9530E699E519D7BCF621BA7CA17e119B6865b5C7` |
| PoolLogic / sfUSD (proxy) | `0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E` |
| TokenLogic / fUSD (proxy, UUPS) | `0xeB82611A2B2dC9FBEAF5903d5decDf801765B759` |
| Governance | `0xC393A896D15641cA970F682BE62e89347941985d` |
| NftTrackerStorage (proxy) | `0x84F46CD368f0CB7290c47738B53b7B7FEC5aFF49` |
| SlippageAccumulator (old) | `0xcf8aCb91851D6651649598aaE175b61ab20c70cB` |
| MorphoBlueManager (old) | `0x7C700a84365546675B5699206e449B88756E066E` |
| AaveV3LendingPoolAssetGuard (old) | `0xE5bc2963f3fdE832d798caC2024343C83aDD2A38` |
| UniswapV3AssetGuard (old) | `0xB186BA1634d4F99798ed663319aF6ac328086DF1` |
| UniswapV3RouterGuard (old) | `0xcAE75F063Ef5b432F4ad3140960c888a0795d5DC` |
| UniswapV3NonfungiblePositionGuard (old) | `0xA313f1AADFB45033498a20e2e2cfefD31D10c973` |
| MorphoBlueContractGuard (old) | `0x7A4701fAB443687F9EADCa68Ef0B207729a5acEa` |

### Not yet known

Every "new" implementation and guard address referenced in Phases A–C does not exist yet — these are produced only when each script's permissionless deploy step is actually run, and will be written to `deployments/*.json` at that time. This report deliberately does not invent placeholder addresses for them.
