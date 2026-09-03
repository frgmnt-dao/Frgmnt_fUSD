// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAaveProtocolDataProvider } from "../../interfaces/aave/IAaveProtocolDataProvider.sol";
import { IAaveV3Pool } from "../../interfaces/aave/v3/IAaveV3Pool.sol";
import { IAaveLendingPoolAssetGuard } from "../../interfaces/guards/IAaveLendingPoolAssetGuard.sol";
import { ISlippageCheckingGuard } from "../../interfaces/guards/ISlippageCheckingGuard.sol";
import { IPreValuedAssetGuard } from "../../interfaces/guards/IPreValuedAssetGuard.sol";
import { IUnwindCostAwareGuard } from "../../interfaces/guards/IUnwindCostAwareGuard.sol";
import { IDeficitReportingGuard } from "../../interfaces/guards/IDeficitReportingGuard.sol";
import { IWithdrawableBalanceGuard } from "../../interfaces/guards/IWithdrawableBalanceGuard.sol";
import { IAssetGuard } from "../../interfaces/guards/IAssetGuard.sol";
import { IHasSupportedAsset } from "../../interfaces/IHasSupportedAsset.sol";
import { IPoolLogic } from "../../interfaces/IPoolLogic.sol";
import { IERC20Extended } from "../../interfaces/IERC20Extended.sol";
import { IV3SwapRouter } from "../../interfaces/IV3SwapRouter.sol";
import { IHasAssetInfo } from "../../interfaces/IHasAssetInfo.sol";

import { ClosedAssetGuard } from "./ClosedAssetGuard.sol";

contract AaveV3LendingPoolAssetGuard is
    ClosedAssetGuard,
    IAaveLendingPoolAssetGuard,
    ISlippageCheckingGuard,
    IPreValuedAssetGuard,
    IUnwindCostAwareGuard,
    IDeficitReportingGuard,
    IWithdrawableBalanceGuard
{
    // -----------------------------
    // Constants
    // -----------------------------

    uint256 private constant BPS_DENOMINATOR = 10_000;

    uint256 internal constant FEE_DENOMINATOR = 1e6; // 1,000,000 = 100%

    uint256 private constant PORTION_DENOMINATOR = 1e18;

    /// @notice USDT on Base mainnet (example address you provided)
    address public constant USDT_BASE = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;

    // -----------------------------
    // Types
    // -----------------------------

    struct DebtRepayPlan {
        address underlyingAsset;
        uint256 repayStableAmount; // rateMode = 1
        uint256 repayVariableAmount; // rateMode = 2
    }

    struct FlashloanParams {
        uint256 withdrawPortion; // 1e18
        address settlementToken; // flash asset
        uint256 slippageBps; // oracle slippage tolerance
        DebtRepayPlan[] repayPlans; // pro-rata debts
    }

    // -----------------------------
    // State
    // -----------------------------

    /// @notice Required by ISlippageCheckingGuard
    bool public override isSlippageCheckingGuard = true;

    IAaveProtocolDataProvider public immutable aaveProtocolDataProvider;
    address public immutable override aaveLendingPool;
    address public immutable swapRouter;

    address public immutable preferredSettlementAsset;

    address public owner;

    uint256 public defaultSlippageBps = 70; // 0.70%
    uint256 public flashAmountBufferBps = 40; // 0.40%

    // Router flexibility:
    // exactInput: forward path tokenIn -> ... -> tokenOut
    mapping(address => mapping(address => bytes)) public uniV3PathExactIn;
    // exactOutput: reversed path tokenOut <- ... <- tokenIn (Uniswap requirement)
    mapping(address => mapping(address => bytes)) public uniV3PathExactOut;
    // fallback single-hop fee
    mapping(address => mapping(address => uint24)) public uniV3Fee;

    // tokens requiring approve(0) before approve(non-zero)
    mapping(address => bool) public requiresApproveReset;

    // -----------------------------
    // Events
    // -----------------------------

    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);
    event DefaultSlippageBpsUpdated(uint256 slippageBps);
    event FlashAmountBufferBpsUpdated(uint256 bufferBps);

    event UniV3FeeSet(address indexed tokenIn, address indexed tokenOut, uint24 fee);
    event UniV3PathExactInSet(address indexed tokenIn, address indexed tokenOut, bytes path);
    event UniV3PathExactOutSet(
        address indexed tokenIn,
        address indexed tokenOut,
        bytes reversedPath
    );

    event ApproveResetFlagSet(address indexed token, bool required);

    modifier onlyOwner() {
        require(msg.sender == owner, "Frgmnt: only owner");
        _;
    }

    constructor(
        address aaveProtocolDataProvider_,
        address aaveLendingPool_,
        address preferredSettlementAsset_,
        address swapRouter_
    ) {
        require(
            aaveProtocolDataProvider_ != address(0) && aaveLendingPool_ != address(0),
            "Frgmnt: invalid address"
        );
        require(preferredSettlementAsset_ != address(0), "Frgmnt: settlement=0");
        require(swapRouter_ != address(0), "Frgmnt: swapRouter=0");

        owner = msg.sender;

        aaveProtocolDataProvider = IAaveProtocolDataProvider(aaveProtocolDataProvider_);
        aaveLendingPool = aaveLendingPool_;
        preferredSettlementAsset = preferredSettlementAsset_;
        swapRouter = swapRouter_;

        // default: USDT-like approval behavior
        requiresApproveReset[USDT_BASE] = true;
    }

    // ============================================================
    // Admin config
    // ============================================================

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Frgmnt: owner=0");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    function setDefaultSlippageBps(uint256 slippageBps) external onlyOwner {
        require(slippageBps <= 2_000, "Frgmnt: slippage too high");
        defaultSlippageBps = slippageBps;
        emit DefaultSlippageBpsUpdated(slippageBps);
    }

    function setFlashAmountBufferBps(uint256 bufferBps) external onlyOwner {
        require(bufferBps <= 500, "Frgmnt: buffer too high");
        flashAmountBufferBps = bufferBps;
        emit FlashAmountBufferBpsUpdated(bufferBps);
    }

    function setUniV3Fee(address tokenIn, address tokenOut, uint24 fee) external onlyOwner {
        require(tokenIn != address(0) && tokenOut != address(0), "Frgmnt: bad token");
        require(fee > 0, "Frgmnt: bad fee");
        uniV3Fee[tokenIn][tokenOut] = fee;
        emit UniV3FeeSet(tokenIn, tokenOut, fee);
    }

    function setUniV3PathExactIn(
        address tokenIn,
        address tokenOut,
        bytes calldata path
    ) external onlyOwner {
        require(tokenIn != address(0) && tokenOut != address(0), "Frgmnt: bad token");
        require(path.length > 0, "Frgmnt: empty path");
        _validateUniV3Path(path);
        uniV3PathExactIn[tokenIn][tokenOut] = path;
        emit UniV3PathExactInSet(tokenIn, tokenOut, path);
    }

    function setUniV3PathExactOut(
        address tokenIn,
        address tokenOut,
        bytes calldata reversedPath
    ) external onlyOwner {
        require(tokenIn != address(0) && tokenOut != address(0), "Frgmnt: bad token");
        require(reversedPath.length > 0, "Frgmnt: empty path");
        _validateUniV3Path(reversedPath);
        uniV3PathExactOut[tokenIn][tokenOut] = reversedPath;
        emit UniV3PathExactOutSet(tokenIn, tokenOut, reversedPath);
    }

    function setRequiresApproveReset(address token, bool required) external onlyOwner {
        require(token != address(0), "Frgmnt: token=0");
        requiresApproveReset[token] = required;
        emit ApproveResetFlagSet(token, required);
    }

    // ============================================================
    // IAssetGuard VIEW
    // ============================================================

    function getBalance(address pool, address) public view override returns (uint256 balance) {
        (uint256 totalCollateralInUsd, uint256 totalDebtInUsd) = _getBalance(pool);

        if (totalCollateralInUsd > totalDebtInUsd) {
            balance = totalCollateralInUsd - totalDebtInUsd;
        }
    }

    /// @notice FNA-54: see IDeficitReportingGuard — an underwater position (debt > collateral)
    ///         is a real liability, not a zero-value asset. getBalance() above must still clamp
    ///         at 0 (every NAV consumer sums non-negative uint256 balances), but that silently
    ///         *omits* the shortfall instead of *subtracting* it from the rest of the pool's
    ///         positive balances — including, most directly, the borrowed tokens this exact
    ///         position produced and that the pool still holds as a separately-counted balance.
    ///         Every aggregate NAV/withdrawal-sizing consumer sums this alongside its gross
    ///         positive total and subtracts it (floored at 0) — see this interface's own docs.
    function isDeficitReportingGuard() external pure override returns (bool) {
        return true;
    }

    function getDeficit(address pool, address) external view override returns (uint256 deficit) {
        (uint256 totalCollateralInUsd, uint256 totalDebtInUsd) = _getBalance(pool);

        if (totalDebtInUsd > totalCollateralInUsd) {
            deficit = totalDebtInUsd - totalCollateralInUsd;
        }
    }

    /// @notice FNA-35: see IUnwindCostAwareGuard — marker so FundCalculationLibrary substitutes
    ///         getNetRealizableBalance() below for getBalance()'s gross figure when sizing NAV
    ///         for the immediate/queued withdrawal solvency haircut.
    function isUnwindCostAwareGuard() external pure override returns (bool) {
        return true;
    }

    /// @notice getBalance() minus a conservative estimate of what a full unwind of this position
    ///         actually costs via this guard's own flashloan route: the settlement<->debt swaps'
    ///         oracle-based slippage tolerance (already folded into
    ///         _estimateFlashAmountInSettlement's sizing), the configured flash-amount buffer, and
    ///         Aave's own flashloan premium — none of which getBalance()'s gross
    ///         collateral-minus-debt figure reflects. Without debt, there is nothing to unwind and
    ///         gross equity is already net-realizable (a plain collateral withdrawal). See
    ///         IUnwindCostAwareGuard and FNA-35.
    function getNetRealizableBalance(
        address pool,
        address
    ) external view override returns (uint256 balance) {
        balance = _netRealizableBalance(pool);
    }

    /// @dev CertiK FNA-35 follow-up: previously only deducted the flashloan premium
    ///      (`flashAmount * premiumBps`) from gross equity, leaving the route fee, oracle
    ///      slippage tolerance, and `flashAmountBufferBps` — all baked into `flashAmount` itself
    ///      by `_estimateFlashAmountInSettlement` — silently unaccounted for. For a same-asset
    ///      debt position (no swap needed) that under-deduction was small (just the buffer); for
    ///      a cross-asset position (settlement token != debt token) it silently ignored the
    ///      entire swap cost, exactly the gap CertiK's PoC demonstrated.
    ///
    ///      Fix: rather than isolate each cost component separately (fragile — a future change
    ///      to `_estimateFlashAmountInSettlement`'s sizing could silently reopen this gap again),
    ///      price the *whole* flashloan outlay (`flashAmount + premium`, in settlement-token
    ///      terms) and compare it against `totalDebtInUsd` — the debt's own fair USD value,
    ///      already subtracted above via `gross`. `flashAmount` is provably always
    ///      >= the fair settlement-equivalent of the debt being repaid (same-asset legs
    ///      contribute their exact repay amount pre-buffer; cross-asset legs are
    ///      `_oracleMaxIn`-inflated by slippage/fee pre-buffer; the buffer then multiplies the
    ///      whole sum), so the excess is exactly the combined cost of buffer + route fee +
    ///      slippage + premium — everything the original FNA-35 recommendation asked for, in one
    ///      conservative calculation instead of three separate ones.
    function _netRealizableBalance(address pool) internal view returns (uint256 balance) {
        (uint256 totalCollateralInUsd, uint256 totalDebtInUsd) = _getBalance(pool);
        if (totalCollateralInUsd <= totalDebtInUsd) return 0;
        uint256 gross = totalCollateralInUsd - totalDebtInUsd;

        (DebtRepayPlan[] memory repayPlans, uint256 debtAssetCount) = _collectDebtPlans(
            pool,
            PORTION_DENOMINATOR
        );
        if (debtAssetCount == 0) return gross;

        address settlementToken = _chooseSettlementToken(repayPlans);
        uint256 flashAmount = _estimateFlashAmountInSettlement(
            pool,
            repayPlans,
            settlementToken,
            defaultSlippageBps
        );

        uint256 premiumBps = uint256(IAaveV3Pool(aaveLendingPool).FLASHLOAN_PREMIUM_TOTAL());
        uint256 premiumInSettlement = (flashAmount * premiumBps) / BPS_DENOMINATOR;
        uint256 totalOutlaySettlement = flashAmount + premiumInSettlement;

        address factory = IPoolLogic(pool).factory();
        uint256 priceUsd = IHasAssetInfo(factory).getAssetPrice(settlementToken);
        uint256 decimals = IERC20Extended(settlementToken).decimals();
        uint256 totalOutlayUsd = (priceUsd * totalOutlaySettlement) / (10 ** decimals);

        uint256 unwindCostUsd = totalOutlayUsd > totalDebtInUsd
            ? totalOutlayUsd - totalDebtInUsd
            : 0;

        balance = gross > unwindCostUsd ? gross - unwindCostUsd : 0;
    }

    /// @notice Liquidity-capped counterpart to getBalance()/getNetRealizableBalance() — see
    ///         IWithdrawableBalanceGuard.
    /// @dev CertiK FNA-07 follow-up. This position is leveraged (collateral + debt unwound via a
    ///      single flashloan), unlike the no-debt integrations (Aave V4 Spoke/Tokenization,
    ///      Morpho Vault V2) already fixed for FNA-07 — so a per-reserve independent cap is
    ///      unsafe here: debt repayment and collateral withdrawal are scaled by the *same*
    ///      withdrawPortion to keep the position's health factor unchanged across a partial
    ///      exit, and the flashloan is repaid entirely from swapping withdrawn collateral back to
    ///      the settlement token. If one reserve's collateral withdrawal were capped below
    ///      withdrawPortion while debt repayment (and the flashloan sized to fund it) stayed at
    ///      the full, uncapped portion, the flashloan could come back under-funded — the
    ///      unwind reverting for a *worse*, harder-to-diagnose reason than the plain liquidity
    ///      revert this fix exists to avoid. See _maxSafePortion's own documentation for the
    ///      single, uniform ceiling this guard applies instead. Value here is
    ///      netRealizableBalance (100%, cost-haircut-adjusted) scaled by that same ceiling,
    ///      consistent with the linear-scaling assumption already used throughout this guard's
    ///      debt/flashloan sizing math (_collectDebtPlans, _estimateFlashAmountInSettlement).
    function getWithdrawableBalance(
        address pool,
        address
    ) external view override returns (uint256 balanceUsd18) {
        uint256 netRealizable = _netRealizableBalance(pool);
        uint256 maxSafePortion = _maxSafePortion(pool);
        balanceUsd18 = (netRealizable * maxSafePortion) / PORTION_DENOMINATOR;
    }

    /// @notice See IWithdrawableBalanceGuard.
    function isWithdrawableBalanceGuard() external pure override returns (bool) {
        return true;
    }

    /// @dev Confirmed against Aave V3's real source (github.com/aave/aave-v3-core,
    ///      AToken.burn(): `IERC20(_underlyingAsset).safeTransfer(receiverOfUnderlying, amount)`)
    ///      that a reserve's aToken contract pays out a withdrawal from its own raw underlying
    ///      balance — ValidationLogic.validateWithdraw() itself only checks the caller's aToken
    ///      balance, not reserve liquidity, so the real constraint lives in this downstream
    ///      transfer, not a named "liquidity" check. `IERC20Extended(underlying).balanceOf(aToken)`
    ///      is therefore exactly what a withdraw() call for that reserve can pay out right now.
    ///
    ///      Returns the single largest portion (<= PORTION_DENOMINATOR) safe to apply uniformly
    ///      across every reserve's collateral withdrawal (and, by extension, debt repayment —
    ///      see getWithdrawableBalance's own documentation for why this must be one shared
    ///      ceiling, not a per-reserve independent cap). A reserve with no aToken position never
    ///      constrains this ceiling.
    ///
    ///      SECOND-PASS AUDIT NOTE (considered, deliberately not "fixed" further): because the
    ///      ceiling is shared across every reserve, an aToken is a plain transferable ERC20, and
    ///      anyone can permissionlessly send an arbitrary amount of it to this pool's address, a
    ///      third party could donate a tiny aToken balance for a reserve that (a) is already one
    ///      of this pool's supportedAssets but (b) the pool never actually chose to supply to,
    ///      timed while that reserve's real Aave market happens to be near-fully-utilized —
    ///      zeroing this whole guard's contribution to *immediate* withdrawals until the donated
    ///      balance is cleared or that market's liquidity recovers. A raw-balance dust tolerance
    ///      (the pattern AaveV4SpokeAssetGuard uses) would NOT meaningfully close this: the
    ///      binding constraint is the availableLiquidity/aTokenBalance *ratio*, which can be 0
    ///      regardless of how large or small aTokenBalance is, so it would only raise the
    ///      donation cost from ~1 wei to ~1 dust-threshold wei — still economically negligible.
    ///      A real fix would need to weight each reserve's ability to constrain the ceiling by
    ///      its own USD value (ignoring reserves below some minimum), adding real complexity and
    ///      a new governance-tunable threshold for a low-severity issue: this only zeroes *this
    ///      guard's* contribution to the *immediate* withdrawal path specifically — the queued
    ///      withdrawal path never consults this at all (see IWithdrawableBalanceGuard's own
    ///      documentation), and the manager can clear the donated dust directly via
    ///      execTransaction (a plain Aave withdraw() call, independent of this cap) at any time.
    ///      Left as a documented, accepted residual risk rather than a code change.
    function _maxSafePortion(address pool) internal view returns (uint256 portion) {
        IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(
            IPoolLogic(pool).poolManagerLogic()
        ).getSupportedAssets();

        portion = PORTION_DENOMINATOR;

        for (uint256 i = 0; i < supportedAssets.length; ++i) {
            address underlying = supportedAssets[i].asset;

            address aToken = IAaveV3Pool(aaveLendingPool).getReserveAToken(underlying);
            if (aToken == address(0)) continue;

            uint256 aTokenBalance = IERC20Extended(aToken).balanceOf(pool);
            if (aTokenBalance == 0) continue;

            uint256 availableLiquidity = IERC20Extended(underlying).balanceOf(aToken);
            if (availableLiquidity >= aTokenBalance) continue; // this reserve doesn't constrain

            uint256 maxPortionForThisReserve = (availableLiquidity * PORTION_DENOMINATOR) /
                aTokenBalance;
            if (maxPortionForThisReserve < portion) portion = maxPortionForThisReserve;
        }
    }

    function getDecimals(address) external pure override returns (uint256) {
        return 18;
    }

    /// @notice getBalance() already returns a fully priced base-currency value; see
    ///         IPreValuedAssetGuard and PoolManagerLogic.assetValue().
    function isPreValuedAssetGuard() external pure override returns (bool) {
        return true;
    }

    function removeAssetCheck(address pool, address) public view override {
        (uint256 totalCollateralInUsd, uint256 totalDebtInUsd) = _getBalance(pool);

        require(
            totalCollateralInUsd == 0 && totalDebtInUsd == 0,
            "Frgmnt: cannot remove non-empty asset"
        );
    }

    function removeTokenCheck(
        address pool,
        address,
        address token
    ) public view override returns (bool) {
        (uint256 collateralBalance, uint256 debtBalance) = _calculateAaveBalance(pool, token);
        if ((collateralBalance > 0) || (debtBalance > 0)) {
            return false;
        }

        return true;
    }

    // ============================================================
    // Withdraw planner (IAssetGuard)
    // ============================================================

    function withdrawProcessing(
        address pool,
        address,
        uint256 withdrawPortion,
        address to
    )
        external
        view
        override
        returns (
            address withdrawAsset,
            uint256 withdrawBalance,
            MultiTransaction[] memory transactions
        )
    {
        require(withdrawPortion <= PORTION_DENOMINATOR, "Frgmnt: bad portion");
        require(to != address(0), "Frgmnt: to=0");

        // CertiK FNA-07 follow-up: never request more of any reserve than its aToken can
        // currently pay out — see _maxSafePortion's own documentation for why this must be one
        // uniform ceiling applied to both debt repayment and collateral withdrawal, not an
        // independent per-reserve cap. getWithdrawableBalance() already sized the caller's
        // requested withdrawPortion against this same ceiling at the NAV level; recomputing it
        // here (rather than trusting the caller) keeps this function correct on its own, exactly
        // matching live on-chain state at execution time.
        uint256 effectivePortion = withdrawPortion;
        {
            uint256 maxSafe = _maxSafePortion(pool);
            if (maxSafe < effectivePortion) effectivePortion = maxSafe;
        }

        (DebtRepayPlan[] memory repayPlans, uint256 debtAssetCount) = _collectDebtPlans(
            pool,
            effectivePortion
        );

        // No debt: withdraw collateral and transfer to user
        if (debtAssetCount == 0) {
            transactions = _withdrawCollateralAndTransfer(pool, effectivePortion, to);
            return (address(0), 0, transactions);
        }

        address settlementToken = _chooseSettlementToken(repayPlans);
        uint256 slippageBps = defaultSlippageBps;

        uint256 flashAmount = _estimateFlashAmountInSettlement(
            pool,
            repayPlans,
            settlementToken,
            slippageBps
        );

        // CertiK FNA-36 follow-up: getWithdrawableBalance()/_netRealizableBalance() only gate
        // whether the *100%*-position net-realizable value is zero (see FNA-35) — a thin-but-
        // positive 100% position doesn't guarantee this specific effectivePortion (which may
        // already be below the caller's requested withdrawPortion via the FNA-07 liquidity cap
        // above) is itself solvent once _mulPortionRoundUp's rounding, the route fee/slippage
        // tolerance and flashAmountBufferBps all apply to this portion's own repay amounts.
        // Verify the collateral being freed at effectivePortion actually covers the full
        // flashloan repayment obligation before committing to it; if not, fail closed for this
        // leg (the recommendation's explicit alternative) instead of planning an unwind that
        // reverts and, with it, the entire pro-rata withdrawal including every other healthy
        // asset's share. Compares collateral value directly against the total outlay rather than
        // routing through a subtracted "debt value": that term cancels out of the comparison
        // algebraically regardless of its exact composition (stable vs variable debt, which
        // _getBalance() and _collectDebtPlans() account for differently), so computing it here
        // would only reintroduce that same accounting question with no effect on the result.
        {
            uint256 premiumBps = uint256(IAaveV3Pool(aaveLendingPool).FLASHLOAN_PREMIUM_TOTAL());
            uint256 totalOutlaySettlement = flashAmount +
                (flashAmount * premiumBps) /
                BPS_DENOMINATOR;

            address factory = IPoolLogic(pool).factory();
            uint256 priceUsd = IHasAssetInfo(factory).getAssetPrice(settlementToken);
            uint256 decimals = IERC20Extended(settlementToken).decimals();
            uint256 totalOutlayUsd = (priceUsd * totalOutlaySettlement) / (10 ** decimals);

            (uint256 totalCollateralInUsd, ) = _getBalance(pool);
            uint256 collateralAtPortionUsd = (totalCollateralInUsd * effectivePortion) /
                PORTION_DENOMINATOR;

            if (collateralAtPortionUsd <= totalOutlayUsd) {
                return (address(0), 0, new MultiTransaction[](0));
            }
        }

        FlashloanParams memory fp;
        fp.withdrawPortion = effectivePortion;
        fp.settlementToken = settlementToken;
        fp.slippageBps = slippageBps;
        fp.repayPlans = repayPlans;

        transactions = new MultiTransaction[](1);
        transactions[0].to = aaveLendingPool;
        transactions[0].txData = _encodeFlashLoanTx(pool, settlementToken, flashAmount, fp);

        return (settlementToken, 0, transactions);
    }

    // ============================================================
    // Flashloan callback planner (IAaveLendingPoolAssetGuard)
    // ============================================================

    function flashloanProcessing(
        address pool,
        address repayAsset,
        uint256 repayAmount,
        uint256 premium,
        bytes calldata params
    ) external view override returns (MultiTransaction[] memory transactions) {
        FlashloanParams memory fp = abi.decode(params, (FlashloanParams));
        require(fp.settlementToken == repayAsset, "Frgmnt: settlement mismatch");

        return _flashloanProcessingInternal(pool, fp, repayAmount, premium);
    }

    function _flashloanProcessingInternal(
        address pool,
        FlashloanParams memory fp,
        uint256 repayAmount,
        uint256 premium
    ) internal view returns (MultiTransaction[] memory transactions) {
        // Phase 1 + Phase 2
        transactions = _buildSettlementToDebtSwaps(
            pool,
            fp.settlementToken,
            fp.repayPlans,
            fp.slippageBps
        );
        {
            MultiTransaction[] memory phase2 = _buildApproveAndRepayAllDebts(pool, fp.repayPlans);
            transactions = _concat2(transactions, phase2);
        }

        // Phase 3 + Phase 4
        {
            (
                MultiTransaction[] memory withdrawTxs,
                address[] memory collTokens,
                uint256[] memory collAmounts
            ) = _buildWithdrawCollateral(pool, fp.withdrawPortion);

            transactions = _concat2(transactions, withdrawTxs);

            MultiTransaction[] memory swapsBack = _buildCollateralToSettlementSwaps(
                pool,
                collTokens,
                collAmounts,
                fp.settlementToken,
                fp.slippageBps
            );

            transactions = _concat2(transactions, swapsBack);
        }

        // Phase 5
        {
            MultiTransaction[] memory phase5 = _buildFlashRepayApprove(
                fp.settlementToken,
                repayAmount + premium
            );
            transactions = _concat2(transactions, phase5);
        }
    }

    function _getBalance(
        address _pool
    ) internal view returns (uint256 totalCollateralInUsd, uint256 totalDebtInUsd) {
        IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(
            IPoolLogic(_pool).poolManagerLogic()
        ).getSupportedAssets();
        uint256 length = supportedAssets.length;

        address asset;
        uint256 decimals;
        uint256 tokenPriceInUsd;
        uint256 collateralBalance;
        uint256 debtBalance;
        address factory = IPoolLogic(_pool).factory();

        for (uint256 i; i < length; ++i) {
            asset = supportedAssets[i].asset;

            (collateralBalance, debtBalance) = _calculateAaveBalance(_pool, asset);

            if (collateralBalance != 0 || debtBalance != 0) {
                tokenPriceInUsd = IHasAssetInfo(factory).getAssetPrice(asset);
                decimals = IERC20Extended(asset).decimals();
                totalCollateralInUsd += (tokenPriceInUsd * collateralBalance) / (10 ** decimals);
                totalDebtInUsd += (tokenPriceInUsd * debtBalance) / (10 ** decimals);
            }
        }
    }

    function _calculateAaveBalance(
        address _pool,
        address _asset
    ) internal view returns (uint256 collateralBalance, uint256 debtBalance) {
        // Collateral: aToken balance
        address aToken = IAaveV3Pool(aaveLendingPool).getReserveAToken(_asset);
        if (aToken != address(0)) {
            collateralBalance = IERC20Extended(aToken).balanceOf(_pool);
        }

        // Debt: only variable debt
        address variableDebtToken = IAaveV3Pool(aaveLendingPool).getReserveVariableDebtToken(
            _asset
        );
        if (variableDebtToken != address(0)) {
            debtBalance = IERC20Extended(variableDebtToken).balanceOf(_pool);
        }
    }

    // ============================================================
    // INTERNALS
    // ============================================================

    function _encodeFlashLoanTx(
        address pool,
        address settlementToken,
        uint256 flashAmount,
        FlashloanParams memory fp
    ) internal pure returns (bytes memory txData) {
        address[] memory assets = new address[](1);
        assets[0] = settlementToken;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = flashAmount;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0;

        bytes memory params = abi.encode(fp);

        txData = abi.encodeWithSelector(
            IAaveV3Pool.flashLoan.selector,
            pool,
            assets,
            amounts,
            modes,
            pool,
            params,
            uint16(0)
        );
    }

    function _chooseSettlementToken(
        DebtRepayPlan[] memory repayPlans
    ) internal view returns (address) {
        address firstAsset;
        bool found;

        for (uint256 i = 0; i < repayPlans.length; ++i) {
            if (repayPlans[i].repayStableAmount + repayPlans[i].repayVariableAmount == 0) continue;

            address asset = repayPlans[i].underlyingAsset;

            if (!found) {
                firstAsset = asset;
                found = true;
            } else if (asset != firstAsset) {
                // Multiple different assets detected → fallback
                return preferredSettlementAsset;
            }
        }

        // If exactly one unique asset was found, use it.
        // If no debt exists, fallback.
        return found ? firstAsset : preferredSettlementAsset;
    }

    /**
     * @notice Collect pro-rata debt repayment plans based on the pool's supported assets list.
     * @dev IMPORTANT INVARIANT (DOCUMENTED):
     * - This guard only scans debts for assets returned by PoolManagerLogic.getSupportedAssets().
     * - Therefore, the protocol MUST enforce: "the pool never borrows outside supported assets".
     * - If the pool borrows an unsupported asset on Aave, this function will not include it in the repay plan,
     *   leading to incomplete debt repayment during withdrawals.
     *
     * If you want stronger safety, you can improve the debt discovery mechanism to scan all Aave reserves and
     * check stable/variable debt tokens for non-zero balances, but that requires iterating over all reserves
     * (potentially expensive) and having an accessor for the reserve list.
     */
    function _collectDebtPlans(
        address pool,
        uint256 withdrawPortion
    ) internal view returns (DebtRepayPlan[] memory plans, uint256 planCount) {
        IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(
            IPoolLogic(pool).poolManagerLogic()
        ).getSupportedAssets();

        plans = new DebtRepayPlan[](supportedAssets.length);

        for (uint256 i = 0; i < supportedAssets.length; ++i) {
            address underlying = supportedAssets[i].asset;

            (, address stableDebtToken, address variableDebtToken) = aaveProtocolDataProvider
                .getReserveTokensAddresses(underlying);

            uint256 stableDebtBalance =
                stableDebtToken == address(0) ? 0 : IERC20Extended(stableDebtToken).balanceOf(pool);
            uint256 variableDebtBalance =
                variableDebtToken == address(0)
                    ? 0
                    : IERC20Extended(variableDebtToken).balanceOf(pool);

            if (stableDebtBalance == 0 && variableDebtBalance == 0) continue;

            uint256 repayStable =
                stableDebtBalance == 0 ? 0 : _mulPortionRoundUp(stableDebtBalance, withdrawPortion);
            uint256 repayVariable =
                variableDebtBalance == 0
                    ? 0
                    : _mulPortionRoundUp(variableDebtBalance, withdrawPortion);

            if (repayStable == 0 && repayVariable == 0) continue;

            plans[planCount] = DebtRepayPlan({
                underlyingAsset: underlying,
                repayStableAmount: repayStable,
                repayVariableAmount: repayVariable
            });
            planCount++;
        }

        assembly {
            mstore(plans, planCount)
        }
    }

    function _mulPortionRoundUp(uint256 amount, uint256 portion) internal pure returns (uint256) {
        return (amount * portion + (PORTION_DENOMINATOR - 1)) / PORTION_DENOMINATOR;
    }

    function _estimateFlashAmountInSettlement(
        address pool,
        DebtRepayPlan[] memory repayPlans,
        address settlementToken,
        uint256 slippageBps
    ) internal view returns (uint256 flashAmount) {
        address factory = IPoolLogic(pool).factory();
        uint256 totalMaxIn;

        for (uint256 i = 0; i < repayPlans.length; ++i) {
            uint256 repayTotal =
                repayPlans[i].repayStableAmount + repayPlans[i].repayVariableAmount;
            if (repayTotal == 0) continue;

            // Skip swap logic if debt token is same as settlement token
            if (repayPlans[i].underlyingAsset == settlementToken) {
                // Only add repay amount
                totalMaxIn += repayTotal;
                continue;
            }

            // FNA-29: size the flash loan against the same fee assumption the actual
            // settlement->debt swap will be bound by (see _buildOneSettlementToDebtSwapTx),
            // not always the unrelated single-hop fallback fee — otherwise a configured
            // multi-hop route's true cost can exceed this estimate, under-sizing the flash
            // loan needed to cover the swap that same route will later require.
            uint24 fee = _routeFeeSettlementToDebt(
                settlementToken,
                repayPlans[i].underlyingAsset
            );

            totalMaxIn += _oracleMaxIn(
                factory,
                settlementToken,
                repayPlans[i].underlyingAsset,
                repayTotal,
                slippageBps,
                fee
            );
        }

        flashAmount = (totalMaxIn * (BPS_DENOMINATOR + flashAmountBufferBps)) / BPS_DENOMINATOR;
        require(flashAmount > 0, "Frgmnt: flash=0");
    }

    function _withdrawCollateralAndTransfer(
        address pool,
        uint256 withdrawPortion,
        address recipient
    ) internal view returns (MultiTransaction[] memory txs) {
        IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(
            IPoolLogic(pool).poolManagerLogic()
        ).getSupportedAssets();

        txs = new MultiTransaction[](supportedAssets.length * 2);
        uint256 txCount = 0;

        for (uint256 i = 0; i < supportedAssets.length; ++i) {
            address underlying = supportedAssets[i].asset;

            (address aToken, , ) = aaveProtocolDataProvider.getReserveTokensAddresses(underlying);
            if (aToken == address(0)) continue;

            uint256 aTokenBalance = IERC20Extended(aToken).balanceOf(pool);
            if (aTokenBalance == 0) continue;

            uint256 withdrawAmount = (aTokenBalance * withdrawPortion) / PORTION_DENOMINATOR;
            if (withdrawAmount == 0) continue;

            txs[txCount].to = aaveLendingPool;
            txs[txCount].txData = abi.encodeWithSelector(
                IAaveV3Pool.withdraw.selector,
                underlying,
                withdrawAmount,
                pool
            );
            txCount++;

            txs[txCount].to = underlying;
            txs[txCount].txData = abi.encodeWithSelector(
                IERC20Extended.transfer.selector,
                recipient,
                withdrawAmount
            );
            txCount++;
        }

        assembly {
            mstore(txs, txCount)
        }
    }

    // ============================================================
    // Stack-too-deep FIX 1: build one settle->debt swap tx in isolated scope
    // ============================================================

    function _buildOneSettlementToDebtSwapTx(
        address pool,
        address settlementToken,
        DebtRepayPlan memory plan,
        uint256 slippageBps
    ) internal view returns (bool ok, MultiTransaction memory t) {
        address debtToken = plan.underlyingAsset;
        if (debtToken == settlementToken) return (false, t);

        uint256 desiredDebtOut = plan.repayStableAmount + plan.repayVariableAmount;
        if (desiredDebtOut == 0) return (false, t);

        address factory = IPoolLogic(pool).factory();

        // FNA-29: derive the bound from the route actually selected below, not an
        // unrelated single-hop fallback fee — see _routeFeeSettlementToDebt.
        uint24 fee = _routeFeeSettlementToDebt(settlementToken, debtToken);

        uint256 maxSettlementIn = _oracleMaxIn(
            factory,
            settlementToken,
            debtToken,
            desiredDebtOut,
            slippageBps,
            fee
        );

        bytes memory reversedPath = uniV3PathExactOut[settlementToken][debtToken];
        if (reversedPath.length > 0) {
            t.to = swapRouter;
            t.txData = _encodeExactOutput(reversedPath, pool, desiredDebtOut, maxSettlementIn);
            return (true, t);
        }

        t.to = swapRouter;
        t.txData = _encodeExactOutputSingle(
            settlementToken,
            debtToken,
            fee,
            pool,
            desiredDebtOut,
            maxSettlementIn
        );
        return (true, t);
    }

    function _buildSettlementToDebtSwaps(
        address pool,
        address settlementToken,
        DebtRepayPlan[] memory repayPlans,
        uint256 slippageBps
    ) internal view returns (MultiTransaction[] memory txs) {
        txs = new MultiTransaction[](2 + repayPlans.length);
        uint256 n = 0;

        if (requiresApproveReset[settlementToken]) {
            txs[n].to = settlementToken;
            txs[n].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, swapRouter, 0);
            n++;
        }
        txs[n].to = settlementToken;
        txs[n].txData = abi.encodeWithSelector(
            IERC20Extended.approve.selector,
            swapRouter,
            type(uint256).max
        );
        n++;

        for (uint256 i = 0; i < repayPlans.length; ++i) {
            (bool ok, MultiTransaction memory mt) = _buildOneSettlementToDebtSwapTx(
                pool,
                settlementToken,
                repayPlans[i],
                slippageBps
            );

            if (!ok) continue;

            txs[n] = mt;
            n++;
        }

        assembly {
            mstore(txs, n)
        }
    }

    function _buildApproveAndRepayAllDebts(
        address pool,
        DebtRepayPlan[] memory repayPlans
    ) internal view returns (MultiTransaction[] memory txs) {
        txs = new MultiTransaction[](repayPlans.length * 4);
        uint256 n = 0;

        for (uint256 i = 0; i < repayPlans.length; ++i) {
            address debtToken = repayPlans[i].underlyingAsset;

            uint256 repayStable = repayPlans[i].repayStableAmount;
            uint256 repayVariable = repayPlans[i].repayVariableAmount;
            uint256 totalRepay = repayStable + repayVariable;

            if (totalRepay == 0) continue;

            if (requiresApproveReset[debtToken]) {
                txs[n].to = debtToken;
                txs[n].txData = abi.encodeWithSelector(
                    IERC20Extended.approve.selector,
                    aaveLendingPool,
                    0
                );
                n++;
            }

            txs[n].to = debtToken;
            txs[n].txData = abi.encodeWithSelector(
                IERC20Extended.approve.selector,
                aaveLendingPool,
                totalRepay
            );
            n++;

            if (repayStable > 0) {
                txs[n].to = aaveLendingPool;
                txs[n].txData = abi.encodeWithSelector(
                    IAaveV3Pool.repay.selector,
                    debtToken,
                    repayStable,
                    uint256(1),
                    pool
                );
                n++;
            }

            if (repayVariable > 0) {
                txs[n].to = aaveLendingPool;
                txs[n].txData = abi.encodeWithSelector(
                    IAaveV3Pool.repay.selector,
                    debtToken,
                    repayVariable,
                    uint256(2),
                    pool
                );
                n++;
            }
        }

        assembly {
            mstore(txs, n)
        }
    }

    function _buildWithdrawCollateral(
        address pool,
        uint256 withdrawPortion
    )
        internal
        view
        returns (
            MultiTransaction[] memory withdrawTxs,
            address[] memory collateralTokens,
            uint256[] memory collateralAmounts
        )
    {
        IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(
            IPoolLogic(pool).poolManagerLogic()
        ).getSupportedAssets();

        withdrawTxs = new MultiTransaction[](supportedAssets.length);
        collateralTokens = new address[](supportedAssets.length);
        collateralAmounts = new uint256[](supportedAssets.length);

        uint256 n = 0;

        for (uint256 i = 0; i < supportedAssets.length; ++i) {
            address underlying = supportedAssets[i].asset;

            (address aToken, , ) = aaveProtocolDataProvider.getReserveTokensAddresses(underlying);
            if (aToken == address(0)) continue;

            uint256 aTokenBalance = IERC20Extended(aToken).balanceOf(pool);
            if (aTokenBalance == 0) continue;

            uint256 withdrawAmount = (aTokenBalance * withdrawPortion) / PORTION_DENOMINATOR;
            if (withdrawAmount == 0) continue;

            withdrawTxs[n].to = aaveLendingPool;
            withdrawTxs[n].txData = abi.encodeWithSelector(
                IAaveV3Pool.withdraw.selector,
                underlying,
                withdrawAmount,
                pool
            );

            collateralTokens[n] = underlying;
            collateralAmounts[n] = withdrawAmount;
            n++;
        }

        assembly {
            mstore(withdrawTxs, n)
            mstore(collateralTokens, n)
            mstore(collateralAmounts, n)
        }
    }

    // ============================================================
    // Stack-too-deep FIX 2: build one collateral->settlement swap tx in isolated scope
    // ============================================================

    function _buildOneCollateralToSettlementSwapTx(
        address pool,
        address tokenIn,
        uint256 amountIn,
        address settlementToken,
        uint256 slippageBps
    ) internal view returns (bool ok, MultiTransaction memory t) {
        if (amountIn == 0) return (false, t);
        if (tokenIn == settlementToken) return (false, t);

        address factory = IPoolLogic(pool).factory();
        // FNA-29: derive the bound from the route actually selected below, not an
        // unrelated single-hop fallback fee — see _routeFeeCollateralToSettlement.
        uint24 fee = _routeFeeCollateralToSettlement(tokenIn, settlementToken);
        uint256 minOut = _oracleMinOut(
            factory,
            tokenIn,
            settlementToken,
            amountIn,
            slippageBps,
            fee
        );

        bytes memory forwardPath = uniV3PathExactIn[tokenIn][settlementToken];
        if (forwardPath.length > 0) {
            t.to = swapRouter;
            t.txData = _encodeExactInput(forwardPath, pool, amountIn, minOut);
            return (true, t);
        }

        t.to = swapRouter;
        t.txData = _encodeExactInputSingle(tokenIn, settlementToken, fee, pool, amountIn, minOut);
        return (true, t);
    }

    function _buildCollateralToSettlementSwaps(
        address pool,
        address[] memory collateralTokens,
        uint256[] memory collateralAmounts,
        address settlementToken,
        uint256 slippageBps
    ) internal view returns (MultiTransaction[] memory txs) {
        txs = new MultiTransaction[](collateralTokens.length * 3);
        uint256 n = 0;

        for (uint256 i = 0; i < collateralTokens.length; ++i) {
            address tokenIn = collateralTokens[i];
            uint256 amountIn = collateralAmounts[i];

            if (amountIn == 0) continue;
            if (tokenIn == settlementToken) continue;

            if (requiresApproveReset[tokenIn]) {
                txs[n].to = tokenIn;
                txs[n].txData = abi.encodeWithSelector(
                    IERC20Extended.approve.selector,
                    swapRouter,
                    0
                );
                n++;
            }

            txs[n].to = tokenIn;
            txs[n].txData = abi.encodeWithSelector(
                IERC20Extended.approve.selector,
                swapRouter,
                type(uint256).max
            );
            n++;

            (bool ok, MultiTransaction memory mt) = _buildOneCollateralToSettlementSwapTx(
                pool,
                tokenIn,
                amountIn,
                settlementToken,
                slippageBps
            );

            if (!ok) continue;

            txs[n] = mt;
            n++;
        }

        assembly {
            mstore(txs, n)
        }
    }

    function _buildFlashRepayApprove(
        address settlementToken,
        uint256 approveAmount
    ) internal view returns (MultiTransaction[] memory txs) {
        if (requiresApproveReset[settlementToken]) {
            txs = new MultiTransaction[](2);
            txs[0].to = settlementToken;
            txs[0].txData = abi.encodeWithSelector(
                IERC20Extended.approve.selector,
                aaveLendingPool,
                0
            );
            txs[1].to = settlementToken;
            txs[1].txData = abi.encodeWithSelector(
                IERC20Extended.approve.selector,
                aaveLendingPool,
                approveAmount
            );
        } else {
            txs = new MultiTransaction[](1);
            txs[0].to = settlementToken;
            txs[0].txData = abi.encodeWithSelector(
                IERC20Extended.approve.selector,
                aaveLendingPool,
                approveAmount
            );
        }
    }

    // ============================================================
    // FNA-29: route-derived swap-bound fees
    // ============================================================

    /// @dev Resolves the fee that should actually bound a collateral->settlement
    ///      exact-input swap: if a multi-hop uniV3PathExactIn route is configured for
    ///      this pair, decodes it (reverting unless its endpoints really are
    ///      tokenIn -> settlementToken) and returns the route's own aggregate fee;
    ///      otherwise falls back to the single-hop uniV3Fee. Previously the fallback
    ///      fee was used unconditionally to size amountOutMinimum even when a
    ///      materially different multi-hop route was the one actually executed,
    ///      so a route with zero price impact could still violate its own bound (or,
    ///      the other direction, the bound could permit more loss than the route
    ///      actually risks).
    function _routeFeeCollateralToSettlement(
        address tokenIn,
        address settlementToken
    ) internal view returns (uint24 fee) {
        bytes memory forwardPath = uniV3PathExactIn[tokenIn][settlementToken];
        if (forwardPath.length > 0) {
            (address pathIn, address pathOut, uint24 routeFee) = _decodeUniV3Path(forwardPath);
            require(
                pathIn == tokenIn && pathOut == settlementToken,
                "Frgmnt: path endpoints mismatch"
            );
            return routeFee;
        }

        fee = uniV3Fee[tokenIn][settlementToken];
        require(fee != 0, "Frgmnt: missing fee/path collateral->settle");
    }

    /// @dev Same as _routeFeeCollateralToSettlement, for the reversed settlement->debt
    ///      exactOutput route (an exactOutput path is encoded in reverse: first token =
    ///      the actual output/debtToken, last token = the actual input/settlementToken).
    ///      Shared by both the flash-amount estimate and the actual swap builder so the
    ///      loan is always sized against the same fee the swap it funds will be bound by.
    function _routeFeeSettlementToDebt(
        address settlementToken,
        address debtToken
    ) internal view returns (uint24 fee) {
        bytes memory reversedPath = uniV3PathExactOut[settlementToken][debtToken];
        if (reversedPath.length > 0) {
            (address pathOut, address pathIn, uint24 routeFee) = _decodeUniV3Path(reversedPath);
            require(
                pathOut == debtToken && pathIn == settlementToken,
                "Frgmnt: path endpoints mismatch"
            );
            return routeFee;
        }

        fee = uniV3Fee[settlementToken][debtToken];
        require(fee != 0, "Frgmnt: missing fee");
    }

    /// @dev Decodes a Uniswap V3 path (token0(20) | fee0(3) | token1(20) | fee1(3) | ... |
    ///      tokenM(20), already length-validated by _validateUniV3Path at setter time)
    ///      into its first and last token and the aggregate fee across every hop. Hop
    ///      fees compound multiplicatively, not additively — after M hops each taking
    ///      fee_i, the fraction of value surviving is the PRODUCT of (1 - fee_i) — so
    ///      this exactly matches what a real, zero-price-impact swap along the route
    ///      loses to LP fees. For a single-hop path (M=1) this reduces to that hop's own
    ///      fee, identical to the pre-fix single-hop behavior.
    function _decodeUniV3Path(
        bytes memory path
    ) internal pure returns (address firstToken, address lastToken, uint24 combinedFeePpm) {
        firstToken = _pathTokenAt(path, 0);
        lastToken = firstToken;

        uint256 survivingPpm = FEE_DENOMINATOR;
        uint256 offset = 20;
        while (offset + 23 <= path.length) {
            uint24 hopFee = _pathFeeAt(path, offset);
            survivingPpm = (survivingPpm * (FEE_DENOMINATOR - hopFee)) / FEE_DENOMINATOR;
            offset += 3;
            lastToken = _pathTokenAt(path, offset);
            offset += 20;
        }

        combinedFeePpm = uint24(FEE_DENOMINATOR - survivingPpm);
    }

    function _pathTokenAt(bytes memory path, uint256 offset) internal pure returns (address token) {
        assembly {
            token := shr(96, mload(add(add(path, 0x20), offset)))
        }
    }

    function _pathFeeAt(bytes memory path, uint256 offset) internal pure returns (uint24 fee) {
        assembly {
            fee := shr(232, mload(add(add(path, 0x20), offset)))
        }
    }

    function _oracleMinOut(
        address factory,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageBps,
        uint24 fee
    ) internal view returns (uint256) {
        uint256 priceInUsdD18 = IHasAssetInfo(factory).getAssetPrice(tokenIn);
        uint256 priceOutUsdD18 = IHasAssetInfo(factory).getAssetPrice(tokenOut);
        require(priceInUsdD18 != 0 && priceOutUsdD18 != 0, "Frgmnt: price=0");

        uint256 unitIn = 10 ** IERC20Extended(tokenIn).decimals();
        uint256 unitOut = 10 ** IERC20Extended(tokenOut).decimals();

        uint256 usdValueD18 = (amountIn * priceInUsdD18) / unitIn;
        uint256 expectedOut = (usdValueD18 * unitOut) / priceOutUsdD18;

        slippageBps = _effectiveSlippageExactIn(slippageBps, uint256(fee));

        return (expectedOut * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
    }

    function _oracleMaxIn(
        address factory,
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 slippageBps,
        uint24 fee
    ) internal view returns (uint256) {
        uint256 priceInUsdD18 = IHasAssetInfo(factory).getAssetPrice(tokenIn);
        uint256 priceOutUsdD18 = IHasAssetInfo(factory).getAssetPrice(tokenOut);
        require(priceInUsdD18 != 0 && priceOutUsdD18 != 0, "Frgmnt: price=0");

        uint256 unitIn = 10 ** IERC20Extended(tokenIn).decimals();
        uint256 unitOut = 10 ** IERC20Extended(tokenOut).decimals();

        uint256 usdValueD18 = (amountOut * priceOutUsdD18) / unitOut;
        uint256 expectedIn = (usdValueD18 * unitIn) / priceInUsdD18;

        slippageBps = _effectiveSlippageExactOut(slippageBps, uint256(fee));

        return (expectedIn * (BPS_DENOMINATOR + slippageBps)) / BPS_DENOMINATOR;
    }

    /// @notice FNA-49: effective slippage bound for _oracleMinOut (exact-input). The pool-fee
    ///         floor here is the direct fee fraction (fee / 1e6), not the exact-output gross-up
    ///         — receiving `out` after paying a `fee` cut on `usd` value costs `usd * fee`, not
    ///         `usd / (1 - fee)`. Composed (added) with the configured tolerance rather than
    ///         maxed against it, so the operator's own tolerance is never silently discarded by
    ///         a high-fee tier — the previous max()-based helper collapsed to just the fee floor
    ///         (~101bps at the 1% tier) whenever that floor exceeded the configured tolerance
    ///         (70bps by default), leaving ~1bps of real headroom on the forced settlement swap,
    ///         exactly where a legitimate settlement is most likely to revert.
    /// @dev Character-for-character identical to MorphoMathLib._effectiveSlippageExactIn() —
    ///      duplicated rather than shared to keep this fix minimal; see that function's own
    ///      docs for the full rationale.
    /// @param slippageBps Configured/requested slippage tolerance.
    /// @param fee Uniswap V3 pool fee (1e6 denominator).
    function _effectiveSlippageExactIn(
        uint256 slippageBps,
        uint256 fee
    ) internal pure returns (uint256) {
        uint256 feeBps = (fee * BPS_DENOMINATOR) / FEE_DENOMINATOR;
        return slippageBps + feeBps;
    }

    /// @notice FNA-49: effective slippage bound for _oracleMaxIn (exact-output). The gross-up
    ///         form (fee / (1 - fee)) is correct here — receiving a fixed `out` after a `fee`
    ///         cut requires sending `out / (1 - fee)` in, not `out * (1 + fee)`. Composed
    ///         (added) with the configured tolerance rather than maxed against it — see
    ///         _effectiveSlippageExactIn's own docs for why.
    /// @dev Character-for-character identical to MorphoMathLib._effectiveSlippageExactOut().
    /// @param slippageBps Configured/requested slippage tolerance.
    /// @param fee Uniswap V3 pool fee (1e6 denominator).
    function _effectiveSlippageExactOut(
        uint256 slippageBps,
        uint256 fee
    ) internal pure returns (uint256) {
        uint256 feeGrossUpBps = (fee * BPS_DENOMINATOR) / (FEE_DENOMINATOR - fee);
        return slippageBps + feeGrossUpBps;
    }

    // ============================================================
    // Swap encoders
    // ============================================================

    function _encodeExactOutput(
        bytes memory path,
        address recipient,
        uint256 amountOut,
        uint256 amountInMaximum
    ) internal pure returns (bytes memory) {
        IV3SwapRouter.ExactOutputParams memory p = IV3SwapRouter.ExactOutputParams({
            path: path,
            recipient: recipient,
            amountOut: amountOut,
            amountInMaximum: amountInMaximum
        });
        return abi.encodeWithSelector(IV3SwapRouter.exactOutput.selector, p);
    }

    function _encodeExactOutputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountOut,
        uint256 amountInMaximum
    ) internal pure returns (bytes memory) {
        IV3SwapRouter.ExactOutputSingleParams memory p = IV3SwapRouter.ExactOutputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: recipient,
            amountOut: amountOut,
            amountInMaximum: amountInMaximum,
            sqrtPriceLimitX96: 0
        });
        return abi.encodeWithSelector(IV3SwapRouter.exactOutputSingle.selector, p);
    }

    function _encodeExactInput(
        bytes memory path,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal pure returns (bytes memory) {
        IV3SwapRouter.ExactInputParams memory p = IV3SwapRouter.ExactInputParams({
            path: path,
            recipient: recipient,
            amountIn: amountIn,
            amountOutMinimum: amountOutMinimum
        });
        return abi.encodeWithSelector(IV3SwapRouter.exactInput.selector, p);
    }

    function _encodeExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal pure returns (bytes memory) {
        IV3SwapRouter.ExactInputSingleParams memory p = IV3SwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: recipient,
            amountIn: amountIn,
            amountOutMinimum: amountOutMinimum,
            sqrtPriceLimitX96: 0
        });
        return abi.encodeWithSelector(IV3SwapRouter.exactInputSingle.selector, p);
    }

    function _validateUniV3Path(bytes memory path) internal pure {
        // Uniswap V3 path format:
        // token0 (20 bytes) | fee0 (3 bytes) | token1 (20 bytes) | fee1 (3 bytes) | ... | tokenM (20 bytes)
        // length = 20 + 23*M, with M >= 1
        require(path.length >= 43, "Frgmnt: invalid uniV3 path length");
        require((path.length - 20) % 23 == 0, "Frgmnt: invalid uniV3 path length");
    }

    function _concat2(
        MultiTransaction[] memory x,
        MultiTransaction[] memory y
    ) internal pure returns (MultiTransaction[] memory out) {
        out = new MultiTransaction[](x.length + y.length);
        uint256 k = 0;
        for (uint256 i = 0; i < x.length; ++i) out[k++] = x[i];
        for (uint256 i = 0; i < y.length; ++i) out[k++] = y[i];
    }
}
