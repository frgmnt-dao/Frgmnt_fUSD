# Protocol Overview

## Introduction

Frgmnt fUSD is a collateral-backed stablecoin protocol deployed on Base. Users deposit whitelisted assets and receive **fUSD** — a USD-pegged ERC20 token backed 1:1 by the deposited collateral value, as priced through Chainlink oracles. The deposited collateral is pooled into a managed yield vault and deployed across integrated DeFi protocols (Aave V3, Aave V4, Morpho Blue, Morpho Vault V2, Uniswap V3). Net yield flows back to fUSD stakers in the form of **sfUSD** — a non-transferable staking receipt token.

---

## Design Goals

| Goal | Approach |
|------|----------|
| **Full backing** | Every fUSD is minted against USD-equivalent collateral verified by Chainlink price feeds |
| **Yield generation** | Pooled collateral is actively managed across lending and liquidity protocols |
| **Access control** | Guard-gated execution prevents unauthorized transactions within the vault |
| **Composability** | Modular guard system supports new DeFi protocol integrations without core contract changes |
| **Governance safety** | DAO-controlled Timelock with 48-hour delay on all privileged operations |
| **Capital protection** | Cooldown periods and slippage checks defend against MEV and flash-loan attacks |

---

## The Two-Token System

### fUSD — Frgmnt USD

fUSD is the protocol's primary stablecoin. It is minted when users deposit supported collateral assets and burned when users withdraw through the vault's cash-out mechanisms.

- ERC20, 18 decimals
- 1:1 collateral backing (USD-denominated via Chainlink)
- Cooldown period enforced on cash withdrawals
- Transferable (subject to cooldown constraints)

### sfUSD — Staked fUSD

sfUSD is the yield-bearing staking receipt issued by the vault when users stake fUSD into PoolLogic.

- ERC20, 18 decimals — **non-transferable**
- Value accrues as the vault generates yield
- Redeemable for fUSD via unstaking
- Claimable rewards separately via `harvest()`

---

## Protocol Roles

| Role | Responsibilities |
|------|-----------------|
| **User** | Deposit collateral to mint fUSD; stake fUSD for yield |
| **Manager** | Configure vault assets, fees, withdrawal modes |
| **Trader** | Execute guarded DeFi transactions on behalf of the vault |
| **Factory Owner** | Set fee caps, register pools, update core contracts |
| **DAO / Timelock** | Admin of TokenLogic and PoolManagerLogic upgrades |
| **Emergency** | Pause and unpause the fUSD contract |

---

## Supported Integrations

The protocol ships with guards for the following protocols:

| Protocol | Integration Type |
|----------|----------------|
| **Aave V3** | Lending, borrowing, flash loans |
| **Aave V4 Spoke** | Supply-only (no borrowing), Giver/Taker position managers |
| **Aave V4 Tokenization** | ERC-4626 vault deposit/withdraw against Aave's Liquidity Hub, no debt |
| **Morpho Blue** | Lending, borrowing, flash loans |
| **Morpho Vault V2** | ERC-4626 vault deposit/withdraw across curator-selected adapters, no debt |
| **Uniswap V3** | Swaps, LP positions |
| **Merkl** | Reward claims for any Merkl-integrated protocol above |

All interactions with these protocols are validated by purpose-built guard contracts before execution — see [docs/contracts/](contracts/) for the per-contract reference.

---

## Yield Model

1. Vault collateral is deployed into lending and liquidity protocols
2. Earned interest and fees accrue as vault assets increase in USD value
3. At fee accrual events, the vault separates performance fees (to manager) and management fees (minted as shares)
4. Remaining yield is distributed to sfUSD stakers via a `rewardPerShare` accumulator
5. Stakers claim rewards any time via `harvest()`

---

## Further Reading

- [Architecture](architecture.md) — System design and interaction diagrams
- [Mechanics](mechanics.md) — Step-by-step flow documentation
- [Security](security.md) — Trust model and risk analysis
- [Developer Guide](developer-guide.md) — Contract layout, guard patterns, local setup
- [docs/contracts/](contracts/) — Per-contract reference documentation
