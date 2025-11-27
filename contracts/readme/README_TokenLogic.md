# FUSD — Frgmnt Stable Asset (Upgradeable ERC20)

**FUSD** is the native stablecoin of the **Frgmnt Protocol**.  
It represents a tokenized claim on approved stablecoins (like USDC, DAI, USDT) deposited into a staking pool (`sfusd`).  
The contract is designed with security, modularity, and upgradability in mind, following best practices of Solidity and OpenZeppelin (v5).

---

## 🔹 Overview

The **FUSD** contract allows users to deposit approved stablecoins and receive minted FUSD tokens at the equivalent USD value fetched from an oracle.  
It operates as an **upgradeable**, **governance-controlled**, **deposit-only** contract with role-based access control and pausable safety mechanisms.

---

## 🔹 Technical Summary

| Property             | Value / Description                             |
| -------------------- | ----------------------------------------------- |
| **Contract Name**    | `FUSD`                                          |
| **Token Name**       | `FUSD`                                          |
| **Symbol**           | `FUSD`                                          |
| **Decimals**         | `18`                                            |
| **Standard**         | ERC20Upgradeable                                |
| **Upgrade Pattern**  | UUPS (Universal Upgradeable Proxy Standard)     |
| **Security Modules** | ReentrancyGuardUpgradeable, PausableUpgradeable |
| **Access Control**   | Role-based (Admin, Governance, Emergency)       |
| **Purpose**          | Mint FUSD by depositing approved stablecoins    |
| **Dependencies**     | OpenZeppelin v5, Hardhat Upgrades Plugin        |

---

## 🔹 Roles and Permissions

| Role                   | Purpose                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| **DEFAULT_ADMIN_ROLE** | Can grant and revoke roles.                                                           |
| **GOVERNANCE_ROLE**    | Can manage oracle, SFUSD sink, and allowed assets. Also authorizes contract upgrades. |
| **EMERGENCY_ROLE**     | Can pause or unpause deposits during emergencies.                                     |

All role checks are enforced using OpenZeppelin’s `AccessControlUpgradeable`.

---

## 🔹 Core Concepts

### 1. Deposit Flow

Users deposit allowed stablecoins, which are then transferred to a predefined sink (`sfusd`).  
FUSD is minted 1:1 at the asset’s USD price using an oracle.
