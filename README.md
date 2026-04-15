# Frgmnt fUSD Protocol

![Frgmnt Finance](https://raw.githubusercontent.com/frgmnt-dao/Frgmnt_fUSD/audit/header.png)

> A collateral-backed, yield-bearing stablecoin protocol built on Base.

---

## Overview

Frgmnt fUSD is a DeFi protocol that allows users to deposit whitelisted collateral assets and receive **fUSD** — a fully-backed, USD-pegged stablecoin. Deposited collateral is deployed into a managed vault that generates yield through integrated lending protocols (Aave V3, Morpho Blue) and liquidity provision (Uniswap V3). Protocol yield is distributed to **sfUSD** stakers as rewards, while all external interactions are protected by a modular guard system.

The protocol is deployed on the **Base** network and is governed by a DAO-controlled Timelock with a 48-hour delay.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Collateral-backed fUSD** | fUSD is minted 1:1 against USD-valued collateral, priced via Chainlink oracles |
| **Yield-bearing staking** | Stake fUSD to receive sfUSD and earn protocol yield automatically |
| **Guard-gated execution** | All vault transactions are validated through an allowlist of contract and asset guards |
| **Dual withdrawal modes** | Immediate pro-rata or manager-queued withdrawals from the vault |
| **Cooldown protection** | Time-weighted cooldown prevents flash-deposit/immediate-withdrawal attacks |
| **Multi-protocol yield** | Yield sourced from Aave V3, Morpho Blue, and Uniswap V3 LP positions |
| **Upgradeable contracts** | UUPS proxy pattern with Timelock-gated admin |
| **EIP-712 deposits** | Third-party deposits supported via signed authorization |

---

## Architecture Summary

```
  User
   │
   ├──[deposit collateral]──► TokenLogic (fUSD)
   │                               │ mint fUSD
   │                               │ forward collateral
   │                               ▼
   │                         PoolLogic (sfUSD vault)
   │                               │
   ├──[stake fUSD]──────────────►  │  mint sfUSD
   │                               │
   │                         PoolManagerLogic
   │                          │    │    │
   │                        Aave  Morpho  Uniswap V3
   │                        Guard  Guard   Guard
   │
   └──[unstake / harvest]──► Rewards & yield
```

Full architecture documentation: [docs/architecture.md](docs/architecture.md)

---

## Smart Contracts

| Contract | Description |
|----------|-------------|
| [TokenLogic](docs/contracts/TokenLogic.md) | fUSD ERC20 stablecoin — mints fUSD against collateral, enforces cooldowns |
| [PoolLogic](docs/contracts/PoolLogic.md) | sfUSD vault — manages staking, yield accrual, and withdrawals |
| [PoolManagerLogic](docs/contracts/PoolManagerLogic.md) | Pool configuration, asset registry, fee management |
| [Governance](docs/contracts/Governance.md) | Guard registry mapping contracts/assets to their guard implementations |
| [Managed](docs/contracts/Managed.md) | Role management (manager, trader, members) |
| [Timelock](docs/contracts/Timelock.md) | DAO governance timelock (48-hour delay) |
| [AssetHandler](docs/contracts/AssetHandler.md) | Chainlink USD price feed registry with L2 sequencer safety |
| [ERC20Guard](docs/contracts/ERC20Guard.md) | Guards ERC20 approvals and proportional withdrawals |
| [AaveLendingPoolGuardV3](docs/contracts/AaveLendingPoolGuardV3.md) | Validates Aave V3 supply/borrow/repay transactions |
| [AaveLendingPoolAssetGuard](docs/contracts/AaveLendingPoolAssetGuard.md) | Manages flashloan-based Aave V3 position unwinding |
| [MorphoBlueContractGuard](docs/contracts/MorphoBlueContractGuard.md) | Validates Morpho Blue lending transactions |
| [MorphoBlueLendingPoolAssetGuard](docs/contracts/MorphoBlueLendingPoolAssetGuard.md) | Manages Morpho Blue position valuation and withdrawal |
| [UniswapV3RouterGuard](docs/contracts/UniswapV3RouterGuard.md) | Validates Uniswap V3 swap transactions |
| [UniswapV3AssetGuard](docs/contracts/UniswapV3AssetGuard.md) | Values and unwinds Uniswap V3 LP NFT positions |

---

## Deployment Addresses (Base — Beta Release)

**Chain ID:** 8453 &nbsp;|&nbsp; **Deployer:** `0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d`

| Contract | Address | Explorer |
|----------|---------|---------|
| TokenLogic (fUSD) | `0xeB82611A2B2dC9FBEAF5903d5decDf801765B759` | [Basescan](https://basescan.org/address/0xeB82611A2B2dC9FBEAF5903d5decDf801765B759) |
| PoolLogic (sfUSD) | `0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E` | [Basescan](https://basescan.org/address/0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E) |
| PoolManagerLogic | `0x9530E699E519D7BCF621BA7CA17e119B6865b5C7` | [Basescan](https://basescan.org/address/0x9530E699E519D7BCF621BA7CA17e119B6865b5C7) |
| Governance | `0xC393A896D15641cA970F682BE62e89347941985d` | [Basescan](https://basescan.org/address/0xC393A896D15641cA970F682BE62e89347941985d) |
| Timelock | `0xD3e2691b0c765EAD8A0041e76b5e51E28967Ea3e` | [Basescan](https://basescan.org/address/0xD3e2691b0c765EAD8A0041e76b5e51E28967Ea3e) |
| AssetHandler | `0x387174F4B3676c7F6e06da9c6c855375B5b10AAB` | [Basescan](https://basescan.org/address/0x387174F4B3676c7F6e06da9c6c855375B5b10AAB) |
| ERC20Guard | `0x26E11DC5C05ee07Cb14A2Fd475C71aAEd2F0A98C` | [Basescan](https://basescan.org/address/0x26E11DC5C05ee07Cb14A2Fd475C71aAEd2F0A98C) |
| AaveV3LendingPoolAssetGuard | `0xE5bc2963f3fdE832d798caC2024343C83aDD2A38` | [Basescan](https://basescan.org/address/0xE5bc2963f3fdE832d798caC2024343C83aDD2A38) |
| MorphoBlueAssetGuard | `0x27BeceFb6CF59b26CD73dac227Ae3597065E2850` | [Basescan](https://basescan.org/address/0x27BeceFb6CF59b26CD73dac227Ae3597065E2850) |
| UniswapV3AssetGuard | `0xB186BA1634d4F99798ed663319aF6ac328086DF1` | [Basescan](https://basescan.org/address/0xB186BA1634d4F99798ed663319aF6ac328086DF1) |
| AaveLendingPoolGuardV3 | `0x7Ef5442f796bF1Ae3e00E91a5527cAa5F7aba5A4` | [Basescan](https://basescan.org/address/0x7Ef5442f796bF1Ae3e00E91a5527cAa5F7aba5A4) |
| MorphoBlueContractGuard | `0x7A4701fAB443687F9EADCa68Ef0B207729a5acEa` | [Basescan](https://basescan.org/address/0x7A4701fAB443687F9EADCa68Ef0B207729a5acEa) |
| UniswapV3RouterGuard | `0xcAE75F063Ef5b432F4ad3140960c888a0795d5DC` | [Basescan](https://basescan.org/address/0xcAE75F063Ef5b432F4ad3140960c888a0795d5DC) |
| UniswapV3NonfungiblePositionGuard | `0xA313f1AADFB45033498a20e2e2cfefD31D10c973` | [Basescan](https://basescan.org/address/0xA313f1AADFB45033498a20e2e2cfefD31D10c973) |

See [docs/deployments.md](docs/deployments.md) for the full deployments reference including implementation addresses, proxy admins, and infrastructure contracts.

---

## Getting Started

### Prerequisites

- Node.js >= 18
- npm or pnpm

### Install

```bash
git clone https://github.com/frgmnt-dao/Frgmnt_fUSD.git
cd Frgmnt_fUSD
npm install
```

### Compile

```bash
npm run compile
# or using hardhat shorthand (npm i -g hardhat-shorthand)
hh compile
```

### Test

```bash
npm run test
# with coverage
npm run coverage
```

### Deploy

```bash
cp .env.example .env
# Fill in PRIVATE_KEY and RPC endpoints
hh ignition deploy ignition/modules/BasicERC20Module.ts --network base
```

### Lint & Format

```bash
npm run lint:check
npm run format:check
npm run solhint
```

---

## Documentation

Full protocol documentation is available in the [/docs](docs/) directory:

| Document | Description |
|----------|-------------|
| [Overview](docs/overview.md) | Protocol goals and design philosophy |
| [Architecture](docs/architecture.md) | System design and contract interaction map |
| [Mechanics](docs/mechanics.md) | Deposit, staking, yield, withdrawal flows |
| [Security](docs/security.md) | Roles, trust model, attack surface analysis |
| [Developer Guide](docs/developer-guide.md) | Deployment, integration, and example usage |
| [Deployments](docs/deployments.md) | Live contract addresses on Base |

---

## Security

The protocol uses a defense-in-depth approach:

- All external vault transactions are gated through a guard system
- Roles are separated: manager, trader, factory owner, DAO multisig
- Privileged operations require a 48-hour Timelock delay
- Chainlink oracles include staleness checks and L2 sequencer uptime validation
- Cooldown windows protect against same-block deposit/withdrawal attacks

For a detailed analysis, see [docs/security.md](docs/security.md).

---

## License

[MIT](LICENSE)
