// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAaveProtocolDataProvider } from "../../interfaces/aave/IAaveProtocolDataProvider.sol";
import { IAaveV3Pool } from "../../interfaces/aave/v3/IAaveV3Pool.sol";
import { IAaveLendingPoolAssetGuard } from "../../interfaces/guards/IAaveLendingPoolAssetGuard.sol";
import { ISlippageCheckingGuard } from "../../interfaces/guards/ISlippageCheckingGuard.sol";
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
  ISlippageCheckingGuard
{
  // -----------------------------
  // Constants
  // -----------------------------

  uint256 private constant BPS_DENOMINATOR = 10_000;
  uint256 private constant PORTION_DENOMINATOR = 1e18;

  /// @notice USDT on Base mainnet (example address you provided)
  address public constant USDT_BASE = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;

  // -----------------------------
  // Types
  // -----------------------------

  struct DebtRepayPlan {
    address underlyingAsset;
    uint256 repayStableAmount;   // rateMode = 1
    uint256 repayVariableAmount; // rateMode = 2
  }

  struct FlashloanParams {
    uint256 withdrawPortion;     // 1e18
    address settlementToken;     // flash asset
    uint256 slippageBps;         // oracle slippage tolerance
    DebtRepayPlan[] repayPlans;  // pro-rata debts
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

  uint256 public defaultSlippageBps = 50;      // 0.50%
  uint256 public flashAmountBufferBps = 40;    // 0.40%

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
  event UniV3PathExactOutSet(address indexed tokenIn, address indexed tokenOut, bytes reversedPath);

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
    require(aaveProtocolDataProvider_ != address(0) && aaveLendingPool_ != address(0), "Frgmnt: invalid address");
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

  function setUniV3PathExactIn(address tokenIn, address tokenOut, bytes calldata path) external onlyOwner {
    require(tokenIn != address(0) && tokenOut != address(0), "Frgmnt: bad token");
    require(path.length > 0, "Frgmnt: empty path");
    uniV3PathExactIn[tokenIn][tokenOut] = path;
    emit UniV3PathExactInSet(tokenIn, tokenOut, path);
  }

  function setUniV3PathExactOut(address tokenIn, address tokenOut, bytes calldata reversedPath) external onlyOwner {
    require(tokenIn != address(0) && tokenOut != address(0), "Frgmnt: bad token");
    require(reversedPath.length > 0, "Frgmnt: empty path");
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

  function getBalance(address pool, address) public view override returns (uint256 balanceUsd18) {
    (
      uint256 totalCollateralBase,
      uint256 totalDebtBase,
      uint256 availableBorrowsBase,
      uint256 currentLiquidationThreshold,
      uint256 ltv,
      uint256 healthFactor
    ) = IAaveV3Pool(aaveLendingPool).getUserAccountData(pool);

    availableBorrowsBase; currentLiquidationThreshold; ltv; healthFactor;

    // NOTE: many Aave markets use base unit ~1e8; if yours differs, make configurable.
    if (totalCollateralBase > totalDebtBase) {
      balanceUsd18 = (totalCollateralBase - totalDebtBase) * 1e10;
    }
  }

  function getDecimals(address) external pure override returns (uint256) {
    return 18;
  }

  function removeAssetCheck(address pool, address) public view override {
    (
      uint256 totalCollateralBase,
      uint256 totalDebtBase,
      uint256 availableBorrowsBase,
      uint256 currentLiquidationThreshold,
      uint256 ltv,
      uint256 healthFactor
    ) = IAaveV3Pool(aaveLendingPool).getUserAccountData(pool);

    availableBorrowsBase; currentLiquidationThreshold; ltv; healthFactor;

    require(totalCollateralBase == 0 && totalDebtBase == 0, "Frgmnt: cannot remove non-empty Aave pos");
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
    returns (address withdrawAsset, uint256 withdrawBalance, MultiTransaction[] memory transactions)
  {
    require(withdrawPortion <= PORTION_DENOMINATOR, "Frgmnt: bad portion");
    require(to != address(0), "Frgmnt: to=0");

    (DebtRepayPlan[] memory repayPlans, uint256 debtAssetCount) = _collectDebtPlans(pool, withdrawPortion);

    // No debt: withdraw collateral and transfer to user
    if (debtAssetCount == 0) {
      transactions = _withdrawCollateralAndTransfer(pool, withdrawPortion, to);
      return (address(0), 0, transactions);
    }

    address settlementToken = _chooseSettlementToken(repayPlans);
    uint256 slippageBps = defaultSlippageBps;

    uint256 flashAmount = _estimateFlashAmountInSettlement(pool, repayPlans, settlementToken, slippageBps);

    FlashloanParams memory fp;
    fp.withdrawPortion = withdrawPortion;
    fp.settlementToken = settlementToken;
    fp.slippageBps = slippageBps;
    fp.repayPlans = repayPlans;

    // (Kept unchanged as requested)
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
    transactions = _buildSettlementToDebtSwaps(pool, fp.settlementToken, fp.repayPlans, fp.slippageBps);
    {
      MultiTransaction[] memory phase2 = _buildApproveAndRepayAllDebts(pool, fp.repayPlans);
      transactions = _concat2(transactions, phase2);
    }

    // Phase 3 + Phase 4
    {
      (MultiTransaction[] memory withdrawTxs, address[] memory collTokens, uint256[] memory collAmounts) =
        _buildWithdrawCollateral(pool, fp.withdrawPortion);

      transactions = _concat2(transactions, withdrawTxs);

      MultiTransaction[] memory swapsBack =
        _buildCollateralToSettlementSwaps(pool, collTokens, collAmounts, fp.settlementToken, fp.slippageBps);

      transactions = _concat2(transactions, swapsBack);
    }

    // Phase 5
    {
      MultiTransaction[] memory phase5 = _buildFlashRepayApprove(fp.settlementToken, repayAmount + premium);
      transactions = _concat2(transactions, phase5);
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
    // (Kept unchanged as requested)
    address[] memory assets;
    assets[0] = settlementToken;

    uint256[] memory amounts;
    amounts[0] = flashAmount;

    uint256[] memory modes;
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

  function _chooseSettlementToken(DebtRepayPlan[] memory repayPlans) internal view returns (address) {
    uint256 nonZeroDebtAssets = 0;
    address onlyDebtAsset = address(0);

    for (uint256 i = 0; i < repayPlans.length; ++i) {
      if (repayPlans[i].repayStableAmount + repayPlans[i].repayVariableAmount == 0) continue;
      nonZeroDebtAssets++;
      onlyDebtAsset = repayPlans[i].underlyingAsset;
      if (nonZeroDebtAssets > 1) break;
    }

    if (nonZeroDebtAssets == 1) return onlyDebtAsset;
    return preferredSettlementAsset;
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
    IHasSupportedAsset.Asset[] memory supportedAssets =
      IHasSupportedAsset(IPoolLogic(pool).poolManagerLogic()).getSupportedAssets();

    plans = new DebtRepayPlan[](supportedAssets.length);

    for (uint256 i = 0; i < supportedAssets.length; ++i) {
      address underlying = supportedAssets[i].asset;

      (, address stableDebtToken, address variableDebtToken) =
        aaveProtocolDataProvider.getReserveTokensAddresses(underlying);

      uint256 stableDebtBalance = stableDebtToken == address(0) ? 0 : IERC20Extended(stableDebtToken).balanceOf(pool);
      uint256 variableDebtBalance = variableDebtToken == address(0) ? 0 : IERC20Extended(variableDebtToken).balanceOf(pool);

      if (stableDebtBalance == 0 && variableDebtBalance == 0) continue;

      uint256 repayStable = stableDebtBalance == 0 ? 0 : _mulPortionRoundUp(stableDebtBalance, withdrawPortion);
      uint256 repayVariable = variableDebtBalance == 0 ? 0 : _mulPortionRoundUp(variableDebtBalance, withdrawPortion);

      if (repayStable == 0 && repayVariable == 0) continue;

      plans[planCount] = DebtRepayPlan({
        underlyingAsset: underlying,
        repayStableAmount: repayStable,
        repayVariableAmount: repayVariable
      });
      planCount++;
    }

    assembly { mstore(plans, planCount) }
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

    uint256 settlementPriceUsdD18 = IHasAssetInfo(factory).getAssetPrice(settlementToken);
    require(settlementPriceUsdD18 != 0, "Frgmnt: settlement price=0");

    uint256 settlementUnit = 10 ** IERC20Extended(settlementToken).decimals();
    uint256 totalUsdValueD18 = 0;

    for (uint256 i = 0; i < repayPlans.length; ++i) {
      uint256 repayTotal = repayPlans[i].repayStableAmount + repayPlans[i].repayVariableAmount;
      if (repayTotal == 0) continue;

      uint256 repayTokenPriceUsdD18 = IHasAssetInfo(factory).getAssetPrice(repayPlans[i].underlyingAsset);
      require(repayTokenPriceUsdD18 != 0, "Frgmnt: debt price=0");

      uint256 repayTokenUnit = 10 ** IERC20Extended(repayPlans[i].underlyingAsset).decimals();
      totalUsdValueD18 += (repayTotal * repayTokenPriceUsdD18) / repayTokenUnit;
    }

    uint256 settlementNeeded = (totalUsdValueD18 * settlementUnit) / settlementPriceUsdD18;
    uint256 totalBufferBps = slippageBps + flashAmountBufferBps;

    flashAmount = (settlementNeeded * (BPS_DENOMINATOR + totalBufferBps)) / BPS_DENOMINATOR;
    require(flashAmount > 0, "Frgmnt: flash=0");
  }

  function _withdrawCollateralAndTransfer(
    address pool,
    uint256 withdrawPortion,
    address recipient
  ) internal view returns (MultiTransaction[] memory txs) {
    IHasSupportedAsset.Asset[] memory supportedAssets =
      IHasSupportedAsset(IPoolLogic(pool).poolManagerLogic()).getSupportedAssets();

    txs = new MultiTransaction[](supportedAssets.length * 2);
    uint256 txCount = 0;

    for (uint256 i = 0; i < supportedAssets.length; ++i) {
      address underlying = supportedAssets[i].asset;

      (address aToken,,) = aaveProtocolDataProvider.getReserveTokensAddresses(underlying);
      if (aToken == address(0)) continue;

      uint256 aTokenBalance = IERC20Extended(aToken).balanceOf(pool);
      if (aTokenBalance == 0) continue;

      uint256 withdrawAmount = (aTokenBalance * withdrawPortion) / PORTION_DENOMINATOR;
      if (withdrawAmount == 0) continue;

      txs[txCount].to = aaveLendingPool;
      txs[txCount].txData = abi.encodeWithSelector(IAaveV3Pool.withdraw.selector, underlying, withdrawAmount, pool);
      txCount++;

      txs[txCount].to = underlying;
      txs[txCount].txData = abi.encodeWithSelector(IERC20Extended.transfer.selector, recipient, withdrawAmount);
      txCount++;
    }

    assembly { mstore(txs, txCount) }
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

    uint256 maxSettlementIn = _oracleMaxIn(factory, settlementToken, debtToken, desiredDebtOut, slippageBps);

    bytes memory reversedPath = uniV3PathExactOut[settlementToken][debtToken];
    if (reversedPath.length > 0) {
      t.to = swapRouter;
      t.txData = _encodeExactOutput(reversedPath, pool, desiredDebtOut, maxSettlementIn);
      return (true, t);
    }

    uint24 fee = uniV3Fee[settlementToken][debtToken];
    require(fee != 0, "Frgmnt: missing fee/path settle->debt");

    t.to = swapRouter;
    t.txData = _encodeExactOutputSingle(settlementToken, debtToken, fee, pool, desiredDebtOut, maxSettlementIn);
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
    txs[n].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, swapRouter, type(uint256).max);
    n++;

    for (uint256 i = 0; i < repayPlans.length; ++i) {
      (bool ok, MultiTransaction memory mt) =
        _buildOneSettlementToDebtSwapTx(pool, settlementToken, repayPlans[i], slippageBps);

      if (!ok) continue;

      txs[n] = mt;
      n++;
    }

    assembly { mstore(txs, n) }
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
        txs[n].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, aaveLendingPool, 0);
        n++;
      }

      txs[n].to = debtToken;
      txs[n].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, aaveLendingPool, totalRepay);
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

    assembly { mstore(txs, n) }
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
    IHasSupportedAsset.Asset[] memory supportedAssets =
      IHasSupportedAsset(IPoolLogic(pool).poolManagerLogic()).getSupportedAssets();

    withdrawTxs = new MultiTransaction[](supportedAssets.length);
    collateralTokens = new address[](supportedAssets.length);
    collateralAmounts = new uint256[](supportedAssets.length);

    uint256 n = 0;

    for (uint256 i = 0; i < supportedAssets.length; ++i) {
      address underlying = supportedAssets[i].asset;

      (address aToken,,) = aaveProtocolDataProvider.getReserveTokensAddresses(underlying);
      if (aToken == address(0)) continue;

      uint256 aTokenBalance = IERC20Extended(aToken).balanceOf(pool);
      if (aTokenBalance == 0) continue;

      uint256 withdrawAmount = (aTokenBalance * withdrawPortion) / PORTION_DENOMINATOR;
      if (withdrawAmount == 0) continue;

      withdrawTxs[n].to = aaveLendingPool;
      withdrawTxs[n].txData = abi.encodeWithSelector(IAaveV3Pool.withdraw.selector, underlying, withdrawAmount, pool);

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
    uint256 minOut = _oracleMinOut(factory, tokenIn, settlementToken, amountIn, slippageBps);

    bytes memory forwardPath = uniV3PathExactIn[tokenIn][settlementToken];
    if (forwardPath.length > 0) {
      t.to = swapRouter;
      t.txData = _encodeExactInput(forwardPath, pool, amountIn, minOut);
      return (true, t);
    }

    uint24 fee = uniV3Fee[tokenIn][settlementToken];
    require(fee != 0, "Frgmnt: missing fee/path collateral->settle");

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
        txs[n].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, swapRouter, 0);
        n++;
      }

      txs[n].to = tokenIn;
      txs[n].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, swapRouter, type(uint256).max);
      n++;

      (bool ok, MultiTransaction memory mt) =
        _buildOneCollateralToSettlementSwapTx(pool, tokenIn, amountIn, settlementToken, slippageBps);

      if (!ok) continue;

      txs[n] = mt;
      n++;
    }

    assembly { mstore(txs, n) }
  }

  function _buildFlashRepayApprove(address settlementToken, uint256 approveAmount)
    internal
    view
    returns (MultiTransaction[] memory txs)
  {
    // (Kept unchanged as requested)
    if (requiresApproveReset[settlementToken]) {
      txs[0].to = settlementToken;
      txs[0].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, aaveLendingPool, 0);
      txs[1].to = settlementToken;
      txs[1].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, aaveLendingPool, approveAmount);
    } else {
      txs[0].to = settlementToken;
      txs[0].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, aaveLendingPool, approveAmount);
    }
  }

  function _oracleMinOut(
    address factory,
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 slippageBps
  ) internal view returns (uint256) {
    uint256 priceInUsdD18 = IHasAssetInfo(factory).getAssetPrice(tokenIn);
    uint256 priceOutUsdD18 = IHasAssetInfo(factory).getAssetPrice(tokenOut);
    require(priceInUsdD18 != 0 && priceOutUsdD18 != 0, "Frgmnt: price=0");

    uint256 unitIn = 10 ** IERC20Extended(tokenIn).decimals();
    uint256 unitOut = 10 ** IERC20Extended(tokenOut).decimals();

    uint256 usdValueD18 = (amountIn * priceInUsdD18) / unitIn;
    uint256 expectedOut = (usdValueD18 * unitOut) / priceOutUsdD18;

    return (expectedOut * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
  }

  function _oracleMaxIn(
    address factory,
    address tokenIn,
    address tokenOut,
    uint256 amountOut,
    uint256 slippageBps
  ) internal view returns (uint256) {
    uint256 priceInUsdD18 = IHasAssetInfo(factory).getAssetPrice(tokenIn);
    uint256 priceOutUsdD18 = IHasAssetInfo(factory).getAssetPrice(tokenOut);
    require(priceInUsdD18 != 0 && priceOutUsdD18 != 0, "Frgmnt: price=0");

    uint256 unitIn = 10 ** IERC20Extended(tokenIn).decimals();
    uint256 unitOut = 10 ** IERC20Extended(tokenOut).decimals();

    uint256 usdValueD18 = (amountOut * priceOutUsdD18) / unitOut;
    uint256 expectedIn = (usdValueD18 * unitIn) / priceInUsdD18;

    return (expectedIn * (BPS_DENOMINATOR + slippageBps)) / BPS_DENOMINATOR;
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
