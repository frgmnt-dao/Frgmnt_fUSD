// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/* -------------------------------------------------------------------------- */
/*                                   Imports                                  */
/* -------------------------------------------------------------------------- */

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import "../../utils/TxDataUtils.sol";
import "../../interfaces/guards/IGuard.sol";
import "../../interfaces/ITransactionTypes.sol";
import "../../interfaces/IPoolManagerLogic.sol";
import "../../interfaces/IHasSupportedAsset.sol";
import "../../interfaces/IAaveV4TokenizationManager.sol";

/* -------------------------------------------------------------------------- */
/*                      AaveV4TokenizationContractGuard                        */
/* -------------------------------------------------------------------------- */

/// @title AaveV4TokenizationContractGuard
/// @notice Guard for manager/trader-initiated Aave V4 TokenizationSpoke operations executed
///         through PoolLogic.execTransaction().
/// @dev An Aave V4 TokenizationSpoke is a standard ERC-4626 vault wrapping a single Hub asset —
///      structurally identical to a Morpho Vault V2 instance, so this guard mirrors
///      MorphoVaultV2ContractGuard closely. It deposits/withdraws directly against the Liquidity
///      Hub (bypassing the main lending Spoke entirely), so — like Morpho Vault V2 — there is no
///      debt, no liquidation risk, and therefore no afterTxGuard / ITxTrackingGuard
///      implementation here.
///
///      Every operation requires the target vault to be:
///       1) registered as a supported asset on the pool (`isSupportedAsset`), AND
///       2) explicitly whitelisted for this pool in `AaveV4TokenizationManager`.
///      Both checks are required — (1) alone would let the pool manager expose the pool to an
///      arbitrary, unvetted ERC-4626-shaped contract, since `changeAssets()` is callable by the
///      pool manager (or trader). (2) is owned by the protocol owner (intended to be the
///      Timelock), independent of the pool manager.
contract AaveV4TokenizationContractGuard is TxDataUtils, IGuard, ITransactionTypes {
    /*//////////////////////////////////////////////////////////////////////////
                                FUNCTION SELECTORS
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev deposit(uint256 assets, address receiver) — identical selector to ERC-4626.
    bytes4 private constant SEL_DEPOSIT = IERC4626.deposit.selector;

    /// @dev mint(uint256 shares, address receiver) — identical selector to ERC-4626.
    bytes4 private constant SEL_MINT = IERC4626.mint.selector;

    /// @dev withdraw(uint256 assets, address receiver, address owner) — identical selector to ERC-4626.
    bytes4 private constant SEL_WITHDRAW = IERC4626.withdraw.selector;

    /// @dev redeem(uint256 shares, address receiver, address owner) — identical selector to ERC-4626.
    bytes4 private constant SEL_REDEEM = IERC4626.redeem.selector;

    /*//////////////////////////////////////////////////////////////////////////
                                  IMMUTABLES
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Protocol-owned allowlist of Aave V4 TokenizationSpoke instances permitted per pool.
    address public immutable aaveV4TokenizationManager;

    /*//////////////////////////////////////////////////////////////////////////
                                    EVENTS
    //////////////////////////////////////////////////////////////////////////*/

    event AaveV4TokenizationDepositEvt(
        address indexed pool,
        address indexed vault,
        uint256 assets,
        uint256 time
    );

    event AaveV4TokenizationMintEvt(
        address indexed pool,
        address indexed vault,
        uint256 shares,
        uint256 time
    );

    event AaveV4TokenizationWithdrawEvt(
        address indexed pool,
        address indexed vault,
        uint256 assets,
        uint256 time
    );

    event AaveV4TokenizationRedeemEvt(
        address indexed pool,
        address indexed vault,
        uint256 shares,
        uint256 time
    );

    /*//////////////////////////////////////////////////////////////////////////
                                  CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////////*/

    /// @param aaveV4TokenizationManager_ Address of the protocol-owned AaveV4TokenizationManager.
    constructor(address aaveV4TokenizationManager_) {
        require(aaveV4TokenizationManager_ != address(0), "AaveV4TokenizationGuard: manager=0");
        aaveV4TokenizationManager = aaveV4TokenizationManager_;
    }

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

        require(msg.sender == poolLogic, "AaveV4TokenizationGuard: not pool logic");

        require(
            IHasSupportedAsset(_poolManagerLogic).isSupportedAsset(to),
            "AaveV4TokenizationGuard: vault not enabled"
        );
        require(
            IAaveV4TokenizationManager(aaveV4TokenizationManager).isValidPoolVault(poolLogic, to),
            "AaveV4TokenizationGuard: vault not whitelisted"
        );

        bytes4 method = getMethod(data);
        bytes memory params = getParams(data);

        if (method == SEL_DEPOSIT) txType = _handleDeposit(poolLogic, to, params);
        else if (method == SEL_MINT) txType = _handleMint(poolLogic, to, params);
        else if (method == SEL_WITHDRAW) txType = _handleWithdraw(poolLogic, to, params);
        else if (method == SEL_REDEEM) txType = _handleRedeem(poolLogic, to, params);
        else txType = uint16(TransactionType.NotUsed);

        return (txType, false);
    }

    /*//////////////////////////////////////////////////////////////////////////
                     INTERNAL HANDLERS — PER OPERATION
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev deposit(uint256 assets, address receiver) — receiver must be the pool itself so
    ///      the minted shares can never be redirected to an arbitrary address.
    function _handleDeposit(
        address poolLogic,
        address vault,
        bytes memory params
    ) internal returns (uint16) {
        (uint256 assets, address receiver) = abi.decode(params, (uint256, address));
        require(receiver == poolLogic, "AaveV4TokenizationGuard: receiver != pool");

        emit AaveV4TokenizationDepositEvt(poolLogic, vault, assets, block.timestamp);
        return uint16(TransactionType.AaveV4TokenizationDeposit);
    }

    /// @dev mint(uint256 shares, address receiver) — same receiver restriction as deposit.
    function _handleMint(
        address poolLogic,
        address vault,
        bytes memory params
    ) internal returns (uint16) {
        (uint256 shares, address receiver) = abi.decode(params, (uint256, address));
        require(receiver == poolLogic, "AaveV4TokenizationGuard: receiver != pool");

        emit AaveV4TokenizationMintEvt(poolLogic, vault, shares, block.timestamp);
        return uint16(TransactionType.AaveV4TokenizationMint);
    }

    /// @dev withdraw(uint256 assets, address receiver, address owner) — both the position
    ///      owner and the asset recipient must be the pool itself.
    function _handleWithdraw(
        address poolLogic,
        address vault,
        bytes memory params
    ) internal returns (uint16) {
        (uint256 assets, address receiver, address owner) = abi.decode(
            params,
            (uint256, address, address)
        );
        require(receiver == poolLogic, "AaveV4TokenizationGuard: receiver != pool");
        require(owner == poolLogic, "AaveV4TokenizationGuard: owner != pool");

        emit AaveV4TokenizationWithdrawEvt(poolLogic, vault, assets, block.timestamp);
        return uint16(TransactionType.AaveV4TokenizationWithdraw);
    }

    /// @dev redeem(uint256 shares, address receiver, address owner) — same restriction as withdraw.
    function _handleRedeem(
        address poolLogic,
        address vault,
        bytes memory params
    ) internal returns (uint16) {
        (uint256 shares, address receiver, address owner) = abi.decode(
            params,
            (uint256, address, address)
        );
        require(receiver == poolLogic, "AaveV4TokenizationGuard: receiver != pool");
        require(owner == poolLogic, "AaveV4TokenizationGuard: owner != pool");

        emit AaveV4TokenizationRedeemEvt(poolLogic, vault, shares, block.timestamp);
        return uint16(TransactionType.AaveV4TokenizationRedeem);
    }
}
