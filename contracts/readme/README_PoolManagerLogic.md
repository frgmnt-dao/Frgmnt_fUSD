# Frgmnt Protocol — PoolManagerLogic Contract

## 🔹 Overview

`PoolManagerLogic` is the **core management contract** of the **Frgmnt Protocol**, governing all operational logic for investment pools.  
It manages supported assets, fees, roles, and access permissions. The contract is upgradeable, modular, and security-hardened through guards and role separation.

---

## ⚙️ Technical Summary

| Property             | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| **Contract Name**    | `PoolManagerLogic`                                                    |
| **Solidity Version** | `^0.8.24`                                                             |
| **Inheritance**      | `Initializable`, `IPoolManagerLogic`, `IHasSupportedAsset`, `Managed` |
| **Upgradeability**   | Yes (via OpenZeppelin `Initializable`)                                |
| **Purpose**          | Controls all pool parameters, fees, assets, and access roles          |
| **Location**         | `contracts/contracts/PoolManagerLogic.sol`                            |

---

## 🔹 Core Functions Overview

| Category                | Key Functions                                                                          | Description                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Fee Management**      | `setFeeNumerator`, `announceFeeIncrease`, `commitFeeIncrease`, `renounceFeeIncrease`   | Configure and safely adjust performance/management fees with enforced delay. |
| **Asset Management**    | `changeAssets`, `_addAsset`, `_removeAsset`                                            | Manage supported pool assets and enforce validation through guards.          |
| **Valuation**           | `assetValue`, `totalFundValue`, `getFundComposition`                                   | Compute balances and USD-equivalent pool values.                             |
| **Roles & Permissions** | `setTraderAssetChangeDisabled`, `setNftMembershipCollectionAddress`, `isMemberAllowed` | Manage role-based access and optional NFT membership gating.                 |
| **Factory Integration** | `setPoolLogic`, `_emitFactoryEvent`                                                    | Link to the pool logic and notify the factory of updates.                    |
| **Configuration**       | `setMinDepositUSD`, `_setMinDepositUSD`                                                | Define operational thresholds like minimum deposits.                         |

---

## 💰 Fee Management (Core Functions)

````solidity
function setFeeNumerator(
  uint256 _performanceFeeNumerator,
  uint256 _managerFeeNumerator,
  uint256 _entryFeeNumerator,
  uint256 _exitFeeNumerator
) external onlyManager;

function announceFeeIncrease(
  uint256 _performanceFeeNumerator,
  uint256 _managerFeeNumerator,
  uint256 _entryFeeNumerator,
  uint256 _exitFeeNumerator
) external onlyManager;

function commitFeeIncrease() external onlyManager;

function renounceFeeIncrease() external onlyManager;

function getFee() external view returns (
  uint256 performanceFeeNumerator,
  uint256 managerFeeNumerator,
  uint256 entryFeeNumerator,
  uint256 exitFeeNumerator,
  uint256 denominator
);
# Frgmnt Protocol — PoolManagerLogic Contract

## 🔹 Overview

`PoolManagerLogic` is the **core management contract** of the **Frgmnt Protocol**, governing all operational logic for investment pools.
It manages supported assets, fees, roles, and access permissions. The contract is upgradeable, modular, and security-hardened through guards and role separation.

---

## ⚙️ Technical Summary

| Property | Description |
|-----------|-------------|
| **Contract Name** | `PoolManagerLogic` |
| **Solidity Version** | `^0.8.24` |
| **Inheritance** | `Initializable`, `IPoolManagerLogic`, `IHasSupportedAsset`, `Managed` |
| **Upgradeability** | Yes (via OpenZeppelin `Initializable`) |
| **Purpose** | Controls all pool parameters, fees, assets, and access roles |
| **Location** | `contracts/contracts/PoolManagerLogic.sol` |

---

## 🔹 Core Functions Overview

| Category | Key Functions | Description |
|-----------|----------------|-------------|
| **Fee Management** | `setFeeNumerator`, `announceFeeIncrease`, `commitFeeIncrease`, `renounceFeeIncrease` | Configure and safely adjust performance/management fees with enforced delay. |
| **Asset Management** | `changeAssets`, `_addAsset`, `_removeAsset` | Manage supported pool assets and enforce validation through guards. |
| **Valuation** | `assetValue`, `totalFundValue`, `getFundComposition` | Compute balances and USD-equivalent pool values. |
| **Roles & Permissions** | `setTraderAssetChangeDisabled`, `setNftMembershipCollectionAddress`, `isMemberAllowed` | Manage role-based access and optional NFT membership gating. |
| **Factory Integration** | `setPoolLogic`, `_emitFactoryEvent` | Link to the pool logic and notify the factory of updates. |
| **Configuration** | `setMinDepositUSD`, `_setMinDepositUSD` | Define operational thresholds like minimum deposits. |

---

## 💰 Fee Management (Core Functions)

```solidity
function setFeeNumerator(
  uint256 _performanceFeeNumerator,
  uint256 _managerFeeNumerator,
  uint256 _entryFeeNumerator,
  uint256 _exitFeeNumerator
) external onlyManager;

function announceFeeIncrease(
  uint256 _performanceFeeNumerator,
  uint256 _managerFeeNumerator,
  uint256 _entryFeeNumerator,
  uint256 _exitFeeNumerator
) external onlyManager;

function commitFeeIncrease() external onlyManager;

function renounceFeeIncrease() external onlyManager;

function getFee() external view returns (
  uint256 performanceFeeNumerator,
  uint256 managerFeeNumerator,
  uint256 entryFeeNumerator,
  uint256 exitFeeNumerator,
  uint256 denominator
);


## 💰 Asset Management (Core Functions)

function changeAssets(
  Asset[] calldata _addAssets,
  address[] calldata _removeAssets
) external;

function _addAsset(Asset calldata _asset) internal;

function _removeAsset(address _asset) internal;

function isSupportedAsset(address asset) public view returns (bool);

function isDepositAsset(address asset) public view returns (bool);

function getSupportedAssets() external view returns (Asset[] memory);

function getDepositAssets() external view returns (address[] memory);

function validateAsset(address asset) public view returns (bool);

## 💰 Valuation Functions

function assetBalance(address asset) public view returns (uint256);

function assetValue(address asset) public view returns (uint256);

function assetValue(address asset, uint256 amount) public view returns (uint256);

function getFundComposition() external view returns (
  address[] memory assets,
  uint256[] memory balances,
  uint256[] memory rates
);

function totalFundValue() external view returns (uint256);

## 💰 Role & Membership Control

function setTraderAssetChangeDisabled(bool disabled) external onlyManager;

function setNftMembershipCollectionAddress(address collection) external onlyManager;

function isNftMemberAllowed(address member) public view returns (bool);

function isMemberAllowed(address member) public view returns (bool);

## 💰 Factory Integration

function setPoolLogic(address _poolLogic) external returns (bool);

function _emitFactoryEvent() internal;

## 💰 Configuration

function setMinDepositUSD(uint256 minDepositUSD) external onlyManager;

function _setMinDepositUSD(uint256 minDepositUSD) internal;

````
