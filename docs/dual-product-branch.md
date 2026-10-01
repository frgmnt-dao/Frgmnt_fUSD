# This Branch Covers Both the USD and the EUR Product

**Status: verified.** `feature/07-attested-selective-withdrawal` is now the single branch used for both the USD-pegged product (`fUSD`/`sfUSD`, live on Base) and the EUR-pegged product (`fEURO`/`sfEURO`, not yet deployed anywhere). This page is the record of what that claim rests on: what was already true by construction, what was checked, and three real defects found and fixed while checking it.

## 1. Why this was a small step, not a rewrite

`feature/06-aave-v4` (the USD product's branch, CertiK-validated at commit `4922f72`) and `feature/03-euro-pegged-stablecoin` (the EUR product's branch) have kept `contracts/contracts/` byte-identical since 2026-08-06, enforced by `scripts/check-branch-parity.sh` in CI on both branches. Every product difference already lived in deploy-time configuration (`scripts/deploy_core_contracts.ts`'s `PRODUCT` switch: token branding, and whether the `AssetHandler` EUR/USD conversion feed is wired), never in contract source. `feature/07` was cut from `feature/06`'s tip, so this held for it too, up to one gap: the attested-withdrawal feature built on this branch had not been checked for a hidden USD assumption, and `deploy_core_contracts.ts`'s `PRODUCT=EUR` path had never actually been run against this version of the contracts.

## 2. What was checked, and the one thing fixed in the contracts

The new code (`WithdrawalPlanLib.sol`, the four selective guards, the additions to `PoolLogic.sol` and `IPoolLogic.sol`) was read specifically for USD-only assumptions: hardcoded branding, a hardcoded reference to `fUSD`, anything that would be wrong once `AssetHandler`'s EUR/USD conversion feed is configured and the pool's accounting unit becomes EUR. None were found — the handful of `fUSD`/`USD` occurrences are variable names (`fusd`, `netFusd`, `fairFusd`) already used identically on the EUR branch, and the EIP-712 domain name (`"Frgmnt PoolLogic"`) is not product-specific.

Two NatSpec comments in the feature's own new code (not CertiK-validated baseline) called a value "USD-denominated" when it means "in the pool's accounting unit," which is EUR once the conversion feed is set. Both were new comments added by this feature, not pre-existing validated text, so they were corrected directly (`PoolLogic.sol`'s `AttestedWithdrawPlanExecuted` NatSpec, `IPoolLogic.sol`'s `AssetAllocation.fixedAmount` comment). Comment-only; no bytecode change, confirmed via `npm run check:contract-size` (`PoolLogic` unchanged at 24,426 bytes, 150 bytes of headroom).

A handful of **pre-existing** comments in CertiK-validated code (`PoolLogic.sol:125`, and one `@notice` each in `AaveV4SpokeAssetGuard.sol`, `AaveV4TokenizationAssetGuard.sol`, `MorphoVaultV2AssetGuard.sol`) have the same imprecision and predate this feature entirely — present, identically, on `feature/06-aave-v4` already. They were left untouched: editing CertiK-validated contract or guard source for a comment-only reason is out of scope here, and `contracts/contracts/priceAggregators/AssetHandler.sol:85`, the one place the comment actually matters for correctness, already documents the EUR conversion accurately.

## 3. What was found by actually rehearsing a fresh deployment

Nothing had ever run `deploy_core_contracts.ts` to completion against this version of the contracts: the live USD deployment only ever went through `upgrade_core_contracts.ts` (which deliberately bypasses the OpenZeppelin upgrades plugin for `PoolLogic` over a linked-library limitation, documented in that script), and the EUR product has never been deployed at all. So this was genuinely new ground, not a repeat of existing coverage.

A local rehearsal (Hardhat's own network, `--network localhost`, no testnet or mainnet involved, no real transaction, no key used) ran `deploy_core_contracts.ts` to completion for both `PRODUCT=USD` and `PRODUCT=EUR`, using a throwaway Chainlink-shaped mock for the EUR/USD feed (never part of the product build). It found two defects that would have blocked **any** fresh deployment of this `PoolLogic` version, for either product — neither is specific to EUR, and neither had been possible to hit before, for the reason above.

### 3.1 OpenZeppelin's upgrade-safety validator rejected `PoolLogic`

`upgrades.deployProxy(PoolLogic, ...)` failed outright: `initializeAutoCompounding()` and `initializeAttestedWithdrawal()` are both annotated `@custom:oz-upgrades-validate-as-initializer` (correctly — they are real, narrow migration functions), which makes the validator check them for calls to every parent initializer (`__ERC20_init`, `__Ownable_init`, `__ReentrancyGuard_init`). Neither calls those, correctly — `initialize()` already ran them, and calling them again would revert under `Initializable`'s own guard. This is the documented false-positive case `unsafeAllow: ['missing-initializer-call']` exists for. Fixed in `deploy_core_contracts.ts`'s `PoolLogic` `deployProxy` call, with the rationale recorded in a comment at the call site.

### 3.2 `PoolManagerLogic` and `TokenLogic` could never complete their own wiring

`PoolManagerLogic.initialize(...)` and `TokenLogic.initialize(...)` were both called with `GOVERNANCE_SAFE` as `factoryOwner`/`DEFAULT_ADMIN_ROLE` directly — no transitional window at all, unlike `AssetHandler`, which already uses the correct pattern (`__Ownable_init(msg.sender)`, do the deployer-only setup, then `transferOwnership(GOVERNANCE_SAFE)`). But the script still needs to call `PoolManagerLogic.setPoolLogic()` (`onlyFactoryOwner`) and `TokenLogic.setPoolLogic()` (`onlyRole(DEFAULT_ADMIN_ROLE)`) afterward, to complete the circular `PoolManagerLogic` ↔ `PoolLogic` ↔ `TokenLogic` wiring that `PoolLogic`'s own constructor-style parameters make necessary (`PoolLogic.initialize` needs `PoolManagerLogic`'s and `TokenLogic`'s addresses, so they must deploy first, with `poolLogic` unset, and be linked afterward). The deployer was never, even transiently, `factoryOwner` or role holder on either contract, so that linking call could never succeed — this script could never have completed a fresh deployment, on any network, for either product, since this exact wiring order existed.

Fixed by applying the same transitional-ownership shape `AssetHandler` already uses: both contracts now initialize with the deployer as the temporary authority, the script performs the linking calls, then hands off — `PoolManagerLogic.setFactoryOwner(GOVERNANCE_SAFE)`, and for `TokenLogic`'s `AccessControl` role (which has no single-call transfer the way `Ownable` does) `grantRole(DEFAULT_ADMIN_ROLE, GOVERNANCE_SAFE)` followed by the deployer's own `renounceRole`. This is not a new pattern: it is the exact shape `scripts/transferRoles_Governance.ts` already uses for the later Timelock handoff (see `docs/security.md`'s Centralization Risks section, FNA-01), applied one step earlier, to the two contracts that had been missed.

### 3.3 A real, separate gap: no prompt to initialize the new feature on a fresh deploy

Unrelated to the two defects above: `deploy_core_contracts.ts` already prints a `REQUIRED FOLLOW-UP` console line telling the owner to call `initializeWithdrawalEscrow()`, since that call is `onlyOwner` and the deployer never holds that role on `PoolLogic` either (by design, mirroring `PoolLogic.initialize`'s own `_owner = GOVERNANCE_SAFE` parameter). It said nothing about `initializeAttestedWithdrawal()`, which is exactly as owner-gated. An operator following the script's own console output would wire the escrow and have no indication the attested-withdrawal feature exists or needs a separate call to become reachable. Fixed by adding the equivalent `REQUIRED FOLLOW-UP` line, naming the function, its parameters, and the two enforced floors (`attesterRotationDelay >= 24h`, `attestedWithdrawDecayWindow >= 1h`).

## 4. Rehearsal evidence

Both calls above were then actually run, impersonating `GOVERNANCE_SAFE` locally (`hardhat_impersonateAccount`, local network only) against the freshly deployed USD proxy, to confirm the printed instructions are correct, not just well-formatted:

```
initializeWithdrawalEscrow OK, withdrawalEscrow() now: 0x4ed7...
initializeAttestedWithdrawal OK
withdrawalAttester() now: 0x9965...
isAttestedWithdrawEnabled() now: false
attesterRotationDelay() now: 86400
attestedWithdrawDecayWindow() now: 3600
second call correctly reverted: ... 0xf92ee8a9 (InvalidInitialization)
```

The feature starts disabled, as designed; the floors are enforced; the `reinitializer(3)` guard correctly refuses a second call. This matches the design doc's description exactly.

**To reproduce:** start `npx hardhat node` in one terminal; in another, deploy any contract exposing `description()`/`decimals()`/`latestRoundData()` returning an "EUR / USD"-described, 8-decimal, in-range answer (or point `EUR_USD_FEED` at a real Chainlink EUR/USD feed if rehearsing against a fork instead of a bare local node), then run `PRODUCT=EUR EUR_USD_FEED=<address> npx hardhat run scripts/deploy_core_contracts.ts --network localhost`. Repeat with `PRODUCT=USD` (no feed needed). Never point this at a testnet or mainnet RPC without the team's explicit go-ahead.

## 5. What this does and does not prove

**Proven:** both products compile to the identical `PoolLogic` bytecode; a fresh deployment of either one, including the new attested-withdrawal feature, completes end to end on a local network; the feature's own initializer and governance functions behave as documented once wired up. The full test suite (1,293 tests) and `npm run coverage` are unaffected by any of the above (none of it touches `contracts/contracts/` except the two comment corrections in §2).

**Not proven, and out of scope here:** nothing above touched a testnet or mainnet, used a real key, or sent a real transaction. `deploy_core_contracts.ts` still has no automated test — this rehearsal was manual, and the two defects in §3 had sat, unexercised, since before this feature existed. Reasonable follow-up, not done here: either an automated CI job that runs this script against a local node for both `PRODUCT` values on every change to it, or refactoring it into smaller, independently testable functions (the script is presently one large, side-effecting, module-scope-mutating `main()`, which is why a quick unit test wasn't attempted as part of this pass — doing that refactor carelessly would risk introducing exactly the kind of defect this rehearsal just found two of).

## 6. What stays asymmetric between the products, on purpose

- **USD is live; EUR is not.** `upgrade_core_contracts.ts`, `upgrade_attested_withdrawal.ts`, and the `remediate_*`/`transferRoles_*` scripts apply only to the already-deployed USD proxies. A fresh EUR deployment has no storage-layout or upgrade-ordering constraint at all — `deploy_core_contracts.ts` alone is its whole deployment story.
- **The old branches are kept, not deleted.** `feature/06-aave-v4` (USD, CertiK's validated baseline at `4922f72`) and `feature/03-euro-pegged-stablecoin` stay as read-only history — no new commits land there going forward. `feature/07-attested-selective-withdrawal` is the one actively developed branch for both products; `scripts/check-branch-parity.sh` already no-ops on it (it only activates on the two named branches) and needs no further change.
- **See also:** `docs/certik-change-summary.md` for the change list against the CertiK-validated baseline, and `docs/attested-selective-withdrawal-design.md` for the feature itself.
