# Governance — Frgmnt Core Authority Contract

The **Governance** contract defines the **central authority layer** of the **Frgmnt Protocol**, managing the mapping of **contracts** and **asset types** to their corresponding **guard modules**.  
These guards define what external integrations and asset interactions are permitted across the ecosystem.

It is designed for **security, transparency, and modular extensibility**, using OpenZeppelin’s `Ownable` pattern to restrict administrative actions to the protocol’s governance authority.

---

## 🔹 Overview

The `Governance` contract acts as a **registry and enforcement module** that:

- Defines **which external protocols** can be integrated safely.
- Assigns **guards** to each contract and asset type.
- Enables modular **security enforcement** across Frgmnt components.

It is a **non-upgradeable**, **lightweight**, and **centralized authority** for managing system-level configuration.

---

## 🔹 Technical Summary

| Property             | Description                           |
| -------------------- | ------------------------------------- |
| **Contract Name**    | `Governance`                          |
| **Solidity Version** | ^0.8.24                               |
| **Access Control**   | `Ownable` (from OpenZeppelin v5)      |
| **Upgradeability**   | Non-upgradeable                       |
| **Dependencies**     | `Ownable.sol`, `IGovernance.sol`      |
| **Core Purpose**     | Registry of contract and asset guards |
| **Security Design**  | Admin-only operations via `onlyOwner` |

---

## 🔹 Core Features

| Function                                                      | Description                                   |
| ------------------------------------------------------------- | --------------------------------------------- |
| `setContractGuard(address extContract, address guardAddress)` | Registers a guard for a third-party contract. |
| `setAssetGuard(uint16 assetType, address guardAddress)`       | Registers a guard for an asset type.          |
| `contractGuards(address)`                                     | Returns the guard assigned to a contract.     |
| `assetGuards(uint16)`                                         | Returns the guard assigned to an asset type.  |

All setters are restricted to the **owner** (protocol governance).

---

## 🔹 Events

| Event                                                         | Parameters                                             | Description |
| ------------------------------------------------------------- | ------------------------------------------------------ | ----------- |
| `ContractGuardSet(address extContract, address guardAddress)` | Emitted when a new guard is assigned to a contract.    |
| `AssetGuardSet(uint16 assetType, address guardAddress)`       | Emitted when a new guard is assigned to an asset type. |

---

## 🔹 Example Usage

```solidity
// Assigning guards through the governance authority
governance.setContractGuard(0xExternalProtocol, 0xGuardAddress);
governance.setAssetGuard(1, 0xERC20AssetGuard);
```
