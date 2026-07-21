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
import "../../interfaces/IMorphoVaultV2.sol";
import "../../interfaces/IMorphoVaultV2Manager.sol";

/* -------------------------------------------------------------------------- */
/*                         MorphoVaultV2ContractGuard                          */
/* -------------------------------------------------------------------------- */

/// @title MorphoVaultV2ContractGuard
/// @notice Guard for manager/trader-initiated Morpho Vault V2 operations executed through
///         PoolLogic.execTransaction().
/// @dev Morpho Vault V2 instances are standard ERC-4626 vaults that route deposits across
///      curator-selected adapters (see https://docs.morpho.org/learn/concepts/vault-v2/).
///      Unlike the existing Aave V3 / Morpho Blue integrations, a Vault V2 position carries
///      no debt and therefore no liquidation risk for the pool — this guard has no
///      `afterTxGuard` health-factor-style post-check, because there is no risk metric that
///      a deposit/withdraw/redeem/forceDeallocate call could push below a safe threshold.
///
///      Every operation requires the target vault to be:
///       1) registered as a supported asset on the pool (`isSupportedAsset`), AND
///       2) explicitly whitelisted for this pool in `MorphoVaultV2Manager`.
///      Both checks are required — (1) alone would let the pool manager expose the pool to
///      an arbitrary, unvetted ERC-4626-shaped contract, since `changeAssets()` is callable by
///      the pool manager (or trader). (2) is owned by the protocol owner (intended to be the
///      Timelock), independent of the pool manager, mirroring the two-key model
///      `MorphoBlueManager` already provides for Morpho Blue markets.
///
///      deposit/mint/withdraw/redeem additionally require the vault's own underlying asset
///      (`IERC4626(vault).asset()`) to itself be a supported asset of this pool. The vault
///      being supported says nothing about its underlying being supported too — those are
///      registered independently via `changeAssets()`. Without this check, a manager could
///      register a vault whose underlying was never added to this pool, then convert between
///      vault shares (counted in totalFundValue()) and the raw underlying (uncounted, if never
///      separately added) to produce an artificial swing in reported TVL/share price. Every
///      other guard in this codebase already requires this on both directions (see
///      AaveLendingPoolGuardV3, MorphoBlueContractGuard) — this mirrors that pattern.
///
///      DEPLOYMENT NOTE — onboarding a new vault instance for active manager/trader use is a
///      four-step process, all of which are required before deposit/mint/withdraw/redeem can
///      succeed via execTransaction:
///       1) `Governance.setContractGuard(vaultAddress, address(this))` — registered per vault
///          address, same as Aave/Morpho Blue's contract guards are registered against their
///          singleton pool addresses. Without this step, `PoolTxExecutor` never reaches this
///          guard for that vault: it falls through to the asset guard's `txGuard`, which is
///          intentionally a no-op (see ClosedAssetGuard), so execTransaction simply reverts
///          with `InvalidTransaction` rather than doing anything unsafe.
///       2) `MorphoVaultV2Manager.setPoolVaults(pool, [...])` — the protocol-owner whitelist.
///       3) `PoolManagerLogic.changeAssets()` — registers the vault as a supported asset,
///          running `MorphoVaultV2AssetGuard.addAssetCheck` (which itself re-checks step 2).
///       4) `PoolManagerLogic.changeAssets()` again (or in the same call, alongside step 3) —
///          separately registers the vault's own underlying token (`IERC4626(vault).asset()`)
///          as a supported asset. This is independent of step 3 and easy to miss: registering
///          the vault does not register its underlying, and vice versa. Skipping this step
///          does not block deposits into a *different* already-supported asset, but every
///          deposit/mint/withdraw/redeem call against *this* vault will revert with
///          "MorphoVaultV2Guard: underlying not supported" until it's done.
///      Missing step (1) only blocks manager-initiated active execTransaction calls; it does
///      NOT affect valuation (`getBalance`) or the automatic pro-rata withdrawal path
///      (`withdrawProcessing`), both of which run independently of this contract guard. Step 4
///      only affects this guard's deposit/mint/withdraw/redeem handlers for the same reason.
contract MorphoVaultV2ContractGuard is TxDataUtils, IGuard, ITransactionTypes {
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

    /// @dev forceDeallocate(address adapter, bytes data, uint256 assets, address onBehalf).
    bytes4 private constant SEL_FORCE_DEALLOCATE = IMorphoVaultV2.forceDeallocate.selector;

    /*//////////////////////////////////////////////////////////////////////////
                                  IMMUTABLES
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Protocol-owned allowlist of Morpho Vault V2 instances permitted per pool.
    address public immutable morphoVaultV2Manager;

    /*//////////////////////////////////////////////////////////////////////////
                                    EVENTS
    //////////////////////////////////////////////////////////////////////////*/

    event MorphoVaultV2DepositEvt(
        address indexed pool,
        address indexed vault,
        uint256 assets,
        uint256 time
    );

    event MorphoVaultV2MintEvt(
        address indexed pool,
        address indexed vault,
        uint256 shares,
        uint256 time
    );

    event MorphoVaultV2WithdrawEvt(
        address indexed pool,
        address indexed vault,
        uint256 assets,
        uint256 time
    );

    event MorphoVaultV2RedeemEvt(
        address indexed pool,
        address indexed vault,
        uint256 shares,
        uint256 time
    );

    event MorphoVaultV2ForceDeallocateEvt(
        address indexed pool,
        address indexed vault,
        address indexed adapter,
        uint256 assets,
        uint256 time
    );

    /*//////////////////////////////////////////////////////////////////////////
                                  CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////////*/

    /// @param morphoVaultV2Manager_ Address of the protocol-owned MorphoVaultV2Manager allowlist.
    constructor(address morphoVaultV2Manager_) {
        require(morphoVaultV2Manager_ != address(0), "MorphoVaultV2Guard: manager=0");
        morphoVaultV2Manager = morphoVaultV2Manager_;
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

        require(msg.sender == poolLogic, "MorphoVaultV2Guard: not pool logic");

        // The target vault must be both a registered supported asset of the pool AND
        // explicitly whitelisted by the protocol owner. See contract-level @dev for why
        // both checks are required.
        require(
            IHasSupportedAsset(_poolManagerLogic).isSupportedAsset(to),
            "MorphoVaultV2Guard: vault not enabled"
        );
        require(
            IMorphoVaultV2Manager(morphoVaultV2Manager).isValidPoolVault(poolLogic, to),
            "MorphoVaultV2Guard: vault not whitelisted"
        );

        bytes4 method = getMethod(data);
        bytes memory params = getParams(data);

        if (method == SEL_DEPOSIT) txType = _handleDeposit(poolLogic, to, _poolManagerLogic, params);
        else if (method == SEL_MINT) txType = _handleMint(poolLogic, to, _poolManagerLogic, params);
        else if (method == SEL_WITHDRAW)
            txType = _handleWithdraw(poolLogic, to, _poolManagerLogic, params);
        else if (method == SEL_REDEEM) txType = _handleRedeem(poolLogic, to, _poolManagerLogic, params);
        else if (method == SEL_FORCE_DEALLOCATE)
            txType = _handleForceDeallocate(poolLogic, to, params);
        else txType = uint16(TransactionType.NotUsed);

        // Vault V2 deposits/withdrawals carry no debt and no liquidation risk, so there is
        // intentionally no afterTxGuard / ITxTrackingGuard implementation here — PoolTxExecutor
        // simply skips the after-tx hook when a guard does not implement isTxTrackingGuard().
        return (txType, false);
    }

    /*//////////////////////////////////////////////////////////////////////////
                     INTERNAL HANDLERS — PER VAULT V2 OPERATION
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev The vault being a supported+whitelisted asset (checked in txGuard) says nothing
    ///      about its *underlying* token: a vault can be registered without its underlying
    ///      ever being added to this pool's own supportedAssets. Since totalFundValue() only
    ///      sums value over supportedAssets, converting between vault shares (counted) and the
    ///      raw underlying (uncounted, if never separately added) would let a manager produce
    ///      an artificial TVL/share-price swing purely by moving value between the two
    ///      representations. Every sibling guard in this codebase already requires
    ///      isSupportedAsset() on the underlying token for both directions (see
    ///      AaveLendingPoolGuardV3._deposit/._withdraw, MorphoBlueContractGuard._handleSupply/
    ///      ._handleWithdraw) — this check restores that same protection here.
    function _requireUnderlyingSupported(address poolManagerLogic, address vault) internal view {
        require(
            IHasSupportedAsset(poolManagerLogic).isSupportedAsset(IERC4626(vault).asset()),
            "MorphoVaultV2Guard: underlying not supported"
        );
    }

    /// @dev deposit(uint256 assets, address receiver) — receiver must be the pool itself so
    ///      the minted shares can never be redirected to an arbitrary address.
    function _handleDeposit(
        address poolLogic,
        address vault,
        address poolManagerLogic,
        bytes memory params
    ) internal returns (uint16) {
        (uint256 assets, address receiver) = abi.decode(params, (uint256, address));
        require(receiver == poolLogic, "MorphoVaultV2Guard: receiver != pool");
        _requireUnderlyingSupported(poolManagerLogic, vault);

        emit MorphoVaultV2DepositEvt(poolLogic, vault, assets, block.timestamp);
        return uint16(TransactionType.MorphoVaultV2Deposit);
    }

    /// @dev mint(uint256 shares, address receiver) — same receiver restriction as deposit.
    function _handleMint(
        address poolLogic,
        address vault,
        address poolManagerLogic,
        bytes memory params
    ) internal returns (uint16) {
        (uint256 shares, address receiver) = abi.decode(params, (uint256, address));
        require(receiver == poolLogic, "MorphoVaultV2Guard: receiver != pool");
        _requireUnderlyingSupported(poolManagerLogic, vault);

        emit MorphoVaultV2MintEvt(poolLogic, vault, shares, block.timestamp);
        return uint16(TransactionType.MorphoVaultV2Mint);
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
        require(receiver == poolLogic, "MorphoVaultV2Guard: receiver != pool");
        require(owner == poolLogic, "MorphoVaultV2Guard: owner != pool");
        _requireUnderlyingSupported(poolManagerLogic, vault);

        emit MorphoVaultV2WithdrawEvt(poolLogic, vault, assets, block.timestamp);
        return uint16(TransactionType.MorphoVaultV2Withdraw);
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
        require(receiver == poolLogic, "MorphoVaultV2Guard: receiver != pool");
        require(owner == poolLogic, "MorphoVaultV2Guard: owner != pool");
        _requireUnderlyingSupported(poolManagerLogic, vault);

        emit MorphoVaultV2RedeemEvt(poolLogic, vault, shares, block.timestamp);
        return uint16(TransactionType.MorphoVaultV2Redeem);
    }

    /// @dev forceDeallocate(address adapter, bytes data, uint256 assets, address onBehalf) —
    ///      permissionless on the vault itself, so the only protocol-side restrictions are:
    ///      the deallocated position must belong to the pool, and the adapter must actually
    ///      be registered on the target vault (defense in depth; the vault would reject an
    ///      unregistered adapter on its own, but checking here keeps the failure local and
    ///      explicit rather than relying solely on the external call reverting).
    function _handleForceDeallocate(
        address poolLogic,
        address vault,
        bytes memory params
    ) internal returns (uint16) {
        (address adapter, , uint256 assets, address onBehalf) = abi.decode(
            params,
            (address, bytes, uint256, address)
        );
        require(onBehalf == poolLogic, "MorphoVaultV2Guard: onBehalf != pool");
        require(
            IMorphoVaultV2(vault).isAdapter(adapter),
            "MorphoVaultV2Guard: adapter not registered"
        );

        emit MorphoVaultV2ForceDeallocateEvt(poolLogic, vault, adapter, assets, block.timestamp);
        return uint16(TransactionType.MorphoVaultV2ForceDeallocate);
    }
}
