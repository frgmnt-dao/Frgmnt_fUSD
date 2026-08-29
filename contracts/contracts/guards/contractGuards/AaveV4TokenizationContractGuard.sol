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
///      Every operation requires the target vault to be registered as a supported asset on the
///      pool (`isSupportedAsset`) — otherwise the pool manager could expose the pool to an
///      arbitrary, unvetted ERC-4626-shaped contract via `changeAssets()`. Beyond that, the
///      `AaveV4TokenizationManager` allowlist check differs by direction (FNA-51):
///       - Deposit/mint (`_handleDeposit`, `_handleMint`) require the vault to be in the
///         protocol owner's ACTIVE allowlist (`isValidPoolVault`) — new exposure may only go
///         into vaults currently sanctioned by governance.
///       - Withdraw/redeem (`_handleWithdraw`, `_handleRedeem`) require only that the vault be
///         TRACKED (`isTrackedPoolVault`), a superset that also includes vaults the protocol
///         owner has since delisted. Gating these on the active allowlist instead — as a single
///         shared check once did — would mean a delisted vault could never be unwound through
///         this manual execTransaction path either, contradicting
///         AaveV4TokenizationAssetGuard's own automatic withdrawProcessing() (which never
///         consults either allowlist) and leaving the position stuck until governance re-adds
///         the vault. See AaveV4TokenizationManager's contract-level documentation for why
///         tracked/active are governed by two separate mappings.
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

        // FNA-51: the allowlist check (active vs. tracked) now differs by direction, so it
        // moved into each handler below instead of running unconditionally here — see the
        // contract-level @dev for why.
        bytes4 method = getMethod(data);
        bytes memory params = getParams(data);

        if (method == SEL_DEPOSIT) txType = _handleDeposit(poolLogic, to, _poolManagerLogic, params);
        else if (method == SEL_MINT) txType = _handleMint(poolLogic, to, _poolManagerLogic, params);
        else if (method == SEL_WITHDRAW)
            txType = _handleWithdraw(poolLogic, to, _poolManagerLogic, params);
        else if (method == SEL_REDEEM) txType = _handleRedeem(poolLogic, to, _poolManagerLogic, params);
        else txType = uint16(TransactionType.NotUsed);

        return (txType, false);
    }

    /// @dev Entry-side validation (FNA-51): the vault must be a registered supported asset of
    ///      the pool AND actively whitelisted by the protocol owner. See the contract-level
    ///      documentation above for why deposit/mint use the active (not tracked) set.
    function _requireActiveVault(address poolManagerLogic, address poolLogic, address vault) internal view {
        require(
            IHasSupportedAsset(poolManagerLogic).isSupportedAsset(vault),
            "AaveV4TokenizationGuard: vault not enabled"
        );
        require(
            IAaveV4TokenizationManager(aaveV4TokenizationManager).isValidPoolVault(poolLogic, vault),
            "AaveV4TokenizationGuard: vault not whitelisted"
        );
    }

    /// @dev Exit-side validation (FNA-51): the vault must still be a registered supported asset
    ///      of the pool, but only needs to be TRACKED, not actively whitelisted — see the
    ///      contract-level documentation above for why a delisted vault must still be exitable
    ///      through this manual path.
    function _requireTrackedVault(address poolManagerLogic, address poolLogic, address vault) internal view {
        require(
            IHasSupportedAsset(poolManagerLogic).isSupportedAsset(vault),
            "AaveV4TokenizationGuard: vault not enabled"
        );
        require(
            IAaveV4TokenizationManager(aaveV4TokenizationManager).isTrackedPoolVault(poolLogic, vault),
            "AaveV4TokenizationGuard: vault not tracked"
        );
    }

    /*//////////////////////////////////////////////////////////////////////////
                     INTERNAL HANDLERS — PER OPERATION
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev deposit(uint256 assets, address receiver) — receiver must be the pool itself so
    ///      the minted shares can never be redirected to an arbitrary address.
    function _handleDeposit(
        address poolLogic,
        address vault,
        address poolManagerLogic,
        bytes memory params
    ) internal returns (uint16) {
        (uint256 assets, address receiver) = abi.decode(params, (uint256, address));
        _requireActiveVault(poolManagerLogic, poolLogic, vault);
        require(receiver == poolLogic, "AaveV4TokenizationGuard: receiver != pool");

        emit AaveV4TokenizationDepositEvt(poolLogic, vault, assets, block.timestamp);
        return uint16(TransactionType.AaveV4TokenizationDeposit);
    }

    /// @dev mint(uint256 shares, address receiver) — same receiver restriction as deposit.
    function _handleMint(
        address poolLogic,
        address vault,
        address poolManagerLogic,
        bytes memory params
    ) internal returns (uint16) {
        (uint256 shares, address receiver) = abi.decode(params, (uint256, address));
        _requireActiveVault(poolManagerLogic, poolLogic, vault);
        require(receiver == poolLogic, "AaveV4TokenizationGuard: receiver != pool");

        emit AaveV4TokenizationMintEvt(poolLogic, vault, shares, block.timestamp);
        return uint16(TransactionType.AaveV4TokenizationMint);
    }

    /// @dev withdraw(uint256 assets, address receiver, address owner) — both the position
    ///      owner and the asset recipient must be the pool itself.
    function _handleWithdraw(
        address poolLogic,
        address vault,
        address poolManagerLogic,
        bytes memory params
    ) internal returns (uint16) {
        (uint256 assets, address receiver, address owner) = abi.decode(
            params,
            (uint256, address, address)
        );
        _requireTrackedVault(poolManagerLogic, poolLogic, vault);
        require(receiver == poolLogic, "AaveV4TokenizationGuard: receiver != pool");
        require(owner == poolLogic, "AaveV4TokenizationGuard: owner != pool");

        emit AaveV4TokenizationWithdrawEvt(poolLogic, vault, assets, block.timestamp);
        return uint16(TransactionType.AaveV4TokenizationWithdraw);
    }

    /// @dev redeem(uint256 shares, address receiver, address owner) — same restriction as withdraw.
    function _handleRedeem(
        address poolLogic,
        address vault,
        address poolManagerLogic,
        bytes memory params
    ) internal returns (uint16) {
        (uint256 shares, address receiver, address owner) = abi.decode(
            params,
            (uint256, address, address)
        );
        _requireTrackedVault(poolManagerLogic, poolLogic, vault);
        require(receiver == poolLogic, "AaveV4TokenizationGuard: receiver != pool");
        require(owner == poolLogic, "AaveV4TokenizationGuard: owner != pool");

        emit AaveV4TokenizationRedeemEvt(poolLogic, vault, shares, block.timestamp);
        return uint16(TransactionType.AaveV4TokenizationRedeem);
    }
}
