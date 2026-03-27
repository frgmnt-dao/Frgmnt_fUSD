# Guards

Guards in the **Frgmnt Protocol** provide a safe and unified way for pools to interact with external assets and protocols.  
They act as adapters that expose a standard interface used by `PoolLogic`, `PoolManagerLogic`, and other core contracts.

Frgmnt uses two types of guards:

1. **Contract Guards**
2. **Asset Guards**

---

## Contract Guards

A contract guard defines **which external contract functions a pool manager is allowed to call**.

This prevents misuse of external protocols.  
For example, if a pool interacts with a lending protocol, the guard may allow only:

- `deposit`
- `borrow`
- `repay`
- `withdraw`

This ensures the manager cannot call arbitrary functions that could redirect funds or compromise the pool.

Some contract guards also allow **public functions** (callable by anyone), e.g. reward claiming:

- Useful when a protocol requires periodic `claim()` calls.

---

## Asset Guards

Asset guards define **how a pool should handle a specific asset or group of assets**.  
An "asset" in Frgmnt can be:

- A simple ERC20 token
- A liquidity position (ERC20 or ERC721)
- A group of lending/borrowing positions managed by an external protocol

Examples:

- Plain ERC20 tokens: `WETH`, `USDC`, `WBTC`
- Uniswap V2 LP tokens
- Balancer LP tokens
- Uniswap V3 NFT positions
- Aave-style lending/borrowing positions

### What an asset guard provides

Asset guards expose:

- **Balance** — or aggregated balances for grouped positions
- **Removal rules** — whether an asset can be removed from supported assets (e.g., must have zero balance and no debt)
- **Withdrawal processing** — how an investor’s share should be redeemed
    - LP tokens may need to be unwrapped
    - Lending positions may require repaying debt
    - NFT positions may require burning/unrolling

### Important note

A single Frgmnt “asset” may represent multiple underlying positions.  
Example:

- An **AaveLendingPool asset** may internally manage:
    - aTokens (collateral)
    - debtTokens (borrows)

Yet they are exposed to the pool as **one unified asset** via its guard.

---

## Examples

### Simple ERC20

- SUSHI token
- Uses `ERC20Guard`
- Balance = token amount
- Price = Chainlink feed

### LP Tokens (Balancer / Uniswap V2)

- Pool holds ERC20 LP tokens
- Guard = `ERC20Guard`
- Balance = LP token amount
- Value = LP aggregator (reads underlying token values)

### Complex Lending Position (Aave-style)

- Pool may supply WBTC & DAI, and borrow WETH
- Asset = “Aave Lending Pool”
- Guard aggregates:
    - total collateral value minus total debt value
- Balance returned in USD terms
- Price aggregator = pass-through (1:1 with returned value)

---

Guards ensure that **Frgmnt Protocol pools can safely interact with both simple and complex assets**, while maintaining strict control, predictable valuation, and secure manager operations.
