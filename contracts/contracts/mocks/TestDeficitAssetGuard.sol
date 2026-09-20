// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TestAssetGuard } from "./TestAssetGuard.sol";

/// @notice Test-only: TestAssetGuard that also reports a configurable deficit through the
///         IDeficitReportingGuard marker pair, to model a pool carrying a non-recourse deficit.
contract TestDeficitAssetGuard is TestAssetGuard {
    uint256 public deficit;

    function setDeficit(uint256 v) external {
        deficit = v;
    }

    function isDeficitReportingGuard() external pure returns (bool) {
        return true;
    }

    function getDeficit(address, address) external view returns (uint256) {
        return deficit;
    }
}
