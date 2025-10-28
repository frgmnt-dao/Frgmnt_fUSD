
---

## 🧩 `README_Managed.md`

```markdown
# Managed — Frgmnt Role & Membership Management Module

The **Managed** contract provides **role-based access and membership management** for protocol entities such as funds, vaults, and strategy managers.  
It defines a clear hierarchy between **manager**, **trader**, and **member** roles, ensuring operational control with minimal on-chain overhead.

This module is a **core governance primitive** of the Frgmnt ecosystem, enabling decentralized control of protocol-managed components.

---

## 🔹 Overview

The `Managed` contract provides an **on-chain management layer** that allows:
- Secure assignment and transfer of the **manager** role.
- Delegation of a **trader** role for restricted operational actions.
- Addition and removal of **members** (investors, whitelisted participants, or delegates).

It’s designed for **gas efficiency**, **clarity**, and **safety**, using **custom errors** instead of revert strings.

---

## 🔹 Technical Summary

| Property | Description |
|-----------|--------------|
| **Contract Name** | `Managed` |
| **Solidity Version** | ^0.8.24 |
| **Access Control** | Custom modifiers (`onlyManager`, `onlyManagerOrTrader`) |
| **Interfaces** | `IManaged` |
| **Upgradeability** | Non-upgradeable |
| **Dependencies** | None external |
| **Main Roles** | Manager, Trader, Members |
| **Initialization** | `_initialize(address, string)` internal setup function |

---

## 🔹 Roles and Permissions

| Role | Description |
|------|--------------|
| **Manager** | Primary authority controlling membership and trader assignments. |
| **Trader** | Secondary role with limited authority; can act alongside the manager for operational actions. |
| **Members** | Whitelisted addresses managed by the current manager. |

---

## 🔹 Core Features

| Function | Description |
|-----------|--------------|
| `_initialize(address, string)` | Sets up the initial manager and manager name. |
| `changeManager(address, string)` | Updates manager credentials and emits `ManagerUpdated`. |
| `setTrader(address)` / `removeTrader()` | Assigns or clears the trader role. |
| `addMember(address)` / `removeMember(address)` | Adds or removes one member. |
| `addMembers(address[])` / `removeMembers(address[])` | Batch add/remove for efficiency. |
| `numberOfMembers()` | Returns total members in the list. |
| `getMembers()` | Returns all current member addresses. |

---

## 🔹 Events

| Event | Parameters | Description |
|--------|-------------|-------------|
| `ManagerUpdated(address newManager, string newManagerName)` | Emitted when the manager role changes. |

---

## 🔹 Errors

| Error | Trigger |
|--------|----------|
| `OnlyManager()` | Caller is not the current manager. |
| `OnlyManagerOrTrader()` | Caller is neither manager nor trader. |
| `InvalidManager()` | Attempt to assign a zero address as manager. |
| `InvalidTrader()` | Attempt to assign a zero address as trader. |

---

## 🔹 Design Principles

- **Role Separation** — Distinguishes between strategic control (manager) and operational execution (trader).  
- **Gas Efficiency** — Custom errors and optimized loops reduce gas costs.  
- **Flexibility** — Supports batch operations for large member sets.  
- **Simplicity** — Minimal dependencies and predictable role logic.  
- **Interoperability** — Designed to integrate seamlessly with vault, governance, and strategy modules in Frgmnt.

---

## 🔹 Example Usage

```solidity
// Initialize with manager
managed._initialize(0xManager, "Vault Alpha");

// Add trader and members
managed.setTrader(0xTrader);
managed.addMembers([0xAlice, 0xBob]);

// Change manager
managed.changeManager(0xNewManager, "Vault Beta Manager");
