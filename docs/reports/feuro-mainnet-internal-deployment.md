# fEURO — Real Base Mainnet Deployment (Internal Testing)

Deployed and tested live on Base mainnet (chain 8453), for internal testing only — not a public launch. A single deployer wallet holds every privileged role (manager, emergency address, every proxy/contract owner). Nothing in this deployment was broadcast to a fork or testnet — every address and transaction below is real and live on Base mainnet today.

**Deployer / sole role-holder:** `0x5edc24182f5e8723Bd73FaE8472EA184124a92F7`

## 1. Product configuration

| Setting            | Value                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deposit asset      | **EURC only** (`0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42`, Circle's native EUR-pegged stablecoin on Base)                                                                                                |
| EUR/USD price feed | `0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F` — real Chainlink EUR/USD feed, confirmed live on-chain (genuine FX pair, not EURC/USD); passes the deployment's own feed validator unmodified, no bypass used |
| EUR/USD timeout    | 86,400 seconds (24h) — **permanent once set**, cannot be changed post-deployment                                                                                                                           |
| Exit cooldown      | 120 seconds (2 minutes) — adjustable anytime via `TokenLogic.setCooldown()`                                                                                                                                |
| Deposit cap        | 10,000 fEURO                                                                                                                                                                                               |
| Performance fee    | 20% (2000 bps)                                                                                                                                                                                             |
| Management fee     | 0%                                                                                                                                                                                                         |
| Investment policy  | **Guards may only ever invest the pool's EURC holdings** — no USDC is held or invested through any integration in this deployment                                                                          |

USDC was deliberately disabled as a deposit asset after an initial (unused) setup step; EURC is the only asset users can deposit.

## 2. Contract addresses

All confirmed live on-chain (real deployed bytecode verified directly against Base mainnet) immediately before this report was written.

### Core contracts

| Contract                   | Address                                      |
| -------------------------- | -------------------------------------------- |
| Governance                 | `0xd5F55d4DBC749fBfFA3E7bC286eF85A92f7E0D03` |
| Timelock                   | `0xa6A07271Aa93650944ed584300e7f1bf07b8e86D` |
| AssetHandler (proxy)       | `0xb154257dEba571b9F8613e735E6D565A3bc47453` |
| PoolManagerLogic (proxy)   | `0x48CB22BFc984947550302aAbE819cF294253C91b` |
| TokenLogic / fEURO (proxy) | `0xF1fa25bA052060bBA079870f37b98e0fa00cc40E` |
| PoolLogic / sfEURO (proxy) | `0xB6518A135c675Bef8Cd3A77dd469996DE0dBdfF2` |
| WithdrawalEscrow           | `0x1B740C86C135647059107976971Db65bB18C33d4` |

### Guards — Morpho Blue, Aave V3, Uniswap V3, ERC20 (deployed at launch)

| Contract                          | Address                                      |
| --------------------------------- | -------------------------------------------- |
| NftTrackerStorage (proxy)         | `0x726c7EcA79543D8B8d0BE42D5A8b0f0ceC792cA9` |
| SlippageAccumulator               | `0xCD3F83A25391a4869cd76F02b83d22705cFa5554` |
| MorphoBlueManager                 | `0xC45EDf53fd9e85BE2d9aB62206142438BF6F8AEB` |
| MorphoBlueContractGuard           | `0x0b54FAEe095746cf47E1813Db7a69F59E07977ab` |
| UniswapV3RouterGuard              | `0x6760074A6Ea849EE651Cc22f1c5a819521d97514` |
| UniswapV3NonfungiblePositionGuard | `0x3F412bA40A8Fb456adC2ef88F162B3C46D1a74D8` |
| AaveLendingPoolGuardV3            | `0x65E91C7eA3cDdF09Eb36B48220C1A5AE79C64569` |
| UniswapV3AssetGuard               | `0x566CE75Abd51E168A926143e462B909D02dD50B2` |
| AaveV3LendingPoolAssetGuard       | `0xd55045e15535D7E0BA09E6e291afE438C53534dD` |
| MorphoBlueLendingPoolAssetGuard   | `0x4648Cb8d28636f3B2541Cb41BFfc77B00131d2D0` |
| ERC20Guard                        | `0xc79F949E83b58B2833C9D99F38Ec3E499ACd71Df` |

**Morpho Blue markets are NOT configured.** `MorphoBlueManager.setPoolMarkets()` carries a structural self-dealing check (finding M-11): it refuses to run if its own owner is also the pool's manager. Since this deployment uses one wallet for every role, that check can never be satisfied — not a bug, the contract working exactly as designed. Morpho Blue lending is unavailable until a second, distinct address is given ownership of `MorphoBlueManager` specifically.

### Dormant guard families — deployed fresh for this engagement

| Contract                                                   | Address                                      |
| ---------------------------------------------------------- | -------------------------------------------- |
| AaveV4SpokeManager                                         | `0xcaB93530AA19F67F9856F99FA8ce62e92c56a232` |
| AaveV4SpokeContractGuard                                   | `0x80D680561F8010c29FD78e93C937894809C8ccFC` |
| AaveV4SpokeAssetGuard                                      | `0x597d4864B10cEF28C81e91FD0f6DA6D6DdcfF616` |
| AaveV4TokenizationManager                                  | `0xaceC469a746c2B970CD64e89211bcd7d7D686570` |
| AaveV4TokenizationContractGuard                            | `0xF0D0Eb572586fb41cDD642Cd4590833f50b17d4C` |
| AaveV4TokenizationAssetGuard                               | `0x08Cc1EDB0c96cF3582184A86909d8673023085dd` |
| MorphoVaultV2Manager                                       | `0xcA4aa8DAdC04e9A6245685850d906Aa5D6C7f9cD` |
| MorphoVaultV2ContractGuard                                 | `0x864d170F2F8C816270495f19F4F00a3Be735e880` |
| MorphoVaultV2AssetGuard                                    | `0x2c94680613Ee6CC1c406073FE2e123e77AB67011` |
| Morpho Vault V2 (EURC, active)                             | `0xAef59f2F4f84e948A24bE8F1c00e780E6F15daba` |
| Morpho Vault V2 (USDC, created then abandoned — see below) | `0x2961eCE69d9E5FB8A30d75d2222b8459BE88E763` |

**A USDC-denominated Morpho Vault V2 was created first, then abandoned once the EURC-only investment policy was set.** It was never whitelisted for real use after that decision and holds no funds; the EURC vault above is the one actually registered and used. Left on-chain rather than attempting to destroy it (vault contracts are not self-destructible); it is simply unused infrastructure.

**Aave V4 Spoke and Aave V4 Tokenization are deployed and registered, but have never had any capital invested through them.** Checked directly on-chain: Aave V4 on Base currently has no EURC-denominated Hub or Spoke at all — the only Base V4 markets found (the Equities Hub backing `MAG7_SPOKE`, and the Tokenization Spoke) are both USDC-only. Since the investment policy is EURC-only, these two guard families are kept as ready infrastructure for if/when Aave adds a EURC market on Base, and their validation logic was confirmed working (Section 4) without ever routing real funds through them.

### Remaining guard contracts deployed and verified (not part of this deployment's active integration set)

Deployed to confirm every guard contract this codebase defines deploys correctly and matches its validated counterpart exactly — not because this deployment actively uses them.

| Contract                                 | Address                                      | Status                                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MerklRewardClaimGuard                    | `0x614BAeeF2b9447927255043F45F619881CbEABf3` | Registered against Merkl's real Distributor on Base (`0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae`, confirmed live on-chain). No Merkl incentive campaign has been claimed through it — this deployment has no reward stream to claim yet. |
| AaveV3LendingPoolSelectiveAssetGuard     | `0xf966E389c3EF524E2Fc5365c97A1d61bBa624158` | Deployed with the exact same immutables as the live `AaveV3LendingPoolAssetGuard`, verified matching, ownership handed to the same owner. Not installed as the active guard.                                                              |
| MorphoBlueLendingPoolSelectiveAssetGuard | `0xCB9c9cc0cb1ffB9482f0C5BBCD143Af51E14AfBf` | Same treatment, verified against the live `MorphoBlueLendingPoolAssetGuard`. Uses a freshly deployed `MorphoCollectLib` (`0x98D6D7A51A3C13Cc0dDeA1bBbb99c2394C3d3906`). Not installed as the active guard.                                |
| UniswapV3SelectiveAssetGuard             | `0x238e00F023E6D3315C24B2122F7D6f9042Fd015A` | Deployed fresh; admin handed to the same address administering the live `UniswapV3AssetGuard`. Not installed as the active guard.                                                                                                         |
| AaveV4SpokeSelectiveAssetGuard           | `0x99f9c374E55c51053669eDb7E6BabFB6E4752c97` | Deployed with the exact same immutables as the live `AaveV4SpokeAssetGuard`, verified matching. Not installed as the active guard.                                                                                                        |

**None of the four Selective guards are installed as the active registered guard for their asset type.** They exist specifically to back the attested/selective withdrawal plan feature, which this deployment does not use — `Governance.setAssetGuard()` is global per asset type, so swapping one in would change live behavior for a feature that is not turned on, for no benefit. Deploying them here was itself the verification: each one was built with the same immutables as its live counterpart and confirmed to match before being left in place, unused but ready.

**A note on naming:** the file `AaveLendingPoolAssetGuard.sol` does not contain a separate, older Aave V3 contract — the contract declared inside it is `AaveV3LendingPoolAssetGuard`, the exact same one already listed above as deployed. There is no second "Aave V3 guard" waiting to be deployed under a different name. Separately, `ClosedAssetGuard.sol` is an abstract base contract with no deployable bytecode of its own (confirmed by reading the source) — every concrete guard that needs it already inherits it directly, so it is not something that can be deployed on its own.

## 3. External infrastructure referenced (not deployed by this project, real and pre-existing)

| Purpose                                                       | Address                                      |
| ------------------------------------------------------------- | -------------------------------------------- |
| EURC (Circle, Base)                                           | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` |
| EUR/USD Chainlink feed                                        | `0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F` |
| Aave V3 Pool (Base)                                           | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| Aave V3 Data Provider                                         | `0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A` |
| Aave V4 Equities Hub Spoke ("MAG7_SPOKE")                     | `0x17905Db0e4A3514467539956c084180616AE7B8D` |
| Aave V4 Tokenization Spoke (Equities/USDC)                    | `0x7081CE7EB1282c53CF38EA9B622f6269cb8FeFDc` |
| Morpho VaultV2Factory                                         | `0x4501125508079A99ebBebCE205DeC9593C2b5857` |
| Uniswap V3 Factory (Base)                                     | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| Uniswap V3 SwapRouter (Base)                                  | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Uniswap V3 EURC/USDC pool (0.05% — deepest EURC market found) | `0x7279c08A36333e12c3Fc81747963264c100D66fB` |
| Merkl Distributor (shared reward-claim infrastructure)        | `0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae` |

## 4. Testing performed — full user flow and every guard, with real EURC

16 of 16 tests passed. Every transaction below is real, confirmed on Base mainnet.

| #   | Test                                                                                                                          | Result | Transaction                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Deposit 7.0 EURC mints the EUR-converted fEURO amount (6.9979 fEURO, not 1:1)                                                 | PASS   | `0x4d28e43826119775eaae68f74f9825972edf84c43a4fa63ea807f29966283f36`                                                                                                                                                                    |
| 2   | Stake mints sfEURO 1:1                                                                                                        | PASS   | `0x89cbefa2620efd399da4a51d894bad3a8b24065d9ae67bb01abed2b7669e7513`                                                                                                                                                                    |
| 3   | Harvest correctly reverts `NothingToHarvest()` (no real yield source parked yet)                                              | PASS   | staticCall, selector `0x3f29331a`                                                                                                                                                                                                       |
| 4   | Unstake returns fEURO 1:1                                                                                                     | PASS   | `0xaa3bd1690badb9933e4e2744266adfaef46fc9e517ece99ffeacd94ddf0754ef`                                                                                                                                                                    |
| 5   | ERC20Guard: EURC approve accepted, unsupported-asset approve rejected                                                         | PASS   | staticCall pair                                                                                                                                                                                                                         |
| 6   | Aave V3 EURC supply + withdraw (real round-trip, 2.0 EURC)                                                                    | PASS   | supply `0x203027d7639ec17311b0f6314a9e60b05182b50f44de079018b69086eb2d61ac`, withdraw `0x95358e1cfac9c17b82d165833ef49e55b63de5dbb149e5a1488903dc8356fbcc`                                                                              |
| 7   | Morpho Vault V2 (EURC) deposit + withdraw (real round-trip, 2.0 EURC)                                                         | PASS   | deposit `0x25f4d7b25e36739d040225ca6576da9b0a44f9dda06077b56c6f8c4a6944fe66`, withdraw `0x8727de07ae95eed7f3052877c149d60df5a54167e00fdf5e4a37c342858fb3a5`                                                                             |
| 8   | Uniswap M-09: zero output-minimum swap rejected                                                                               | PASS   | staticCall                                                                                                                                                                                                                              |
| 9   | Uniswap M-12: multi-hop path through an unsupported token rejected                                                            | PASS   | staticCall                                                                                                                                                                                                                              |
| 10  | Aave V4 Spoke: supply to non-whitelisted reserve rejected (no EURC market exists — infrastructure verified without investing) | PASS   | staticCall                                                                                                                                                                                                                              |
| 11  | Aave V4 Tokenization: `receiver != pool` rejected (no EURC market exists — infrastructure verified without investing)         | PASS   | staticCall                                                                                                                                                                                                                              |
| 12  | `withdrawCashImmediate`                                                                                                       | PASS   | `0x974f474036d5affe01e7a62fb3e680d9eb2669af17970829d64c102e4d77945d`                                                                                                                                                                    |
| 13  | `withdrawCashImmediateTo` (self)                                                                                              | PASS   | `0x288139b23a89d0893f1785d5d437597bb2f00bd7b16494d69ff282e39d3e5d2d`                                                                                                                                                                    |
| 14  | `withdrawCashImmediateSafe`                                                                                                   | PASS   | `0x6363e536bf4c00328099e1b06f00904928c04b5988d508b609f4e0a556e99733`                                                                                                                                                                    |
| 15  | `withdrawCashImmediateToSafe` (self)                                                                                          | PASS   | `0xdb5f579fc784d1c57c34a2122708b65e05dbebb05f9d349cf7e23913aee13b6e`                                                                                                                                                                    |
| 16  | Queued withdrawal: `requestCashWithdraw` + `finalizeCashWithdraw` + `claimCashWithdraw`                                       | PASS   | request `0xbddd14abc17882a947209b45f633607fd90bad84be738dfc3e3da391cfc8c664`, finalize `0x8737a4375d619841efb5324de2f0440f82ad5cb74c10d5dddfea6f1ceeaaae7b`, claim `0x01882a566e56bb333a6b64946c3d3301743229d14c9a50d94f7ca25bf69e2551` |

Supporting setup transactions (real, also on mainnet): EURC approvals before each deposit/stake/withdraw step, the EURC Morpho Vault V2's `addAsset`/`setChainlinkTimeout`/`setContractGuard`/`setPoolVaults`/`changeAssets` registration calls, `setImmediateWithdrawEnabled(false)` then `(true)` around the queued-withdrawal test, and `TokenLogic.setCooldown(120)` (tx `0x11fb0bff3c889e72cd1c406280ff5aabff16252338433c7d25bc20763de1a1e7`).

**Fund accounting check:** starting EURC balance 9.509431, ending EURC balance 9.509427, fEURO balance 0 at the end — a complete deposit→stake→unstake→withdraw round-trip returning the original funds to within 0.000004 EURC (rounding dust from internal share-price math, not a leak).

## 5. A real issue found and fixed during testing

The very first deposit attempt reverted on-chain (real gas spent, transaction `0xf636ab5e...`, status failed). Diagnosed directly rather than assumed: the failed transaction's gas usage (984,346) was almost exactly at its gas limit (1,000,000), and a staticCall of the identical deposit against the exact same on-chain state succeeded cleanly with no gas cap — confirming an undersized gas limit on that one call, not a configuration or contract defect. Every gas limit in the test script was increased generously before retrying; the retried deposit (and everything after it) succeeded. No contract or configuration change was needed.

## 6. Transparency note on transaction records

Every transaction hash in Section 4 was captured directly from this session's own transaction receipts and is independently verifiable on a Base block explorer. The initial contract deployment (Section 2's core contracts and first guard set) and the subsequent EURC/dormant-guard configuration pass were run as two earlier scripts whose output recorded each resulting contract address but not each individual transaction hash. Every one of those addresses has real, verified deployed bytecode on Base mainnet as of this report (confirmed directly, Section 2) — the deployments are real and live even though the two earlier scripts' own per-step transaction hashes were not individually retained.

## 7. Known limitations, stated plainly

- **Morpho Blue:** not usable — self-dealing check (M-11) cannot be satisfied with one wallet holding every role.
- **Aave V4 Spoke and Tokenization:** not usable for real investment — no EURC-denominated market exists on Aave V4 Base today. Guards are deployed, registered, and their validation logic is confirmed correct; no capital has ever moved through them.
- **Single wallet holds every role.** Fine for internal testing; a real launch should separate these across dedicated addresses (and, for Morpho Blue specifically, this is a hard requirement to unlock the integration at all).
- **Deposit cap (10,000 fEURO) and cooldown (2 minutes)** are internal-testing values, not production settings — both are adjustable by the admin role at any time.

## 8. Reproducing or extending this work

Scripts (all require `--network base` and `SEND=1` to broadcast for real; default to a dry-run preview otherwise):

- `scripts/deploy_eur_mainnet_internal.ts` — the initial deployment (Section 2's core contracts and first guard set).
- `scripts/configure_eurc_and_dormant_guards_mainnet.ts` — switches the deposit asset to EURC and deploys the three dormant guard families.
- `scripts/test_eurc_mainnet_full_flow.ts` — the full user-flow and guard-by-guard test suite (Section 4).
- `scripts/deploy_remaining_guards_mainnet.ts` — deploys and verifies the remaining guard contracts (Section 2's "Remaining guard contracts" table).

Deployment/configuration/test records are saved under `deployments/deploy-eur-mainnet-*.json`.
