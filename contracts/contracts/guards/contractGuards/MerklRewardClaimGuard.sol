// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/* -------------------------------------------------------------------------- */
/*                                   Imports                                  */
/* -------------------------------------------------------------------------- */

import "../../utils/TxDataUtils.sol";
import "../../interfaces/guards/IGuard.sol";
import "../../interfaces/guards/ITxTrackingGuard.sol";
import "../../interfaces/ITransactionTypes.sol";
import "../../interfaces/IPoolManagerLogic.sol";

/* -------------------------------------------------------------------------- */
/*                        Merkl Reward Claim Contract Guard                   */
/* -------------------------------------------------------------------------- */

/// @title MerklRewardClaimGuard
/// @notice Guard allowing PoolLogic to claim Merkl-distributed incentive rewards.
/// @dev
///  - Claim-only guard, protocol-agnostic: Merkl's Distributor is shared infrastructure that any
///    integrated protocol's incentive campaigns settle through (Morpho Blue, Aave V4 Spoke, and
///    any future one), all via the same standard `claim()` interface below. This single guard
///    instance is meant to be registered in Governance against Merkl's Distributor address —
///    once registered, it covers every Merkl-sourced reward stream a pool is exposed to, not
///    just one integration's. FNA-19: previously named MorphoBlueRewardClaimGuard, which read as
///    Morpho-specific and left Aave V4 Spoke's Merkl/Points supply incentives unclaimable even
///    though the on-chain claim mechanism this guard already validates is identical.
///  - Rewards are transferred directly to PoolLogic by the Distributor.
///  - A claimed `payoutToken` only counts toward fund NAV once governance separately registers
///    it as a supported asset (`changeAssets()` + the standard `ERC20Guard`) — the same as any
///    other ERC20 balance the pool holds; this guard does not special-case that.
///  - Accounting handled off-cycle by manager.
contract MerklRewardClaimGuard is TxDataUtils, IGuard, ITxTrackingGuard, ITransactionTypes {
    bool public override isTxTrackingGuard = true;

    /*//////////////////////////////////////////////////////////////////////////
                                FUNCTION SELECTOR
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Merkl claim selector
    /// claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)
    bytes4 private constant SEL_CLAIM = bytes4(
        keccak256("claim(address[],address[],uint256[],bytes32[][])")
    );

    /*//////////////////////////////////////////////////////////////////////////
                                    EVENTS
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Emitted after a successful reward claim
    event MerklRewardClaimed(address indexed pool, address indexed token, uint256 amount);

    /*//////////////////////////////////////////////////////////////////////////
                                  CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////////*/

    constructor() {}

    /*//////////////////////////////////////////////////////////////////////////
                                   TX GUARD
    //////////////////////////////////////////////////////////////////////////*/

    /// @inheritdoc IGuard
    function txGuard(
        address _poolManagerLogic,
        address to,
        bytes calldata data
    ) external override returns (uint16 txType, bool isPublic) {
        IPoolManagerLogic poolManager = IPoolManagerLogic(_poolManagerLogic);

        address poolLogic = poolManager.poolLogic();

        // Enforce execution only through PoolLogic
        require(msg.sender == poolLogic, "MerklRewardGuard: not pool logic");

        bytes4 method = getMethod(data);
        bytes memory params = getParams(data);

        // Only allow claim()
        require(method == SEL_CLAIM, "MerklRewardGuard: invalid method");

        txType = _handleClaim(poolLogic, params);

        // Non-public: manager / trader only
        isPublic = false;

        return (txType, isPublic);
    }

    /// @inheritdoc ITxTrackingGuard
    function afterTxGuard(
        address _poolManagerLogic,
        address to,
        bytes calldata
    ) external view override {
        address poolLogic = IPoolManagerLogic(_poolManagerLogic).poolLogic();
        require(msg.sender == poolLogic, "MerklRewardGuard: not pool logic");
    }

    /*//////////////////////////////////////////////////////////////////////////
                          INTERNAL CLAIM VALIDATION
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev Validate Merkl / URD claim call
    function _handleClaim(address poolLogic, bytes memory params) internal returns (uint16) {
        (address[] memory users, address[] memory tokens, uint256[] memory amounts, ) = abi.decode(
            params,
            (address[], address[], uint256[], bytes32[][])
        );

        // Rewards must be claimed only for the pool itself
        require(users.length == 1, "MerklRewardGuard: multiple users");
        require(users[0] == poolLogic, "MerklRewardGuard: user != pool");

        emit MerklRewardClaimed(users[0], tokens[0], amounts[0]);
        return uint16(TransactionType.MerklRewardClaim);
    }
}
