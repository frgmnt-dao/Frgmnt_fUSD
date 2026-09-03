// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import { IMorphoVaultV2Manager } from "../../interfaces/IMorphoVaultV2Manager.sol";
import { IPoolManagerLogic } from "../../interfaces/IPoolManagerLogic.sol";
import { IPoolLogic } from "../../interfaces/IPoolLogic.sol";
import { IHasSupportedAsset } from "../../interfaces/IHasSupportedAsset.sol";
import { IAddAssetCheckGuard } from "../../interfaces/guards/IAddAssetCheckGuard.sol";
import { IPreValuedAssetGuard } from "../../interfaces/guards/IPreValuedAssetGuard.sol";
import { IIncompleteValuationGuard } from "../../interfaces/guards/IIncompleteValuationGuard.sol";
import { IWithdrawableBalanceGuard } from "../../interfaces/guards/IWithdrawableBalanceGuard.sol";
import { ClosedAssetGuard } from "./ClosedAssetGuard.sol";

/*//////////////////////////////////////////////////////////////
                  MORPHO VAULT V2 ASSET GUARD
//////////////////////////////////////////////////////////////*/

/// @title Morpho Vault V2 Asset Guard
/// @notice AssetGuard for Morpho Vault V2 positions (ERC-4626 vaults that route deposits
///         across curator-selected adapters — see https://docs.morpho.org/learn/concepts/vault-v2/).
/// @dev
///  - One guard instance services any number of registered Morpho Vault V2 instances; unlike
///    the Aave V3 / Morpho Blue integrations (which wrap a single singleton protocol contract
///    and need a separate per-pool market allowlist), each Vault V2 instance is itself the
///    registered "supported asset" address, so no per-position bookkeeping is needed here.
///  - The pool's position carries no debt, so unlike AaveLendingPoolAssetGuard /
///    MorphoBlueLendingPoolAssetGuard there is no flashloan-based unwind path and no health
///    factor to protect. Balances are simply `convertToAssets(shares)`.
///  - `getBalance` / `withdrawProcessing` deliberately do NOT consult the
///    MorphoVaultV2Manager whitelist — a vault must remain valuable and exitable even if
///    governance later revokes it from the whitelist; only *new* exposure
///    (MorphoVaultV2ContractGuard, and `addAssetCheck` below) is gated by the whitelist.
///  - CertiK FNA-07 follow-up: `getWithdrawableBalance`/`withdrawProcessing` cap the redeemable
///    share amount by the vault's own **idle** balance (`IERC20(underlying).balanceOf(vault)`)
///    converted to shares — see `_capSharesByIdleLiquidity`'s own documentation for why this is
///    a different, verified-safe mechanism from the one FNA-25 removed.
contract MorphoVaultV2AssetGuard is
    ClosedAssetGuard,
    IAddAssetCheckGuard,
    IPreValuedAssetGuard,
    IIncompleteValuationGuard,
    IWithdrawableBalanceGuard
{
    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ManagerZero();
    error InvalidUnderlying();
    error BadPortion();
    error NotMorphoVaultV2();
    error UnderlyingNotPriced();
    error VaultNotWhitelisted();

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Protocol-owned allowlist of Morpho Vault V2 instances permitted per pool.
    address public immutable morphoVaultV2Manager;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param morphoVaultV2Manager_ Address of the protocol-owned MorphoVaultV2Manager allowlist.
    constructor(address morphoVaultV2Manager_) {
        if (morphoVaultV2Manager_ == address(0)) revert ManagerZero();
        morphoVaultV2Manager = morphoVaultV2Manager_;
    }

    /*//////////////////////////////////////////////////////////////
                      ADD-ASSET REGISTRATION CHECK
    //////////////////////////////////////////////////////////////*/

    /// @notice Required by IAddAssetCheckGuard — signals that PoolManagerLogic._addAsset
    ///         must call `addAssetCheck` before registering an asset of this type.
    function isAddAssetCheckGuard() external pure returns (bool) {
        return true;
    }

    /// @notice Validates a candidate Morpho Vault V2 instance before it can be registered as
    ///         a supported asset of the pool.
    /// @dev Enforces two independent conditions:
    ///       1) The vault has been explicitly whitelisted for this pool by the protocol owner
    ///          in MorphoVaultV2Manager — this is the actual enforcement point that makes the
    ///          whitelist meaningful; without it, a pool manager could register any
    ///          ERC-4626-shaped contract on their own authority.
    ///       2) The vault's underlying asset already has a registered price feed and asset
    ///          guard, so that `getBalance` below can value the position and `assetDecimal`
    ///          calls made elsewhere in the protocol do not unexpectedly revert.
    /// @param poolLogic Address of the pool the asset is being added to.
    /// @param asset Candidate asset being registered; `asset.asset` is the Vault V2 address.
    function addAssetCheck(
        address poolLogic,
        IHasSupportedAsset.Asset calldata asset
    ) external view override {
        address vault = asset.asset;

        if (!IMorphoVaultV2Manager(morphoVaultV2Manager).isValidPoolVault(poolLogic, vault)) {
            revert VaultNotWhitelisted();
        }

        address underlying;
        try IERC4626(vault).asset() returns (address u) {
            underlying = u;
        } catch {
            revert NotMorphoVaultV2();
        }
        if (underlying == address(0)) revert NotMorphoVaultV2();

        // Confirm the vault's own share<->asset conversion is callable before relying on it
        // in getBalance/withdrawProcessing.
        try IERC4626(vault).convertToAssets(0) returns (uint256) {
            // no-op: call succeeding is all that matters here
        } catch {
            revert NotMorphoVaultV2();
        }
        address poolManagerLogic = IPoolLogic(poolLogic).poolManagerLogic();

        // Reverts on its own ("no guard") if the underlying has no registered asset guard,
        // which is exactly the failure mode we want to catch at registration time rather than
        // on every later getBalance() call.
        IPoolManagerLogic(poolManagerLogic).assetDecimal(underlying);

        uint256 price = IPoolManagerLogic(poolManagerLogic).getAssetPrice(underlying);
        if (price == 0) revert UnderlyingNotPriced();
    }

    /*//////////////////////////////////////////////////////////////
                            BALANCE LOGIC
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the pool's USD-denominated value of its Morpho Vault V2 position.
    /// @dev `convertToAssets` on Morpho Vault V2 calls `accrueInterestView()` internally, so
    ///      this always reflects live, up-to-date interest — no staleness handling is needed.
    ///
    ///      Every external call this function makes — into the vault itself (`asset()`,
    ///      `convertToAssets()`) and into the pricing layer (`getAssetPrice()`,
    ///      `assetDecimal()`, which can revert on Chainlink staleness or L2 sequencer downtime,
    ///      not just on a misbehaving vault) — is wrapped in try/catch and degrades to a
    ///      balance of 0 on failure, rather than reverting. This is a deliberate resilience
    ///      choice: `getBalance` is on the hot path of
    ///      `PoolManagerLogic.totalFundValue()`, which is read by `PoolLogic._accrueYield()` on
    ///      every stake/unstake/harvest call and by `_withdrawableFundValue()` on every
    ///      immediate cash withdrawal. If a single misbehaving or paused vault made this
    ///      function revert unconditionally, it would freeze those operations for the *entire*
    ///      pool, not just this asset — and would also block `removeAssetCheck` (which itself
    ///      calls `getBalance`), the only built-in recovery path, permanently bricking the fund.
    ///      Degrading to 0 keeps the rest of the pool operational; the asset can be removed via
    ///      `changeAssets()` once it reads as empty, and re-registered later (re-running
    ///      `addAssetCheck`) if the vault recovers.
    /// @param pool Pool holding the vault shares.
    /// @param asset Address of the Morpho Vault V2 instance.
    /// @return balanceUsd18 USD value of the pool's share balance, 18 decimals.
    function getBalance(
        address pool,
        address asset
    ) public view override returns (uint256 balanceUsd18) {
        (balanceUsd18, ) = _valuePosition(pool, asset);
    }

    /// @dev getBalance()/isValuationComplete() value the pool's full share balance — the
    ///      liquidity-capped counterpart used for immediate-withdrawal sizing is
    ///      getWithdrawableBalance()/_valueWithdrawablePosition() below.
    ///
    ///      FNA-25 history: this guard previously implemented IWithdrawableBalanceGuard capping
    ///      by IERC4626(asset).maxRedeem(pool) (FNA-07's first pass). That was wrong for Morpho
    ///      Vault V2 specifically: canonical Vault V2 implements maxRedeem() as a function that
    ///      unconditionally returns 0, not a genuine liquidity estimate — confirmed directly
    ///      against Morpho's published source (github.com/morpho-org/vault-v2,
    ///      src/VaultV2.sol, as of 2026-09): `function maxRedeem(address) external pure returns
    ///      (uint256) { return 0; }`, no condition. Trusting it as a liquidity oracle made every
    ///      Morpho Vault V2 position read as fully illiquid on every immediate withdrawal,
    ///      unconditionally, silently excluding real, healthy positions from NAV available for
    ///      immediate exit — FNA-25 removed IWithdrawableBalanceGuard entirely rather than trust
    ///      it.
    function _valuePosition(
        address pool,
        address asset
    ) internal view returns (uint256 balanceUsd18, bool complete) {
        return _valueShares(pool, asset, IERC20(asset).balanceOf(pool));
    }

    /// @dev Shared USD-valuation logic for an arbitrary share amount, factored out of
    ///      _valuePosition so isValuationComplete() below can reuse the exact same failure-path
    ///      handling. See _valuePosition's documentation above for why each step degrades rather
    ///      than reverts.
    ///
    ///      getAssetPrice() reaches AssetHandler.getUSDPrice(), which reverts on a stale/missing
    ///      Chainlink feed or a down/just-recovered L2 sequencer — all real, transient operating
    ///      conditions, not configuration bugs (addAssetCheck already validated the underlying
    ///      was priced at registration time). Left unguarded, any one of those conditions would
    ///      revert totalFundValue() (no per-asset try/catch in its loop) and freeze stake/unstake/
    ///      harvest/withdraw for the *entire* pool, not just this asset — and would also revert
    ///      removeAssetCheck() (ClosedAssetGuard, which itself calls getBalance()), bricking the
    ///      only recovery path. Degrading to 0 instead keeps the rest of the pool operational;
    ///      isValuationComplete() lets callers that need to know the reading was trustworthy
    ///      (PoolManagerLogic.totalFundValueWithCompleteness(), removeAssetCheck() below) tell the
    ///      difference between "genuinely empty" and "temporarily unknowable".
    function _valueShares(
        address pool,
        address asset,
        uint256 shares
    ) internal view returns (uint256 balanceUsd18, bool complete) {
        if (shares == 0) return (0, true);

        address underlying;
        try IERC4626(asset).asset() returns (address u) {
            underlying = u;
        } catch {
            return (0, false);
        }
        if (underlying == address(0)) return (0, false);

        uint256 underlyingAmount;
        try IERC4626(asset).convertToAssets(shares) returns (uint256 a) {
            underlyingAmount = a;
        } catch {
            return (0, false);
        }
        // FNA-41: unlike every other early return above, this one didn't fail to obtain an
        // input — asset() and convertToAssets() both succeeded, and the answer is a valid
        // number: zero. A share balance worth less than 1 atomic unit of the underlying is
        // known to be economically worthless, not unknowable, so this reports (0, true) the
        // same as the shares == 0 case just above, not (0, false). Reporting it as "incomplete"
        // let a permissionless dust transfer of vault shares (no Frgmnt guard or approval
        // needed) freeze deposit checkpointing, immediate withdrawals, and queued finalization
        // for the entire pool, while also leaving removeAssetCheck's separate raw-balance check
        // as the only (still nonzero-blocked) way to clear the position.
        if (underlyingAmount == 0) return (0, true);

        address poolManagerLogic = IPoolLogic(pool).poolManagerLogic();

        uint256 price;
        try IPoolManagerLogic(poolManagerLogic).getAssetPrice(underlying) returns (uint256 p) {
            price = p;
        } catch {
            return (0, false);
        }
        if (price == 0) return (0, false);

        uint256 underlyingDecimals;
        try IPoolManagerLogic(poolManagerLogic).assetDecimal(underlying) returns (uint256 d) {
            underlyingDecimals = d;
        } catch {
            return (0, false);
        }

        return ((underlyingAmount * price) / (10 ** underlyingDecimals), true);
    }

    /// @notice Liquidity-capped counterpart to getBalance() — see IWithdrawableBalanceGuard.
    /// @dev CertiK FNA-07 follow-up. Values min(shares, _capSharesByIdleLiquidity(shares)) — the
    ///      share amount this vault could actually redeem right now without touching any
    ///      adapter. Shares the exact same capped-share figure withdrawProcessing() below
    ///      actually redeems, so NAV/portion sizing and execution can never disagree — same
    ///      invariant already established for AaveV4SpokeAssetGuard/AaveV4TokenizationAssetGuard.
    /// @param pool Pool holding the vault shares.
    /// @param asset Address of the Morpho Vault V2 instance.
    /// @return balanceUsd18 USD value of the pool's *withdrawable* share balance, 18 decimals.
    function getWithdrawableBalance(
        address pool,
        address asset
    ) external view override returns (uint256 balanceUsd18) {
        (balanceUsd18, ) = _valueWithdrawablePosition(pool, asset);
    }

    /// @notice See IWithdrawableBalanceGuard.
    function isWithdrawableBalanceGuard() external pure override returns (bool) {
        return true;
    }

    function _valueWithdrawablePosition(
        address pool,
        address asset
    ) internal view returns (uint256, bool) {
        uint256 shares = IERC20(asset).balanceOf(pool);
        return _valueShares(pool, asset, _capSharesByIdleLiquidity(asset, shares));
    }

    /// @dev Caps `shares` by the vault's own **idle** balance of its underlying asset —
    ///      `IERC20(underlying).balanceOf(vault)` — converted to an equivalent share amount via
    ///      convertToShares(). This is deliberately NOT an attempt to estimate adapter liquidity
    ///      (unlike AaveV4SpokeAssetGuard/AaveV4TokenizationAssetGuard's Hub-liquidity cap):
    ///      Vault V2's adapters are curator-chosen and pluggable, with no generic way for this
    ///      guard to inspect an arbitrary adapter's liquidity. Idle balance is instead a
    ///      *provable* floor, confirmed directly against Morpho's published source
    ///      (github.com/morpho-org/vault-v2, src/VaultV2.sol, as of 2026-09) — real
    ///      redeem()/withdraw() reads
    ///      `uint256 idleAssets = IERC20(asset).balanceOf(address(this)); if (assets >
    ///      idleAssets && liquidityAdapter != address(0)) { deallocateInternal(...) }`, i.e. idle
    ///      balance is drawn down FIRST and unconditionally before any adapter is ever touched,
    ///      with no separate fee-escrow or virtual-idle accounting layered on top of that same
    ///      raw balance. So redeeming at most this many shares is *guaranteed* to never need an
    ///      adapter at all — it can never revert for the reason this finding is about. Everything
    ///      beyond this floor keeps the pre-existing, already-accepted risk (redeem() reverting
    ///      on a genuinely dry adapter) — see withdrawProcessing()'s own documentation.
    ///
    ///      Rounding: confirmed both convertToShares() and convertToAssets() use `mulDivDown`
    ///      (floor) against the same (totalAssets+1, totalSupply+virtualShares) pair, so
    ///      convertToAssets(convertToShares(idleAssets)) <= idleAssets always holds (composing
    ///      two floor divisions can only under-, never over-, estimate) — the returned share
    ///      figure is a safe underestimate, never an overestimate, of what idle balance can
    ///      actually cover.
    ///
    ///      Fault-isolated identically to _valueShares: any failure (asset()/balanceOf()/
    ///      convertToShares() reverting — the last of which is documented to internally call
    ///      accrueInterestView(), a real potential revert source, not just a defensive
    ///      precaution) degrades this vault's withdrawable amount to 0 rather than reverting,
    ///      consistent with this guard's existing resilience stance everywhere else.
    function _capSharesByIdleLiquidity(
        address vault,
        uint256 shares
    ) internal view returns (uint256) {
        if (shares == 0) return 0;

        address underlying;
        try IERC4626(vault).asset() returns (address u) {
            underlying = u;
        } catch {
            return 0;
        }
        if (underlying == address(0)) return 0;

        uint256 idleAssets;
        try IERC20(underlying).balanceOf(vault) returns (uint256 b) {
            idleAssets = b;
        } catch {
            return 0;
        }
        if (idleAssets == 0) return 0;

        uint256 withdrawableShares;
        try IERC4626(vault).convertToShares(idleAssets) returns (uint256 s) {
            withdrawableShares = s;
        } catch {
            return 0;
        }

        return shares < withdrawableShares ? shares : withdrawableShares;
    }

    /// @notice AssetGuard balances are always expressed in USD (18 decimals).
    /// @dev Paired in AssetHandler with the fixed $1.00 USDPriceAggregator for this asset's
    ///      registered price feed, so PoolManagerLogic.assetValue() resolves to exactly
    ///      `getBalance()` (price=1e18, decimals=18).
    function getDecimals(address) external pure override returns (uint256) {
        return 18;
    }

    /// @notice getBalance() already returns a fully priced base-currency value; see
    ///         IPreValuedAssetGuard and PoolManagerLogic.assetValue().
    function isPreValuedAssetGuard() external pure override returns (bool) {
        return true;
    }

    /// @notice See IIncompleteValuationGuard.
    function isIncompleteValuationGuard() external pure override returns (bool) {
        return true;
    }

    /// @notice See IIncompleteValuationGuard.
    function isValuationComplete(address pool, address asset) external view override returns (bool complete) {
        (, complete) = _valuePosition(pool, asset);
    }

    /// @notice Ensures the vault can be removed only when the pool holds no shares.
    /// @dev Deliberately checks the raw share balance rather than the inherited
    ///      ClosedAssetGuard.removeAssetCheck()'s getBalance()-based check. getBalance() degrades
    ///      to 0 on a transient valuation failure (see its documentation above) so that stake/unstake/harvest
    ///      keep working for the rest of the pool — but that same fail-open behavior would let
    ///      removeAssetCheck() treat a live, nonzero position as empty and permit removing it
    ///      from supportedAssets, orphaning the shares (excluded from NAV, unreachable by
    ///      withdrawals) until manually re-added. balanceOf() has no such failure mode to exploit.
    function removeAssetCheck(address pool, address asset) public view override {
        require(IERC20(asset).balanceOf(pool) == 0, "ClosedAssetGuard: non-empty asset");
    }

    /*//////////////////////////////////////////////////////////////
                      WITHDRAW PROCESSING
    //////////////////////////////////////////////////////////////*/

    /// @notice Builds the pro-rata redemption transaction for a withdrawal.
    /// @dev Redeems directly to the pool itself (receiver = owner = pool), not to the end
    ///      recipient `to` — PoolLogic._withdrawProcessing tracks the pool's own balance
    ///      delta of the returned `withdrawAsset` and forwards it to `to` afterwards. Routing
    ///      through the pool (rather than redeeming straight to `to`) means PoolLogic's
    ///      existing regular-processing slippage check (when the caller supplies a non-zero
    ///      slippageTolerance via withdrawCashImmediateSafe) applies automatically, with no
    ///      extra logic needed in this guard.
    ///
    ///      This intentionally only calls `redeem()` — it does not fall back to
    ///      `forceDeallocate()` if the vault's liquidity adapter is dry (see
    ///      MorphoVaultV2ContractGuard's own documentation for why forceDeallocate stays a
    ///      manager-only, deliberate action rather than an automatic fallback here).
    ///
    ///      CertiK FNA-07 follow-up: `sharesToRedeem` is now sized against
    ///      `_capSharesByIdleLiquidity`'s output, not the full share balance — see that
    ///      function's own documentation for the guarantee this provides (redemption within that
    ///      cap can never need to touch an adapter). Beyond the idle-balance floor, the
    ///      already-accepted risk remains unchanged: if `redeem()` still reverts (a request
    ///      sized above idle balance that ends up needing more from an adapter than it has), the
    ///      withdrawal reverts — the same risk class as an Aave/Morpho Blue market being fully
    ///      utilized today.
    /// @param pool Pool address.
    /// @param asset Address of the Morpho Vault V2 instance.
    /// @param withdrawPortion Portion to withdraw, 1e18 = 100%.
    /// @return withdrawAsset The vault's underlying asset.
    /// @return withdrawAmount Always 0 here — PoolLogic computes the real amount from the
    ///         pool's balance delta of `withdrawAsset` after the transaction below executes.
    /// @return txs Single `redeem()` transaction (empty if there is nothing to redeem).
    function withdrawProcessing(
        address pool,
        address asset,
        uint256 withdrawPortion,
        address /* to */
    )
        external
        view
        override
        returns (address withdrawAsset, uint256 withdrawAmount, MultiTransaction[] memory txs)
    {
        if (withdrawPortion > 1e18) revert BadPortion();

        withdrawAsset = IERC4626(asset).asset();
        if (withdrawAsset == address(0)) revert InvalidUnderlying();

        uint256 shares = IERC20(asset).balanceOf(pool);
        uint256 withdrawableShares = _capSharesByIdleLiquidity(asset, shares);
        uint256 sharesToRedeem = (withdrawableShares * withdrawPortion) / 1e18;

        if (sharesToRedeem == 0) {
            txs = new MultiTransaction[](0);
            return (withdrawAsset, withdrawAmount, txs);
        }

        txs = new MultiTransaction[](1);
        txs[0] = MultiTransaction({
            to: asset,
            txData: abi.encodeWithSelector(IERC4626.redeem.selector, sharesToRedeem, pool, pool)
        });
    }
}
