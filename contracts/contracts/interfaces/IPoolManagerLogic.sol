// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IPoolManagerLogic
interface IPoolManagerLogic {
    function poolLogic() external view returns (address);

    function isDepositAsset(address asset) external view returns (bool);

    function validateAsset(address asset) external view returns (bool);

    function assetValue(address asset) external view returns (uint256);

    function assetValue(address asset, uint256 amount) external view returns (uint256);

    function assetBalance(address asset) external view returns (uint256 balance);

    function assetDecimal(address _asset) external view returns (uint256);

    function factory() external view returns (address);

    function setPoolLogic(address fundAddress) external returns (bool);

    function totalFundValue() external view returns (uint256);

    /// @notice Same total as totalFundValue(), plus whether every position was fully valued.
    /// @dev `complete` is false if any IIncompleteValuationGuard-marked guard degraded a
    ///      nonzero-raw-balance position to a lower USD value on a transient external failure
    ///      (see that interface). Used by PoolLogic._accrueYield() to withhold yield/fee
    ///      recognition when the reading can't be trusted, without blocking stake/unstake/
    ///      harvest themselves — see PoolLogic._accrueYield() for why blocking those outright is
    ///      not the chosen tradeoff.
    function totalFundValueWithCompleteness() external view returns (uint256 total, bool complete);

    function isMemberAllowed(address member) external view returns (bool);

    function getFee() external view returns (uint256, uint256, uint256, uint256, uint256);

    function getAssetPrice(address _asset) external view returns (uint256);

    function getAssetType(address _asset) external view returns (uint16);

    function getAssetGuard(address _asset) external view returns (address);

    function getContractGuard(address _contract) external view returns (address);

    function privatePool() external view returns (bool);

    function getAllowedCallbackSenders(address protocol) external view returns (bool);

    /// @notice The factory-level owner — the same actor that already gates
    ///         `_performanceFeeNumeratorChangeDelay` via setFactoryConfig(). PoolLogic reads this
    ///         to gate attesterRotationDelay the same way, so a manager can never shorten the
    ///         detection window around a withdrawal-attester rotation they themselves proposed.
    function factoryOwner() external view returns (address);
}
