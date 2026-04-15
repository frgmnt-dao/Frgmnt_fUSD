# Managed

**Source:** `contracts/contracts/Managed.sol`

---

## Overview

Managed is the role management base contract inherited by PoolManagerLogic. It defines the manager, trader, and member roles that govern pool operations.

---

## Responsibilities

- Store and enforce the manager role (primary pool authority)
- Optionally designate a trader role (secondary execution authority)
- Maintain a membership list for private pools
- Provide modifiers and helper functions used by PoolManagerLogic

---

## State Variables

| Variable | Type | Description |
|----------|------|-------------|
| `manager` | `address` | Current manager address |
| `managerName` | `string` | Human-readable manager identifier |
| `_memberList` | `address[]` | Dynamic array of registered member addresses |
| `_memberPosition` | `mapping(address → uint256)` | 1-based position of each member in `_memberList` (0 = not a member) |
| `trader` | `address` | Optional trader role address |

---

## Functions

### Initialization

#### `_initialize`

```solidity
function _initialize(address _manager, string memory _managerName) internal
```

Internal setup called from PoolManagerLogic's `initialize`. Sets initial manager and name.

---

### Manager Operations

#### `_changeManager`

```solidity
function _changeManager(address newManager, string memory newName) internal
```

Internal manager change with non-zero address validation. Emits `ManagerUpdated`.

---

### Trader Management

#### `setTrader`

```solidity
function setTrader(address newTrader) external onlyManager
```

Designates an optional trader role. Traders can execute guarded vault transactions.

**Access control:** Manager only.

#### `removeTrader`

```solidity
function removeTrader() external onlyManager
```

Removes the trader role. Emits `TraderRemoved`.

---

### Member Management

#### `addMember` / `addMembers`

```solidity
function addMember(address member) external onlyManager
function addMembers(address[] calldata members) external onlyManager
```

Adds one or multiple addresses to the member list. Used for private pool access control.

#### `removeMember` / `removeMembers`

```solidity
function removeMember(address member) external onlyManager
function removeMembers(address[] calldata members) external onlyManager
```

Removes one or multiple addresses. Uses swap-and-pop for O(1) deletion.

#### `getMembers`

```solidity
function getMembers() external view returns (address[] memory)
```

Returns the full member list.

#### `numberOfMembers`

```solidity
function numberOfMembers() external view returns (uint256)
```

Returns current member count.

---

## Events

| Event | Parameters | Emitted When |
|-------|-----------|-------------|
| `ManagerUpdated` | `manager (indexed), name` | Manager changed |
| `MemberAdded` | `member (indexed)` | Member added |
| `MemberRemoved` | `member (indexed)` | Member removed |
| `TraderUpdated` | `trader (indexed)` | Trader assigned |
| `TraderRemoved` | `trader (indexed)` | Trader removed |

---

## Access Control

| Modifier | Allows |
|---------|--------|
| `onlyManager` | Manager address only |
| `onlyManagerOrTrader` | Manager or Trader address |

---

## Membership Model

The member list is used by PoolLogic to gate `stake()` and `requestCashWithdraw()` when the pool is configured as private (`privatePool = true`). Any address not in the member list (and not the manager) is rejected.

Members have no special execution permissions — they are purely an access list.
