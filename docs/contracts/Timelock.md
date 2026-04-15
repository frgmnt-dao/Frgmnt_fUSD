# Timelock

**Source:** `contracts/contracts/Timelock.sol`
**Inherits:** OpenZeppelin `TimelockController`

---

## Overview

The Timelock contract is the protocol's governance delay mechanism. It wraps OpenZeppelin's `TimelockController` to enforce a mandatory waiting period between when a governance action is proposed and when it can be executed.

All privileged admin operations — including contract upgrades, configuration changes, and guard registration — must pass through the Timelock, preventing unilateral admin actions.

---

## Responsibilities

- Enforce a minimum delay between proposal and execution of governance actions
- Gate upgrade authority for all UUPS proxy contracts
- Serve as the owner of the Governance contract (guard registry)
- Manage proposer/executor role assignments for the DAO multisig

---

## State Variables

All state is inherited from `TimelockController`:

| Variable | Description |
|----------|-------------|
| `_minDelay` | Minimum delay in seconds before an operation can be executed |
| Scheduled operations | Mapping of operation IDs to timestamps and status |
| Role assignments | `PROPOSER_ROLE`, `EXECUTOR_ROLE`, `TIMELOCK_ADMIN_ROLE` |

---

## Constructor

```solidity
constructor(
    uint256 minDelay,
    address[] memory proposers,
    address[] memory executors,
    address admin
)
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `minDelay` | `uint256` | Minimum execution delay in seconds (recommended: 172800 = 48 hours) |
| `proposers` | `address[]` | Addresses authorized to schedule operations (recommended: DAO multisig) |
| `executors` | `address[]` | Addresses authorized to execute operations (can be empty array for open execution) |
| `admin` | `address` | Address that can grant/revoke roles (recommended: DAO multisig or zero address after setup) |

---

## Inherited Functions

All operational functions are inherited from `TimelockController`:

### `schedule`

```solidity
function schedule(
    address target,
    uint256 value,
    bytes calldata data,
    bytes32 predecessor,
    bytes32 salt,
    uint256 delay
) external onlyRole(PROPOSER_ROLE)
```

Schedules a single operation with a delay. The operation cannot be executed before `block.timestamp + delay`.

---

### `scheduleBatch`

```solidity
function scheduleBatch(
    address[] calldata targets,
    uint256[] calldata values,
    bytes[] calldata payloads,
    bytes32 predecessor,
    bytes32 salt,
    uint256 delay
) external onlyRole(PROPOSER_ROLE)
```

Schedules a batch of operations atomically.

---

### `execute`

```solidity
function execute(
    address target,
    uint256 value,
    bytes calldata payload,
    bytes32 predecessor,
    bytes32 salt
) external payable onlyRoleOrOpenRole(EXECUTOR_ROLE)
```

Executes a scheduled operation after its delay has elapsed.

---

### `cancel`

```solidity
function cancel(bytes32 id) external onlyRole(CANCELLER_ROLE)
```

Cancels a pending operation before it executes.

---

## Events

Inherited from `TimelockController`:

| Event | Description |
|-------|-------------|
| `CallScheduled` | Operation scheduled |
| `CallExecuted` | Operation executed |
| `Cancelled` | Operation cancelled |
| `MinDelayChange` | Minimum delay updated |

---

## Access Control

| Role | Description | Recommended Holder |
|------|-------------|-------------------|
| `PROPOSER_ROLE` | Can schedule operations | DAO multisig |
| `CANCELLER_ROLE` | Can cancel scheduled operations | DAO multisig |
| `EXECUTOR_ROLE` | Can execute operations after delay | Open (any address) or DAO multisig |
| `TIMELOCK_ADMIN_ROLE` | Can grant/revoke roles | Zero address (after renouncing) or DAO multisig |

---

## Deployment Recommendations

- Set `minDelay` to `172800` (48 hours)
- Grant `PROPOSER_ROLE` and `CANCELLER_ROLE` to the DAO multisig
- Set `EXECUTOR_ROLE` to the zero address for open execution
- After setup, renounce `TIMELOCK_ADMIN_ROLE` from the deployer to prevent centralized role manipulation

---

## Usage Example

```solidity
// Schedule an upgrade to TokenLogic
timelock.schedule(
    TOKEN_LOGIC_PROXY,
    0,
    abi.encodeWithSignature("upgradeTo(address)", NEW_IMPL),
    bytes32(0),   // no predecessor
    bytes32(0),   // salt
    172800        // 48 hours
);

// 48 hours later, execute
timelock.execute(
    TOKEN_LOGIC_PROXY,
    0,
    abi.encodeWithSignature("upgradeTo(address)", NEW_IMPL),
    bytes32(0),
    bytes32(0)
);
```
