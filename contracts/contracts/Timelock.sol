// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * ------------------------------------------------------------------------
 *  Frgmnt Finance — Governance Timelock
 * ------------------------------------------------------------------------
 *
 *  This contract is intended to be assigned as the admin/owner/controller
 *  for privileged protocol contracts (upgrades, config changes, guards, etc.)
 *
 *  Best-practice deployment parameters:
 *  - minDelay   = 48 hours
 *  - proposers  = [GovernanceSafe]  (Frgmnt Gnosis Safe multisig)
 *  - executors  = [address(0)]      (anyone can execute after delay)
 *  - admin      = GovernanceSafe
 * ------------------------------------------------------------------------
 */
contract Timelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
