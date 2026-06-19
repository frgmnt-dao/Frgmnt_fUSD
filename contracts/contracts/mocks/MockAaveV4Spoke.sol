// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal configurable mock of an Aave V4 Spoke for guard unit tests.
/// @dev `getReserve` deliberately returns more than just the underlying address (a placeholder
///      second field) to exercise the asset guard's raw-staticcall extraction of only the first
///      32-byte word, mirroring the real Reserve struct's uncertain full layout.
contract MockAaveV4Spoke {
    mapping(uint256 => address) public reserveUnderlying;
    mapping(uint256 => mapping(address => uint256)) public suppliedAssets;
    mapping(uint256 => bool) public brokenReserve;

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

    /// @dev Real Aave V4 returns a much larger Reserve struct; the guard only reads the first
    ///      32-byte word (`underlying`), so this placeholder second field is enough to validate
    ///      that the raw-staticcall extraction is correct regardless of trailing fields.
    function getReserve(
        uint256 reserveId
    ) external view returns (address underlying, uint8 placeholderFlags) {
        underlying = reserveUnderlying[reserveId];
        placeholderFlags = 0;
    }
}
