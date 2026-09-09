// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice CertiK FNA-60: simulates a not-yet-upgraded PoolLogic implementation that has no
/// pendingCashWithdrawCount(address) getter, so PoolManagerLogic._removeAsset()'s staticcall
/// against it genuinely fails (ok=false) rather than being simulated via a bare EOA — which
/// setPoolLogic() itself would reject (it requires poolManagerLogic() to resolve correctly).
contract MockPoolLogicLegacy {
    address public poolManagerLogic;

    function setManager(address m) external {
        poolManagerLogic = m;
    }
}
