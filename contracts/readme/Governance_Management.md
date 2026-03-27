# Frgmnt Finance — Governance Overview

## Overview

Frgmnt Finance uses a **layered governance architecture** designed to balance:

- Security and resilience
- Transparency and predictability
- Operational efficiency
- Progressive decentralization

Rather than relying on a single controlling account, the protocol combines **time-delayed execution**, **multisignature approval**, and **clear role separation** to manage upgrades, configuration changes, and daily operations in a robust and transparent manner.

---

## Core Governance Components

### Timelock

Frgmnt Finance uses OpenZeppelin’s `TimelockController` as the **central execution layer** for governance actions.

The Timelock enforces a mandatory delay between:

1. Approval of a governance action
2. Its on-chain execution

This delay ensures that:

- Governance actions cannot be executed immediately
- Changes are visible on-chain before they take effect
- Users, integrators, and ecosystem participants have time to react

Typical actions executed through the Timelock include:

- Contract upgrades
- Protocol configuration changes
- Asset and oracle management
- Guard and validation logic updates

---

### GovernanceSafe (Multisignature Wallet)

A **Gnosis Safe multisignature wallet**, referred to as the GovernanceSafe, is used to approve and propose governance actions.

Key properties:

- Requires multiple independent signers to approve an action
- Eliminates reliance on a single private key
- Provides strong operational security guarantees

The GovernanceSafe:

- Proposes actions to the Timelock
- Acts as the administrator of the Timelock
- Does not execute changes directly without delay

---

### EmergencySafe

A **dedicated multisignature wallet** is reserved for emergency actions.

Emergency actions are intentionally limited to:

- Pausing sensitive protocol functionality
- Resuming operations after incidents or maintenance

Key characteristics:

- No time delay (to allow rapid response)
- Narrow scope of permissions
- Separate signers from governance where possible

This separation ensures that emergency powers cannot be misused to change protocol rules or extract value.

---

### TraderSafe (Operational Wallet)

Operational activities such as trading and execution are handled by a dedicated operational wallet, referred to as the TraderSafe.

The TraderSafe:

- Can execute predefined operational transactions
- Cannot upgrade contracts
- Cannot modify governance parameters
- Cannot change asset or oracle configurations

This allows the protocol to remain efficient while preserving strict governance boundaries.

---

## How Governance Works in Practice

A typical governance flow follows these steps:

1. A proposal is prepared and approved by the GovernanceSafe multisignature
2. The proposal is scheduled in the Timelock contract
3. The proposal enters a waiting period defined by the Timelock delay
4. After the delay expires, the proposal becomes executable
5. Any address may execute the proposal once eligible

This process ensures governance actions are:

- Predictable
- Observable
- Resistant to rushed or unilateral changes

---

## Role Separation and Responsibility Model

| Role           | Purpose             | Examples                |
| -------------- | ------------------- | ----------------------- |
| Timelock       | Delayed execution   | Upgrades, configuration |
| GovernanceSafe | Approval & proposal | Strategy and parameters |
| EmergencySafe  | Emergency response  | Pause / unpause         |
| TraderSafe     | Operations          | Trading, execution      |

Each role is explicitly scoped to its responsibilities, reducing the impact of any single compromise.

---

## Contract Governance Model

Frgmnt Finance contracts follow a consistent governance pattern:

- Core contracts are **owned or controlled by the Timelock**
- Administrative roles are **not held by externally owned accounts**
- Deployment and setup privileges are removed after initialization
- All sensitive actions flow through the governance system

This applies across:

- Token contracts
- Pool logic contracts
- Asset and oracle registries
- Guard and validation modules

---

## Privilege Lifecycle Management

After deployment and setup:

- Ownership is transferred to the Timelock
- Administrative roles are reassigned to governance-controlled addresses
- Temporary setup accounts relinquish all special permissions

This ensures:

- No hidden or residual privileges
- Clear and auditable authority paths
- Long-term consistency of governance controls

---

## Security Philosophy

Frgmnt Finance governance is built on the following principles:

- **Least privilege**  
  Each role has only the permissions required for its function.

- **Defense in depth**  
  Multiple independent safeguards protect critical operations.

- **Transparency by design**  
  Governance actions are visible before execution.

- **Composable security**  
  The system relies on widely adopted, well-tested building blocks.

---

## Future Governance Evolution

Frgmnt Finance is designed for **progressive decentralization**.

The current governance structure provides strong guarantees while allowing flexibility for future evolution.

---

### DAO-Based Governance

Future iterations may introduce:

- On-chain proposal creation
- Token-based or NFT-based voting
- Delegated voting and representation
- Community-driven governance processes

In such a model:

- The DAO becomes the primary proposer
- The Timelock remains the execution layer
- Multisignature wallets may act as guardians or emergency backstops

---

### Progressive Decentralization Roadmap

A typical governance evolution path:

1. **Multisignature Governance**  
   Timelock + multisignature approval

2. **Hybrid Governance**  
   DAO proposes, Timelock executes

3. **Full DAO Governance**  
   Community-controlled governance with emergency safeguards

---

### Additional Best Practices and Enhancements

Planned or recommended improvements include:

- Different execution delays for different action categories
- Separate Timelocks for upgrades versus parameter changes
- On-chain proposal metadata stored on IPFS or Arweave
- Public governance dashboards
- Automated monitoring and alerting systems
- Formalized emergency procedures and playbooks

---

## Summary

Frgmnt Finance governance combines:

- Time-delayed execution through a Timelock
- Multisignature approval for sensitive actions
- Clear separation between governance, emergency, and operations

This architecture provides strong security and transparency today, while enabling a smooth transition toward fully decentralized, community-driven governance in the future.

---
