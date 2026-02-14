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
/*                       Morpho Reward Claim Contract Guard                    */
/* -------------------------------------------------------------------------- */

/// @title MorphoBlueRewardClaimGuard
/// @notice Guard allowing PoolLogic to claim Morpho rewards (Merkl)
/// @dev
///  - Claim-only guard 
///  - Rewards are transferred directly to PoolLogic
///  - Accounting handled off-cycle by manager
contract MorphoBlueRewardClaimGuard is
    TxDataUtils,
    IGuard,
    ITxTrackingGuard,
    ITransactionTypes
{

    bool public override isTxTrackingGuard = true;


    /*//////////////////////////////////////////////////////////////////////////
                                FUNCTION SELECTOR
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Merkl claim selector
    /// claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)
    bytes4 private constant SEL_CLAIM =
        bytes4(
            keccak256(
                "claim(address[],address[],uint256[],bytes32[][])"
            )
        );

    /*//////////////////////////////////////////////////////////////////////////
                                    EVENTS
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Emitted after a successful reward claim
    event MorphoRewardClaimed(
        address indexed pool,
        address indexed token,
        uint256 amount
    );

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
        IPoolManagerLogic poolManager =
            IPoolManagerLogic(_poolManagerLogic);

        address poolLogic = poolManager.poolLogic();

        // Enforce execution only through PoolLogic
        require(
            msg.sender == poolLogic,
            "MorphoRewardGuard: not pool logic"
        );

        bytes4 method = getMethod(data);
        bytes memory params = getParams(data);

        // Only allow claim()
        require(
            method == SEL_CLAIM,
            "MorphoRewardGuard: invalid method"
        );

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
        require(
            msg.sender == poolLogic,
            "MorphoRewardGuard: not pool logic"
        );

    }


    /*//////////////////////////////////////////////////////////////////////////
                          INTERNAL CLAIM VALIDATION
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev Validate Merkl / URD claim call
    function _handleClaim(
        address poolLogic,
        bytes memory params
    ) internal returns (uint16) {
        (
            address[] memory users,
            address[] memory tokens,
            uint256[] memory amounts,

        ) = abi.decode(
                params,
                (address[], address[], uint256[], bytes32[][])
            );

        // Rewards must be claimed only for the pool itself
        require(users.length == 1, "MorphoRewardGuard: multiple users");
        require(users[0] == poolLogic, "MorphoRewardGuard: user != pool");
        
        emit MorphoRewardClaimed(
            users[0],
            tokens[0],
            amounts[0]
        );
        return uint16(TransactionType.MorphoRewardClaim);
    }
}
