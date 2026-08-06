// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/* -------------------------------------------------------------------------- */
/*                                   Imports                                  */
/* -------------------------------------------------------------------------- */

import { IGiverPositionManager } from "../../interfaces/aave/v4/IGiverPositionManager.sol";
import { ITakerPositionManager } from "../../interfaces/aave/v4/ITakerPositionManager.sol";

import "../../utils/TxDataUtils.sol";
import "../../interfaces/guards/IGuard.sol";
import "../../interfaces/ITransactionTypes.sol";
import "../../interfaces/IPoolManagerLogic.sol";
import "../../interfaces/IHasSupportedAsset.sol";
import "../../interfaces/IAaveV4SpokeManager.sol";

/* -------------------------------------------------------------------------- */
/*                         AaveV4SpokeContractGuard                            */
/* -------------------------------------------------------------------------- */

/// @title AaveV4SpokeContractGuard
/// @notice Guard for manager/trader-initiated Aave V4 Spoke supply/withdraw operations executed
///         through PoolLogic.execTransaction().
/// @dev IMPORTANT — this single guard instance must be registered in Governance against BOTH
///      `GiverPositionManager` and `TakerPositionManager`, NOT against any Spoke address. Both
///      are singleton contracts shared across every Spoke and every reserve on Aave V4 — unlike
///      Aave V3's per-deployment Pool or Morpho Blue's single core contract, there is still only
///      one of each PositionManager, but the Spoke being acted on is passed as a *parameter* of
///      the call (`to` is always the PositionManager, never the Spoke).
///
///      This integration deliberately supports supply-only (no borrowing). `borrowOnBehalfOf`,
///      `approveBorrow`, and any debt-repayment selectors are simply not handled here — they
///      fall through to `txType = NotUsed`, causing PoolTxExecutor to revert. This enforces the
///      "no borrowing on Aave V4" decision at the guard level, not by convention.
///
///      CRITICAL SECURITY PROPERTY: Aave V4's `withdrawOnBehalfOf` sends withdrawn funds to
///      `msg.sender` (the caller), NOT to `onBehalfOf` — `onBehalfOf` only identifies whose
///      position is debited. Withdrawing requires a prior `approveWithdraw(spoke, reserveId,
///      spender, amount)` granting `spender` an allowance. If this guard ever allowed `spender`
///      to be anything other than the pool itself, that `spender` could later call
///      `withdrawOnBehalfOf` directly (bypassing this guard entirely) and receive the pool's
///      funds. `_handleApproveWithdraw` below enforces `spender == pool` unconditionally — this
///      is the single most important check in this contract.
///
///      Every operation also requires the target Spoke to be registered as a supported asset on
///      the pool (`isSupportedAsset`) — otherwise the pool manager could expose the pool to an
///      arbitrary, unvetted Spoke address via `changeAssets()`. Beyond that, the reserveId check
///      differs by direction (FNA-10):
///       - Supply (`_handleSupply`) requires the reserveId to be in the protocol owner's ACTIVE
///         allowlist (`isValidPoolReserve`) — new exposure may only go into reserves currently
///         sanctioned by governance.
///       - Withdraw-side operations (`_handleApproveWithdraw`, `_handleWithdraw`) require only
///         that the reserveId be TRACKED (`isTrackedPoolReserve`), a superset that also includes
///         reserves the protocol owner has since delisted. Gating these on the active allowlist
///         instead — as a single shared check once did — would mean a delisted reserve could
///         never be unwound through this manual execTransaction path either, contradicting
///         AaveV4SpokeAssetGuard's own automatic withdrawProcessing() (which already iterates
///         the tracked set, not the active one) and leaving the position stuck until governance
///         re-adds the reserve. See AaveV4SpokeManager's contract-level documentation for why
///         tracked/active are governed by two separate mappings.
///
///      FNA-19: this guard deliberately does NOT handle Aave V4's Merkl/Points incentive claims
///      (`useClaimRewards`-style calls) — those settle through Merkl's own Distributor contract,
///      a separate target with its own generic `claim()` interface shared across every
///      Merkl-integrated protocol (Morpho Blue, Aave V4 Spoke, etc.), not a Spoke or
///      PositionManager method. See `MerklRewardClaimGuard`, registered separately in Governance
///      against Merkl's Distributor address, for that path.
contract AaveV4SpokeContractGuard is TxDataUtils, IGuard, ITransactionTypes {
    /*//////////////////////////////////////////////////////////////////////////
                                FUNCTION SELECTORS
    //////////////////////////////////////////////////////////////////////////*/

    bytes4 private constant SEL_SUPPLY = IGiverPositionManager.supplyOnBehalfOf.selector;
    bytes4 private constant SEL_APPROVE_WITHDRAW = ITakerPositionManager.approveWithdraw.selector;
    bytes4 private constant SEL_WITHDRAW = ITakerPositionManager.withdrawOnBehalfOf.selector;

    /*//////////////////////////////////////////////////////////////////////////
                                  IMMUTABLES
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Protocol-owned allowlist of Aave V4 Spoke reserves permitted per pool.
    address public immutable aaveV4SpokeManager;

    /*//////////////////////////////////////////////////////////////////////////
                                    EVENTS
    //////////////////////////////////////////////////////////////////////////*/

    event AaveV4SpokeSupplyEvt(
        address indexed pool,
        address indexed spoke,
        uint256 indexed reserveId,
        uint256 amount,
        uint256 time
    );

    event AaveV4SpokeApproveWithdrawEvt(
        address indexed pool,
        address indexed spoke,
        uint256 indexed reserveId,
        uint256 amount,
        uint256 time
    );

    event AaveV4SpokeWithdrawEvt(
        address indexed pool,
        address indexed spoke,
        uint256 indexed reserveId,
        uint256 amount,
        uint256 time
    );

    /*//////////////////////////////////////////////////////////////////////////
                                  CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////////*/

    /// @param aaveV4SpokeManager_ Address of the protocol-owned AaveV4SpokeManager allowlist.
    constructor(address aaveV4SpokeManager_) {
        require(aaveV4SpokeManager_ != address(0), "AaveV4SpokeGuard: manager=0");
        aaveV4SpokeManager = aaveV4SpokeManager_;
    }

    /*//////////////////////////////////////////////////////////////////////////
                                   TX GUARD
    //////////////////////////////////////////////////////////////////////////*/

    /// @inheritdoc IGuard
    /// @dev `to` is always GiverPositionManager or TakerPositionManager here, never a Spoke —
    ///      see the contract-level documentation above. The Spoke being acted on is decoded
    ///      from the calldata.
    function txGuard(
        address _poolManagerLogic,
        address /* to */,
        bytes calldata data
    ) external override returns (uint16 txType, bool isPublic) {
        IPoolManagerLogic poolManager = IPoolManagerLogic(_poolManagerLogic);
        address poolLogic = poolManager.poolLogic();

        require(msg.sender == poolLogic, "AaveV4SpokeGuard: not pool logic");

        bytes4 method = getMethod(data);
        bytes memory params = getParams(data);

        if (method == SEL_SUPPLY) txType = _handleSupply(_poolManagerLogic, poolLogic, params);
        else if (method == SEL_APPROVE_WITHDRAW)
            txType = _handleApproveWithdraw(_poolManagerLogic, poolLogic, params);
        else if (method == SEL_WITHDRAW)
            txType = _handleWithdraw(_poolManagerLogic, poolLogic, params);
        else txType = uint16(TransactionType.NotUsed);

        // Supply-only, no debt: no afterTxGuard / ITxTrackingGuard implementation needed —
        // PoolTxExecutor simply skips the after-tx hook when a guard does not implement
        // isTxTrackingGuard().
        return (txType, false);
    }

    /*//////////////////////////////////////////////////////////////////////////
                     INTERNAL HANDLERS — PER OPERATION
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev supplyOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
    function _handleSupply(
        address poolManagerLogic,
        address poolLogic,
        bytes memory params
    ) internal returns (uint16) {
        (address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) = abi.decode(
            params,
            (address, uint256, uint256, address)
        );

        _requireActiveReserve(poolManagerLogic, poolLogic, spoke, reserveId);
        require(onBehalfOf == poolLogic, "AaveV4SpokeGuard: onBehalfOf != pool");

        emit AaveV4SpokeSupplyEvt(poolLogic, spoke, reserveId, amount, block.timestamp);
        return uint16(TransactionType.AaveV4SpokeSupply);
    }

    /// @dev approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount)
    ///      CRITICAL: spender must always equal the pool — see the contract-level documentation
    ///      above.
    function _handleApproveWithdraw(
        address poolManagerLogic,
        address poolLogic,
        bytes memory params
    ) internal returns (uint16) {
        (address spoke, uint256 reserveId, address spender, uint256 amount) = abi.decode(
            params,
            (address, uint256, address, uint256)
        );

        _requireTrackedReserve(poolManagerLogic, poolLogic, spoke, reserveId);
        require(spender == poolLogic, "AaveV4SpokeGuard: spender != pool");

        emit AaveV4SpokeApproveWithdrawEvt(poolLogic, spoke, reserveId, amount, block.timestamp);
        return uint16(TransactionType.AaveV4SpokeApproveWithdraw);
    }

    /// @dev withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
    function _handleWithdraw(
        address poolManagerLogic,
        address poolLogic,
        bytes memory params
    ) internal returns (uint16) {
        (address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) = abi.decode(
            params,
            (address, uint256, uint256, address)
        );

        _requireTrackedReserve(poolManagerLogic, poolLogic, spoke, reserveId);
        require(onBehalfOf == poolLogic, "AaveV4SpokeGuard: onBehalfOf != pool");

        emit AaveV4SpokeWithdrawEvt(poolLogic, spoke, reserveId, amount, block.timestamp);
        return uint16(TransactionType.AaveV4SpokeWithdraw);
    }

    /// @dev Supply-side validation: the Spoke must be a registered supported asset of the pool
    ///      AND the specific reserveId must be in the protocol owner's ACTIVE allowlist. See the
    ///      contract-level documentation above for why supply uses the active (not tracked) set.
    function _requireActiveReserve(
        address poolManagerLogic,
        address poolLogic,
        address spoke,
        uint256 reserveId
    ) internal view {
        require(
            IHasSupportedAsset(poolManagerLogic).isSupportedAsset(spoke),
            "AaveV4SpokeGuard: spoke not enabled"
        );
        require(
            IAaveV4SpokeManager(aaveV4SpokeManager).isValidPoolReserve(poolLogic, spoke, reserveId),
            "AaveV4SpokeGuard: reserve not whitelisted"
        );
    }

    /// @dev Withdraw-side validation (FNA-10): the Spoke must still be a registered supported
    ///      asset of the pool, but the reserveId only needs to be TRACKED, not actively
    ///      whitelisted — see the contract-level documentation above for why a delisted reserve
    ///      must still be withdrawable through this manual path.
    function _requireTrackedReserve(
        address poolManagerLogic,
        address poolLogic,
        address spoke,
        uint256 reserveId
    ) internal view {
        require(
            IHasSupportedAsset(poolManagerLogic).isSupportedAsset(spoke),
            "AaveV4SpokeGuard: spoke not enabled"
        );
        require(
            IAaveV4SpokeManager(aaveV4SpokeManager).isTrackedPoolReserve(poolLogic, spoke, reserveId),
            "AaveV4SpokeGuard: reserve not tracked"
        );
    }
}
