// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal configurable mock of an Aave V4 Spoke for guard unit tests.
/// @dev `getReserve` returns `(underlying, hub, assetId)` — the exact first three fields of the
///      real Reserve struct (confirmed against Aave V4's published source, see ISpoke), which is
///      all the guard's raw-staticcall extraction reads. This mock doubles as its own "Hub"
///      (`hub` is always `address(this)`, `assetId` is always the reserveId) rather than wiring a
///      separate mock Hub contract, since tests don't need them to differ.
/// @dev FNA-07: `getAssetLiquidity` defaults to `type(uint256).max` (fully liquid) for any
///      reserveId that never had `setAvailableLiquidity` called, so every pre-existing test in
///      this suite that predates the liquidity cap keeps its exact original behavior.
contract MockAaveV4Spoke {
    mapping(uint256 => address) public reserveUnderlying;
    mapping(uint256 => mapping(address => uint256)) public suppliedAssets;
    mapping(uint256 => bool) public brokenReserve;

    mapping(uint256 => uint256) public availableLiquidity;
    mapping(uint256 => bool) public liquidityCapSet;
    mapping(uint256 => bool) public brokenLiquidity;

    /// @dev FNA-08: owner (msg.sender) => positionManager => approved.
    mapping(address => mapping(address => bool)) public isPositionManagerFor;

    // ----------------- test helpers -----------------

    function setReserveUnderlying(uint256 reserveId, address underlying) external {
        reserveUnderlying[reserveId] = underlying;
    }

    function setSuppliedAssets(uint256 reserveId, address user, uint256 amount) external {
        suppliedAssets[reserveId][user] = amount;
    }

    /// @dev Makes getUserSuppliedAssets() revert for this reserveId, to test the asset guard's
    ///      per-reserve fault isolation in getBalance().
    function setBrokenReserve(uint256 reserveId, bool broken) external {
        brokenReserve[reserveId] = broken;
    }

    /// @dev Caps this reserve's (Hub-side) available liquidity below its full supplied amount, to
    ///      test the asset guard's FNA-07 liquidity-capped sizing. Pass `type(uint256).max` (or
    ///      never call this) to simulate a fully-liquid reserve.
    function setAvailableLiquidity(uint256 reserveId, uint256 liquidity) external {
        availableLiquidity[reserveId] = liquidity;
        liquidityCapSet[reserveId] = true;
    }

    /// @dev Makes getAssetLiquidity() revert for this reserveId, to test the asset guard's
    ///      fault-isolation on a failed Hub liquidity query.
    function setBrokenLiquidity(uint256 reserveId, bool broken) external {
        brokenLiquidity[reserveId] = broken;
    }

    /// @dev Used by mock Giver/Taker position managers to credit/debit a position.
    function adjustSupplied(
        uint256 reserveId,
        address user,
        bool increase,
        uint256 amount
    ) external {
        if (increase) {
            suppliedAssets[reserveId][user] += amount;
        } else {
            suppliedAssets[reserveId][user] -= amount;
        }
    }

    // ----------------- ISpoke (subset) -----------------

    function getUserSuppliedAssets(
        uint256 reserveId,
        address user
    ) external view returns (uint256) {
        require(!brokenReserve[reserveId], "MockAaveV4Spoke: reserve broken");
        return suppliedAssets[reserveId][user];
    }

    /// @dev FNA-15: mirrors real Aave V4's Spoke.withdraw(reserveId, amount, onBehalfOf) —
    ///      withdrawn funds are sent to msg.sender (the caller), not to `onBehalfOf`, exactly
    ///      like the real contract (and like MockAaveV4TakerPositionManager.withdrawOnBehalfOf,
    ///      which this replaces for the automatic withdrawal path). No allowance/PositionManager
    ///      check here — this mock doesn't enforce Aave's own onlyPositionManager/self-shortcut,
    ///      matching the FNA-08 mock note below.
    function withdraw(
        uint256 reserveId,
        uint256 amount,
        address onBehalfOf
    ) external returns (uint256 withdrawnShares, uint256 withdrawnAmount) {
        suppliedAssets[reserveId][onBehalfOf] -= amount;
        IERC20(reserveUnderlying[reserveId]).transfer(msg.sender, amount);
        withdrawnShares = amount;
        withdrawnAmount = amount;
    }

    /// @dev Real Aave V4 returns a much larger Reserve struct; the guard only reads the first
    ///      32-byte word (`underlying`), so this placeholder second field is enough to validate
    ///      that the raw-staticcall extraction is correct regardless of trailing fields.
    function getReserve(
        uint256 reserveId
    ) external view returns (address underlying, address hub, uint256 assetId) {
        underlying = reserveUnderlying[reserveId];
        hub = address(this);
        assetId = reserveId;
    }

    // ----------------- IHubBase (subset) -----------------

    function getAssetLiquidity(uint256 assetId) external view returns (uint256) {
        require(!brokenLiquidity[assetId], "MockAaveV4Spoke: liquidity broken");
        if (!liquidityCapSet[assetId]) return type(uint256).max;
        return availableLiquidity[assetId];
    }

    /// @dev FNA-08: mirrors real Aave V4's setUserPositionManager(address,bool) — the owner
    ///      (msg.sender) grants/revokes approval for `positionManager` to act on their own
    ///      position. Records only; nothing in this mock currently enforces it against
    ///      supplyOnBehalfOf/withdrawOnBehalfOf, since those checks live in real Aave V4, not in
    ///      this repository's contracts — see AaveV4SpokeAssetGuard.txGuard for the fix this
    ///      supports (authorizing the pool to make this call in the first place).
    function setUserPositionManager(address positionManager, bool approve) external {
        isPositionManagerFor[msg.sender][positionManager] = approve;
    }
}
