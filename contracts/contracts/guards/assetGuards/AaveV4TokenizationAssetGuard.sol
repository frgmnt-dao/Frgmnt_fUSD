// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import { IAaveV4TokenizationManager } from "../../interfaces/IAaveV4TokenizationManager.sol";
import { ITokenizationSpoke } from "../../interfaces/aave/v4/ITokenizationSpoke.sol";
import { IHubBase } from "../../interfaces/aave/v4/IHubBase.sol";
import { IPoolManagerLogic } from "../../interfaces/IPoolManagerLogic.sol";
import { IPoolLogic } from "../../interfaces/IPoolLogic.sol";
import { IERC20Extended } from "../../interfaces/IERC20Extended.sol";
import { IHasSupportedAsset } from "../../interfaces/IHasSupportedAsset.sol";
import { IAddAssetCheckGuard } from "../../interfaces/guards/IAddAssetCheckGuard.sol";
import { IPreValuedAssetGuard } from "../../interfaces/guards/IPreValuedAssetGuard.sol";
import { IIncompleteValuationGuard } from "../../interfaces/guards/IIncompleteValuationGuard.sol";
import { IWithdrawableBalanceGuard } from "../../interfaces/guards/IWithdrawableBalanceGuard.sol";
import { ClosedAssetGuard } from "./ClosedAssetGuard.sol";

/*//////////////////////////////////////////////////////////////
              AAVE V4 TOKENIZATION ASSET GUARD
//////////////////////////////////////////////////////////////*/

/// @title Aave V4 Tokenization Asset Guard
/// @notice AssetGuard for Aave V4 TokenizationSpoke positions (ERC-4626 vaults depositing
///         directly into the Liquidity Hub, bypassing the main lending Spoke entirely).
/// @dev
///  - One guard instance services any number of registered TokenizationSpoke instances; each
///    instance is itself the registered "supported asset" address (one per underlying asset),
///    so unlike AaveV4SpokeAssetGuard there is no multi-reserve / multi-underlying aggregation
///    and no side allowlist of reserveIds — a TokenizationSpoke maps 1:1 to a single asset, the
///    same shape as a Morpho Vault V2 instance.
///  - The pool's position carries no debt, so there is no flashloan-based unwind path and no
///    health factor to protect. Balances are simply `convertToAssets(shares)`.
///  - `getBalance` / `withdrawProcessing` deliberately do NOT consult the
///    AaveV4TokenizationManager whitelist — a vault must remain valuable and exitable even if
///    governance later revokes it from the whitelist; only *new* exposure
///    (AaveV4TokenizationContractGuard, and `addAssetCheck` below) is gated by the whitelist.
///  - CertiK FNA-07 follow-up: `getWithdrawableBalance`/`withdrawProcessing` cap the redeemable
///    share amount by `IHubBase.getAssetLiquidity` for this vault's `(hub, assetId)` — see
///    `_capSharesByAvailableLiquidity`. Unlike Morpho Vault V2 (whose only liquidity signal,
///    `maxRedeem()`, canonically always returns 0 — see MorphoVaultV2AssetGuard's own FNA-25
///    documentation for why that guard's equivalent cap was removed rather than kept),
///    `IHubBase.getAssetLiquidity` is a real, non-reverting liquidity read with no known false
///    -zero failure mode, so this cap does not carry that same risk.
///  - KNOWN RESIDUAL GAP (not fixed here): this cap is only aware of *this guard's own* vault.
///    A TokenizationSpoke deposits directly into a Hub, and a pool could separately also hold an
///    AaveV4SpokeAssetGuard reserve drawing from the *same* underlying `(hub, assetId)` — the two
///    guards are separate contracts with no shared state, so within one withdrawal transaction
///    each could independently see the Hub's full liquidity as available and, together, attempt
///    to withdraw more than the Hub can actually deliver. AaveV4SpokeAssetGuard's own ledger
///    (see HubLiquidityLedger) only dedupes *within* its own multi-reserve loop, not across guard
///    contracts. Closing this fully needs a pool-level, cross-guard liquidity ledger shared for
///    the duration of one withdrawal transaction — a materially larger change than either
///    guard's own per-instance fix, deliberately out of scope here and left as a tracked
///    follow-up rather than silently unaddressed.
contract AaveV4TokenizationAssetGuard is
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
    error NotTokenizationSpoke();
    error UnderlyingNotPriced();
    error UnderlyingNotSupported();
    error VaultNotWhitelisted();
    error ZeroUnitPrice();

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Protocol-owned allowlist of Aave V4 TokenizationSpoke instances permitted per pool.
    address public immutable aaveV4TokenizationManager;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param aaveV4TokenizationManager_ Address of the protocol-owned AaveV4TokenizationManager.
    constructor(address aaveV4TokenizationManager_) {
        if (aaveV4TokenizationManager_ == address(0)) revert ManagerZero();
        aaveV4TokenizationManager = aaveV4TokenizationManager_;
    }

    /*//////////////////////////////////////////////////////////////
                      ADD-ASSET REGISTRATION CHECK
    //////////////////////////////////////////////////////////////*/

    /// @notice Required by IAddAssetCheckGuard — signals that PoolManagerLogic._addAsset must
    ///         call `addAssetCheck` before registering an asset of this type.
    function isAddAssetCheckGuard() external pure returns (bool) {
        return true;
    }

    /// @notice Validates a candidate TokenizationSpoke instance before it can be registered as
    ///         a supported asset of the pool.
    /// @dev Enforces three independent conditions:
    ///       1) The vault has been explicitly whitelisted for this pool by the protocol owner
    ///          in AaveV4TokenizationManager — this is the actual enforcement point that makes
    ///          the whitelist meaningful; without it, a pool manager could register any
    ///          ERC-4626-shaped contract on their own authority.
    ///       2) The vault's underlying asset already has a registered price feed and asset
    ///          guard, so that `getBalance` below can value the position and `assetDecimal`
    ///          calls made elsewhere in the protocol do not unexpectedly revert.
    ///       3) FNA-20: the underlying is also a supported asset of THIS pool specifically.
    ///          (2) alone only proves the underlying is priced *somewhere* in the protocol's
    ///          global AssetHandler registry — assetDecimal()/getAssetPrice() do not consult
    ///          this pool's own supportedAssets list at all, so a vault could otherwise be
    ///          onboarded whose underlying was never independently vetted for this pool. See
    ///          removeTokenCheck below for the matching removal-side protection.
    /// @param poolLogic Address of the pool the asset is being added to.
    /// @param asset Candidate asset being registered; `asset.asset` is the TokenizationSpoke address.
    function addAssetCheck(
        address poolLogic,
        IHasSupportedAsset.Asset calldata asset
    ) external view override {
        address vault = asset.asset;

        if (
            !IAaveV4TokenizationManager(aaveV4TokenizationManager).isValidPoolVault(
                poolLogic,
                vault
            )
        ) {
            revert VaultNotWhitelisted();
        }

        address underlying;
        try IERC4626(vault).asset() returns (address u) {
            underlying = u;
        } catch {
            revert NotTokenizationSpoke();
        }
        if (underlying == address(0)) revert NotTokenizationSpoke();

        // Confirm the vault's own share<->asset conversion is callable before relying on it
        // in getBalance/withdrawProcessing.
        try IERC4626(vault).convertToAssets(0) returns (uint256) {
            // no-op: call succeeding is all that matters here
        } catch {
            revert NotTokenizationSpoke();
        }
        address poolManagerLogic = IPoolLogic(poolLogic).poolManagerLogic();

        // FNA-20: assetDecimal()/getAssetPrice() below only check the protocol-wide
        // AssetHandler registry, not this pool's own supportedAssets list — enforce that
        // separately so a vault can't be onboarded wrapping an underlying this specific pool
        // never independently vetted.
        if (!IHasSupportedAsset(poolManagerLogic).isSupportedAsset(underlying)) {
            revert UnderlyingNotSupported();
        }

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

    /// @notice Returns the pool's USD-denominated value of its TokenizationSpoke position.
    /// @dev See _valuePosition below for which calls are fault-isolated and why.
    /// @param pool Pool holding the vault shares.
    /// @param asset Address of the Aave V4 TokenizationSpoke instance.
    /// @return balanceUsd18 USD value of the pool's share balance, 18 decimals.
    function getBalance(
        address pool,
        address asset
    ) public view override returns (uint256 balanceUsd18) {
        (balanceUsd18, ) = _valuePosition(pool, asset);
    }

    /// @dev Shared by getBalance() and isValuationComplete() below, so the two can never
    ///      disagree about which failure paths count as "incomplete". Every external call this
    ///      function makes — into the vault itself (`asset()`, `convertToAssets()`) and into the
    ///      pricing layer (`getAssetPrice()`, `assetDecimal()`, which can revert on Chainlink
    ///      staleness or L2 sequencer downtime, not just on a misbehaving vault) — is wrapped in
    ///      try/catch and degrades to a balance of 0 on failure, rather than reverting: this
    ///      function sits on the hot path of `PoolManagerLogic.totalFundValue()`, read on every
    ///      stake/unstake/harvest call and every immediate cash withdrawal. A single misbehaving
    ///      or unpriced vault must not freeze those operations for the entire pool (previously
    ///      only the vault calls were fault-isolated here; the pricing calls were not, so a
    ///      broken price feed for this one vault could revert totalFundValue() outright).
    ///      isValuationComplete() lets callers that need to know the reading was trustworthy
    ///      (PoolManagerLogic.totalFundValueWithCompleteness()) tell the difference between
    ///      "genuinely empty" and "temporarily unknowable".
    function _valuePosition(
        address pool,
        address asset
    ) internal view returns (uint256 balanceUsd18, bool complete) {
        return _valueShares(pool, asset, IERC20(asset).balanceOf(pool));
    }

    /// @dev Shared USD-valuation logic for an arbitrary share amount, factored out of
    ///      _valuePosition so the liquidity-capped path below (_valueWithdrawablePosition) can
    ///      reuse the exact same failure-path handling without disagreeing about which failures
    ///      count as "incomplete" — same pattern as MorphoVaultV2AssetGuard._valueShares.
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
        // let a permissionless dust transfer of vault shares freeze completeness-aware
        // NAV-dependent operations for the entire pool.
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
    /// @dev Values min(shares, _capSharesByAvailableLiquidity(shares)) — the share amount this
    ///      vault could actually redeem right now, not just the pool's full claim (FNA-07
    ///      follow-up). Shares the exact same capped-share figure withdrawProcessing() below
    ///      actually redeems, so NAV/portion sizing and execution can never disagree.
    /// @param pool Pool holding the vault shares.
    /// @param asset Address of the Aave V4 TokenizationSpoke instance.
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
        return _valueShares(pool, asset, _capSharesByAvailableLiquidity(asset, shares));
    }

    /// @dev Caps `shares` by the Hub's real available liquidity for this vault's underlying,
    ///      converted into an equivalent share amount via convertToShares — mirrors
    ///      AaveV4SpokeAssetGuard's asset-unit liquidity cap, adapted for TokenizationSpoke's
    ///      ERC-4626 (share-denominated) redeem() interface. Any failure along the way (hub()/
    ///      assetId() unresolvable, the Hub liquidity read itself reverting, or convertToShares
    ///      reverting) degrades to a withdrawable amount of 0 for this vault rather than
    ///      reverting — consistent with this guard's existing fault-isolation stance elsewhere.
    function _capSharesByAvailableLiquidity(
        address vault,
        uint256 shares
    ) internal view returns (uint256) {
        if (shares == 0) return 0;

        address hub;
        uint256 assetId;
        try ITokenizationSpoke(vault).hub() returns (address h) {
            hub = h;
        } catch {
            return 0;
        }
        try ITokenizationSpoke(vault).assetId() returns (uint256 a) {
            assetId = a;
        } catch {
            return 0;
        }

        uint256 availableLiquidity;
        try IHubBase(hub).getAssetLiquidity(assetId) returns (uint256 l) {
            availableLiquidity = l;
        } catch {
            return 0;
        }
        if (availableLiquidity == 0) return 0;

        uint256 withdrawableShares;
        try IERC4626(vault).convertToShares(availableLiquidity) returns (uint256 s) {
            withdrawableShares = s;
        } catch {
            return 0;
        }

        return shares < withdrawableShares ? shares : withdrawableShares;
    }

    /// @notice Returns the vault share token's own decimals.
    /// @dev CertiK FNA-45 follow-up: previously hardcoded 18 to match the placeholder $1.00
    ///      USDPriceAggregator this asset is registered against for PoolManagerLogic.assetValue()
    ///      — but that shortcut never actually consults getDecimals() at all (see assetValue()'s
    ///      own docs), so the hardcoded value served no real purpose there and was simply wrong
    ///      for any consumer that reads a pre-valued share's decimals directly. The vault share
    ///      is a real, transferable ERC-20 with its own genuine decimals (getUnitPrice() below
    ///      relies on this being accurate).
    function getDecimals(address asset) external view override returns (uint256) {
        return IERC20Extended(asset).decimals();
    }

    /// @notice getBalance() already returns a fully priced base-currency value; see
    ///         IPreValuedAssetGuard and PoolManagerLogic.assetValue().
    function isPreValuedAssetGuard() external pure override returns (bool) {
        return true;
    }

    /// @notice Values one whole vault share in USD (18 decimals) — see IPreValuedAssetGuard.
    /// @dev CertiK FNA-45 follow-up: PoolManagerLogic.getAssetPrice() dispatches here for this
    ///      asset instead of returning AssetHandler's placeholder $1.00 identity price, so a
    ///      caller pricing the share directly (SlippageAccumulator.assetValue(), when a share is
    ///      routed through the guarded Uniswap router) gets its real per-unit value instead of
    ///      treating 1 share as always worth exactly $1.
    ///
    ///      Deliberately reverts on any failure rather than degrading to 0/false — unlike
    ///      getBalance()/_valueShares() above, whose fail-open design exists specifically to
    ///      protect totalFundValue()'s pool-wide availability from one bad vault, a caller asking
    ///      for a unit price needs a trustworthy number to act on (size a slippage bound) or
    ///      nothing at all: silently returning 0 here would size a slippage check against zero
    ///      value and let an arbitrarily bad trade through, the opposite of fail-closed.
    ///
    ///      Uses `msg.sender` as the pricing context rather than taking a separate pool/
    ///      poolManagerLogic parameter, matching getUnitPrice(address)'s single-argument
    ///      interface signature — the only intended caller is PoolManagerLogic.getAssetPrice()
    ///      itself (a plain, non-delegatecall external call, so msg.sender here is exactly that
    ///      calling PoolManagerLogic instance). assetHandler/governance are shared globally
    ///      across every pool in this single-deployment protocol, so any PoolManagerLogic
    ///      instance resolves the same underlying price/decimals regardless of which pool asked.
    function getUnitPrice(address asset) external view override returns (uint256) {
        uint256 shareDecimals = IERC20Extended(asset).decimals();
        uint256 oneShare = 10 ** uint256(shareDecimals);

        address underlying = IERC4626(asset).asset();
        if (underlying == address(0)) revert InvalidUnderlying();

        uint256 underlyingAmount = IERC4626(asset).convertToAssets(oneShare);

        uint256 price = IPoolManagerLogic(msg.sender).getAssetPrice(underlying);
        if (price == 0) revert UnderlyingNotPriced();

        uint256 underlyingDecimals = IPoolManagerLogic(msg.sender).assetDecimal(underlying);

        uint256 unitPrice = (underlyingAmount * price) / (10 ** underlyingDecimals);
        if (unitPrice == 0) revert ZeroUnitPrice();
        return unitPrice;
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

    /// @notice FNA-20: blocks removing `token` from the pool's supportedAssets while `asset` (a
    ///         TokenizationSpoke vault registered under this guard) still holds shares wrapping
    ///         that exact token as its underlying.
    /// @dev ClosedAssetGuard's inherited default always returns true (permissive), which would
    ///      let `token`'s own removeAssetCheck succeed even while the pool holds real, indirect
    ///      exposure to it via vault shares — see addAssetCheck above for the matching
    ///      onboarding-side protection.
    ///
    ///      FNA-20 follow-up: when `asset` (the vault) holds nonzero shares but its `asset()`
    ///      call reverts, this now fails CLOSED (blocks removal) rather than open. An earlier
    ///      revision fell through to "not used" here specifically to avoid one broken vault
    ///      permanently blocking removal of every OTHER supported asset in the pool — but that
    ///      let a live underlying be removed from supportedAssets while a vault that might still
    ///      recover continued wrapping it; a later successful redeem() through that vault would
    ///      then land funds outside any tracked/valued asset, silently understating NAV until
    ///      governance manually re-adds the token. `asset()` is a trivial, near-always-immutable
    ///      view getter on a correctly-implemented ERC-4626 vault — a revert here is a strong
    ///      signal of a genuinely broken vault, not routine transient failure (unlike, say, a
    ///      Chainlink staleness revert). The DoS this reopens is narrow and bounded: it can only
    ///      block removing OTHER assets from THIS specific pool, only while THIS specific vault
    ///      both holds a stuck nonzero balance and stays broken — not withdrawals, not deposits,
    ///      not other pools — and is resolved as soon as the vault is fixed, drained, or its
    ///      stuck shares are otherwise dealt with. That bounded cost is preferable to silently
    ///      corrupting NAV accounting for every depositor.
    function removeTokenCheck(
        address pool,
        address asset,
        address token
    ) public view override returns (bool) {
        if (IERC20(asset).balanceOf(pool) == 0) return true;

        try IERC4626(asset).asset() returns (address underlying) {
            return token != underlying;
        } catch {
            return false;
        }
    }

    /*//////////////////////////////////////////////////////////////
                      WITHDRAW PROCESSING
    //////////////////////////////////////////////////////////////*/

    /// @notice Builds the pro-rata redemption transaction for a withdrawal.
    /// @dev Redeems directly to the pool itself (receiver = owner = pool), not to the end
    ///      recipient `to` — PoolLogic._withdrawProcessing tracks the pool's own balance delta
    ///      of the returned `withdrawAsset` and forwards it to `to` afterwards, which also means
    ///      PoolLogic's existing regular-processing slippage check (when the caller supplies a
    ///      non-zero slippageTolerance via withdrawCashImmediateSafe) applies automatically with
    ///      no extra logic needed here. Unlike AaveV4SpokeAssetGuard, a TokenizationSpoke wraps
    ///      exactly one underlying asset, so the single-`withdrawAsset` pattern is sufficient —
    ///      there is no multi-underlying aggregation problem to work around here.
    ///
    ///      CertiK FNA-07 follow-up: `sharesToRedeem` is now sized against
    ///      `_capSharesByAvailableLiquidity`'s output, not the full share balance — see the
    ///      contract-level @dev above for the mechanism and its known residual (cross-guard,
    ///      not cross-reserve) gap. `redeem()` is therefore never asked for more than the Hub can
    ///      currently return *through this vault specifically*.
    /// @param pool Pool address.
    /// @param asset Address of the Aave V4 TokenizationSpoke instance.
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
        uint256 withdrawableShares = _capSharesByAvailableLiquidity(asset, shares);
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
