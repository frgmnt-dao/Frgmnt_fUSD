# SFUSD — Frgmnt Staked FUSD Pool Token (Upgradeable)

**SFUSD** is the staked share token for the **Frgmnt** protocol’s pooled FUSD strategy.
Holders deposit **FUSD** and receive **SFUSD** shares whose value appreciates as the pool collects fees/yield. The contract keeps most semantics of the classic “PoolLogic” design (entry/exit fees in shares, fee minting, guarded transactions) while adding a **harvestable yield** mechanic and an optional **withdrawal queue**.

> Solidity: `^0.8.24`
> Dependencies: OpenZeppelin v5 (upgradeable ERC20, ReentrancyGuard), Frgmnt interfaces

---

## High-Level Design

* **Share token**: `SFUSD` (ERC20Upgradeable) represents proportional claim on the pool’s FUSD and other supported assets.
* **Stake / Unstake**:

  * `stake(FUSD)` mints SFUSD; entry fee is minted to manager in **shares** (no principal haircut).
  * `unstake()` burns SFUSD; exit fee is taken in **shares**.
* **Yield accrual**:

  * The pool’s **token price** grows (from fees/strategy PnL). That growth is tracked with a global accumulator `yieldPerShare`, letting users `harvest()` claimable FUSD.
* **Fees**:

  * **Performance** and **management (streaming)** fees are minted in **shares** to manager/DAO via `_mintManagerFee()`.
* **Withdraw modes**:

  * `Immediate`: classic burn-for-assets flow.
  * `Queued`: user locks shares, manager finalizes later with a fixed FUSD amount, user claims when ready.
* **Guards**:

  * Every external transaction is validated through **contract/asset guards** (allowlists and post-hooks).
* **Access**:

  * A linked `PoolManagerLogic` provides manager/trader roles, supported assets and pricing.

---

## Storage (Order Preserved)

* Pool config: `factory`, `poolManagerLogic`, `privatePool`, `creationTime`, `creator`
* Fee tracking: `tokenPriceAtLastFeeMint`, `lastFeeMintTime`
* Deposit/transfer controls: `lastDeposit`, `lastWhitelistTransfer`, `lastExitCooldown`
* **Staking**: `fusd` (staking asset), `yieldPerShare`, `lastTokenPriceForYield`, `userYields[address]`
* **Withdraw queue**: `withdrawMode`, `lastRequestId`, `withdrawalRequests`, `requestsByUser`
* Upgradeable gap: `__gap`

> **Important:** Preserve order on upgrades. Never remove/rename existing variables; append new ones above `__gap`.

---

## Roles

* **Manager** (from `PoolManagerLogic`): Can toggle privacy, set withdraw mode, finalize queued withdrawals, manage guarded transactions.
* **Trader** (from `PoolManagerLogic`): May execute allowed guarded transactions (if marked public or trader-allowed).
* **DAO / Factory Owner**: Protocol-level control, fee settings, pausing.

---

## Core Functions

### Staking & Harvest

* `stake(uint256 amountFusd)` — Deposit FUSD, mint SFUSD shares. Entry fee **in shares**.
* `unstake(uint256 fundTokenAmount)` — Burn SFUSD and withdraw assets (Immediate mode).
* `harvest()` — Claim FUSD yield from token price appreciation.

### Withdraw Queue (Optional)

* `setWithdrawMode(WithdrawMode mode)` — Manager toggles between Immediate/Queued.
* `requestWithdraw(uint256 shares)` — Lock shares, create withdrawal request.
* `finalizeWithdraw(uint256 requestId)` — Manager burns shares, fixes FUSD amount.
* `claimWithdraw(uint256 requestId)` — User claims finalized FUSD.

### Fees & Price

* `mintManagerFee()` — Trigger mint of accrued management/performance fees.
* `tokenPrice()` / `tokenPriceWithoutManagerFee()` — View share price.

### Guarded Transactions

* `execTransaction(address to, bytes calldata data)` — Execute a validated protocol tx.
* `execTransactions(TxToExecute[] calldata txs)` — Batch version.

### Admin / Linking

* `setPoolManagerLogic(address _poolManagerLogic)` — Link or update associated manager logic.

---

## Events

* `Stake(user, fusdAmount, mintedShares, entryFeeShares)`
* `Harvest(user, fusdAmount)`
* `WithdrawRequested(id, user, sharesLocked, exitFeeShares)`
* `WithdrawFinalized(id, fusdAmount)`
* `WithdrawClaimed(id, user, fusdAmount)`
* `ManagerFeeMinted(pool, manager, available, daoFee, managerFee, tokenPriceAtLastFeeMint)`
* `TransactionExecuted(pool, manager, txType, time)`

---

## Security & Behavior

* Reentrancy guarded across user-facing functions.
* All protocol interactions validated through guards.
* Entry/Exit fees applied via share dilution (no user balance cut).
* Upgrade-safe with `__gap`.
* Cooldown prevents immediate exit exploits.

---

## Initialization

```solidity
function initialize(
  address _factory,
  bool _privatePool,
  string memory _name,
  string memory _symbol,
  address _fusd
) external initializer
```

Sets core parameters and enables immediate withdrawal mode.

---

## Deployment & Testing (Hardhat Example)

### Deploy (Upgradeable)

```bash
npx hardhat run scripts/deploySfusd.ts --network base
```

**Example script:**

```typescript
const { ethers, upgrades } = require("hardhat");

async function main() {
  const SFUSD = await ethers.getContractFactory("SFUSD");
  const sfusd = await upgrades.deployProxy(SFUSD, [factory, false, "Staked FUSD", "SFUSD", fusd], {
    initializer: "initialize",
  });
  console.log("SFUSD deployed to:", sfusd.target);
}
main();
```

### Upgrade

```bash
npx hardhat run scripts/upgradeSfusd.ts --network arbitrum
```

```typescript
const { ethers, upgrades } = require("hardhat");

async function main() {
  const SFUSDV2 = await ethers.getContractFactory("SFUSDV2");
  await upgrades.upgradeProxy(existingProxyAddress, SFUSDV2);
  console.log("SFUSD upgraded successfully.");
}
main();
```

### Run Tests

```bash
npx hardhat test test/SFUSD.test.ts
```

---


