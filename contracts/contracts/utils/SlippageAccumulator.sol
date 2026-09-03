// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { IERC20Extended } from "../interfaces/IERC20Extended.sol";
import { IHasAssetInfo } from "../interfaces/IHasAssetInfo.sol";
import { IHasGuardInfo } from "../interfaces/IHasGuardInfo.sol";
import { IHasSupportedAsset } from "../interfaces/IHasSupportedAsset.sol";

/// @title Frgmnt Slippage Accumulator
/// @notice Contract to check for accumulated slippage impact for a pool manager.
/// @dev Upgraded from 0.7.6 to ^0.8.24:
///      - SafeMath removed in favor of native checked arithmetic.
///      - Ownable base constructor is called explicitly (OZ v5 style).
///      All function signatures, events, and storage variables are preserved.
/// @custom:project Frgmnt
contract SlippageAccumulator is Ownable {
    using SafeCast for uint256;

    /// @dev Struct for passing swap related data to the slippage accumulator function.
    /// @param srcAsset Source asset (asset to be exchanged).
    /// @param dstAsset Destination asset (asset being exchanged for).
    /// @param srcAmount Source asset amount.
    /// @param dstAmount Destination asset amount.
    struct SwapData {
        address srcAsset;
        address dstAsset;
        uint256 srcAmount;
        uint256 dstAmount;
    }

    /// @dev Struct to track the slippage data for a poolManager.
    /// @param lastTradeTimestamp Last successful trade's timestamp.
    /// @param accumulatedSlippage The accumulated slippage impact of a poolManager.
    struct ManagerSlippageData {
        uint64 lastTradeTimestamp;
        uint128 accumulatedSlippage;
    }

    event DecayTimeChanged(uint64 oldDecayTime, uint64 newDecayTime);
    event MaxCumulativeSlippageChanged(
        uint128 oldMaxCumulativeSlippage,
        uint128 newMaxCumulativeSlippage
    );

    /// @dev Constant used to multiply the slippage loss percentage with 4 decimal precision.
    /// @dev Example: 1% loss represented after scaling as (1e4 / 1e6) in relative terms.
    uint128 private constant SCALING_FACTOR = 1e6;

    /// @dev dHEDGE / Frgmnt poolFactory address.
    address private immutable poolFactory;

    /// @notice Maximum acceptable cumulative trade slippage impact within a period of time (upto 4 decimal precision).
    /// @dev Eg. 5% = 5e4
    uint128 public maxCumulativeSlippage;

    /// @notice Price accumulator decay time.
    /// @dev Eg 6 hours = 21600.
    uint64 public decayTime;

    /// @notice Tracks the last trade timestamp and accumulated slippage for each poolManager.
    mapping(address => ManagerSlippageData) public managerData;

    /// @dev Modifier to make sure caller is a contract guard.
    /// @param to Router / contract address whose guard must match msg.sender.
    modifier onlyContractGuard(address to) {
        address contractGuard = IHasGuardInfo(poolFactory).getContractGuard(to);
        require(contractGuard == msg.sender, "Not authorised guard");
        _;
    }

    /// @notice Contract constructor.
    /// @param _poolFactory Address of the poolFactory (cannot be zero).
    /// @param _decayTime Decay time used to gradually reduce accumulated slippage impact.
    /// @param _maxCumulativeSlippage Maximum allowed cumulative slippage.
    constructor(
        address _poolFactory,
        uint64 _decayTime,
        uint128 _maxCumulativeSlippage
    )
        Ownable(msg.sender) // Explicitly set the initial owner (OZ v5 Ownable)
    {
        require(_poolFactory != address(0), "Null address");

        poolFactory = _poolFactory;
        decayTime = _decayTime;
        maxCumulativeSlippage = _maxCumulativeSlippage;
    }

    /// @notice Updates the cumulative slippage impact and reverts if it's beyond limit.
    /// @dev NOTE: It's important that the calling guard checks if the msg.sender in its scope is authorised.
    ///      If the caller is not checked for in the guard, anyone can trigger the `txGuard` transaction and update slippage impact.
    /// @param poolManagerLogic Address of the poolManager whose cumulative impact is stored.
    /// @param router Address of the router contract used for swapping.
    /// @param swapData Common swap data for all guards.
    function updateSlippageImpact(
        address poolManagerLogic,
        address router,
        SwapData calldata swapData
    ) external onlyContractGuard(router) {
        // Only process slippage for supported source assets.
        if (IHasSupportedAsset(poolManagerLogic).isSupportedAsset(swapData.srcAsset)) {
            uint256 srcValue = assetValue(swapData.srcAsset, swapData.srcAmount);
            uint256 dstValue = assetValue(swapData.dstAsset, swapData.dstAmount);

            // Only update the cumulative slippage in case the amount received is lesser than amount sent/traded.
            if (dstValue < srcValue) {
                // newSlippage = (srcValue - dstValue) / srcValue * SCALING_FACTOR
                uint256 diff = srcValue - dstValue;
                uint256 newSlippage256 = (diff * SCALING_FACTOR) / srcValue;
                uint128 newSlippage = newSlippage256.toUint128();

                // Combine the new slippage with the decayed historical slippage.
                uint128 currentCumulative = getCumulativeSlippageImpact(poolManagerLogic);
                uint256 newCumulative256 = uint256(currentCumulative) + uint256(newSlippage);
                uint128 newCumulativeSlippage = newCumulative256.toUint128();

                require(newCumulativeSlippage < maxCumulativeSlippage, "slippage impact exceeded");

                // Update the last traded timestamp.
                managerData[poolManagerLogic].lastTradeTimestamp = uint256(block.timestamp)
                    .toUint64();

                // Update the accumulated slippage impact for the poolManager.
                managerData[poolManagerLogic].accumulatedSlippage = newCumulativeSlippage;
            }
        }
    }

    /// @notice Function to calculate an asset amount's value in usd.
    /// @param asset The asset whose price oracle exists.
    /// @param amount The amount of the `asset`.
    /// @dev CertiK FNA-45 follow-up: this function previously mirrored PoolManagerLogic.
    ///      assetValue()'s IPreValuedAssetGuard short-circuit — but that shortcut's input is an
    ///      aggregate USD-18 guard *balance*, already fully priced; this function's input is a
    ///      raw *token amount delta* from a swap. Returning that delta as-is silently assumed
    ///      both 18 decimals and a unit price of exactly $1, which for a real transferable
    ///      pre-valued share (Morpho Vault V2 / Aave V4 Tokenization) worth more or less than $1
    ///      per share mispriced the swap even at 18 decimals — and for a hypothetical 6-decimal
    ///      share, additionally introduced a 1e12 scaling error. Removed: `getAssetPrice()` below
    ///      now correctly returns a real per-unit price for such a share (see
    ///      IPreValuedAssetGuard.getUnitPrice(), which PoolManagerLogic.getAssetPrice() dispatches
    ///      to), so pricing this asset the same way as any other now produces the right answer
    ///      instead of reintroducing the identity-price bug this shortcut was meant to avoid.
    function assetValue(address asset, uint256 amount) public view returns (uint256 value) {
        if (amount == 0) return 0;

        uint256 price = IHasAssetInfo(poolFactory).getAssetPrice(asset);
        uint8 decimals = IERC20Extended(asset).decimals();

        // value = amount * price / 10^decimals (to USD amount)
        value = (amount * price) / (10 ** uint256(decimals));
    }

    /// @notice Function to get the cumulative slippage adjusted using decayTime (current cumulative slippage impact).
    /// @param poolManagerLogic Address of the poolManager whose cumulative impact is stored.
    function getCumulativeSlippageImpact(
        address poolManagerLogic
    ) public view returns (uint128 cumulativeSlippage) {
        ManagerSlippageData memory managerSlippageData = managerData[poolManagerLogic];

        // If nothing has ever accumulated, short-circuit to zero.
        if (managerSlippageData.accumulatedSlippage == 0) {
            return 0;
        }

        // Time passed since the last trade.
        uint256 timeSinceLastTrade =
            block.timestamp - uint256(managerSlippageData.lastTradeTimestamp);

        // Clamp the elapsed time to [0, decayTime].
        uint256 elapsed = Math.min(uint256(decayTime), timeSinceLastTrade);

        // Effective time used for weighting the remaining slippage.
        uint256 effectiveTime = uint256(decayTime) - elapsed;

        // cumulative = accumulatedSlippage * effectiveTime / decayTime
        uint256 adjusted =
            (uint256(managerSlippageData.accumulatedSlippage) * effectiveTime) / uint256(decayTime);

        return adjusted.toUint128();
    }

    /**********************************************
     *             Owner Functions                *
     *********************************************/

    /// @notice Function to change decay time for calculating price impact.
    /// @param newDecayTime The new decay time (in seconds).
    function setDecayTime(uint64 newDecayTime) external onlyOwner {
        uint64 oldDecayTime = decayTime;

        decayTime = newDecayTime;

        emit DecayTimeChanged(oldDecayTime, newDecayTime);
    }

    /// @notice Function to change the max acceptable cumulative slippage impact.
    /// @param newMaxCumulativeSlippage The new max acceptable cumulative slippage impact.
    function setMaxCumulativeSlippage(uint128 newMaxCumulativeSlippage) external onlyOwner {
        uint128 oldMaxCumulativeSlippage = maxCumulativeSlippage;

        maxCumulativeSlippage = newMaxCumulativeSlippage;

        emit MaxCumulativeSlippageChanged(oldMaxCumulativeSlippage, newMaxCumulativeSlippage);
    }
}
