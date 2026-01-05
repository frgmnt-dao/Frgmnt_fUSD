// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { IMorpho, IMorphoBase, Id, MarketParams, Position, Market }
  from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";

import { IMorphoBlueLendingPoolAssetGuard }
  from "../../interfaces/guards/IMorphoBlueLendingPoolAssetGuard.sol";
import { IAssetGuard } from "../../interfaces/guards/IAssetGuard.sol";
import { ISlippageCheckingGuard } from "../../interfaces/guards/ISlippageCheckingGuard.sol";
import { IPoolLogic } from "../../interfaces/IPoolLogic.sol";
import { IERC20Extended } from "../../interfaces/IERC20Extended.sol";
import { IHasAssetInfo } from "../../interfaces/IHasAssetInfo.sol";
import { IV3SwapRouter } from "../../interfaces/IV3SwapRouter.sol";
import { ClosedAssetGuard } from "./ClosedAssetGuard.sol";

/*//////////////////////////////////////////////////////////////
                MORPHO BLUE LENDING POOL ASSET GUARD
//////////////////////////////////////////////////////////////*/

/// @title Morpho Blue Lending Pool Asset Guard
/// @notice dHEDGE-compatible AssetGuard for Morpho Blue
/// @dev
///  - Tracks explicit Morpho market Ids per pool
///  - Net balance = collateral + supply − debt (USD, 18 decimals)
///  - Withdrawals are pro-rata
///  - Uses Morpho flashloans to safely unwind debt
contract MorphoBlueLendingPoolAssetGuard is
  ClosedAssetGuard,
  IMorphoBlueLendingPoolAssetGuard,
  ISlippageCheckingGuard
{
  /*//////////////////////////////////////////////////////////////
                            CONSTANTS
  //////////////////////////////////////////////////////////////*/

  /// @dev 100% = 10_000 bps
  uint256 private constant BPS_DENOMINATOR = 10_000;

  /// @dev 100% withdraw = 1e18
  uint256 private constant PORTION_DENOMINATOR = 1e18;

  /// @notice Required flag for dHEDGE slippage guards
  bool public override isSlippageCheckingGuard = true;

  /*//////////////////////////////////////////////////////////////
                            IMMUTABLES
  //////////////////////////////////////////////////////////////*/

  /// @notice Morpho Blue core contract (stored as address)
  address public immutable morpho;

  /// @notice Uniswap V3 router used for swaps
  address public immutable swapRouter;

  /// @notice Default flashloan settlement asset
  address public immutable preferredSettlementAsset;

  /*//////////////////////////////////////////////////////////////
                            CONFIGURATION
  //////////////////////////////////////////////////////////////*/

  /// @notice Contract owner (admin only)
  address public owner;

  /// @notice Default slippage tolerance (bps)
  uint256 public defaultSlippageBps = 50; // 0.50%

  /// @notice Extra buffer added on flashloan amount
  uint256 public flashAmountBufferBps = 40; // 0.40%

  /// @notice Morpho market Ids used by each pool
  /// @dev Pools MUST NOT interact with Morpho markets outside this list
  mapping(address => Id[]) public poolMarkets;

  /// @notice Uniswap V3 fee tiers per token pair
  mapping(address => mapping(address => uint24)) public uniV3Fee;

  /// @notice Tokens requiring approve(0) before approve(amount)
  mapping(address => bool) public requiresApproveReset;

  /*//////////////////////////////////////////////////////////////
                            MODIFIERS
  //////////////////////////////////////////////////////////////*/

  /// @dev Restricts calls to the pool manager logic
  modifier onlyPoolManager(address pool) {
    require(
      msg.sender == IPoolLogic(pool).poolManagerLogic(),
      "MBAG: only pool manager"
    );
    _;
  }

  /*//////////////////////////////////////////////////////////////
                            STRUCTS
  //////////////////////////////////////////////////////////////*/

  /// @notice Debt repayment plan for a single Morpho market
  struct DebtPlan {
    Id id;                     // Market id
    MarketParams mp;           // Market parameters
    uint256 repayBorrowShares; // Borrow shares to repay (pro-rata)
    uint256 repayAssetsEst;    // Estimated asset amount required
  }

  /// @notice Supply withdrawal plan for a single Morpho market
  struct SupplyPlan {
    Id id;                        // Market id
    MarketParams mp;              // Market parameters
    uint256 withdrawSupplyShares; // Supply shares to withdraw
    uint256 withdrawAssetsEst;    // Estimated asset amount received
  }

  /// @notice Parameters forwarded through Morpho flashloan callback
  struct FlashloanParams {
    uint256 withdrawPortion; // Withdraw portion (1e18 = 100%)
    address settlementToken; // Flashloan asset
    uint256 slippageBps;     // Slippage tolerance
    DebtPlan[] debts;        // Debt plans
    SupplyPlan[] supplies;   // Supply plans
  }

  /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

  /// @param morpho_ Morpho Blue core contract
  /// @param swapRouter_ Uniswap V3 router
  /// @param preferredSettlementAsset_ Default flashloan token
  constructor(
    address morpho_,
    address swapRouter_,
    address preferredSettlementAsset_
  ) {
    require(morpho_ != address(0), "MBAG: morpho=0");
    require(swapRouter_ != address(0), "MBAG: router=0");
    require(preferredSettlementAsset_ != address(0), "MBAG: settlement=0");

    owner = msg.sender;
    morpho = morpho_;
    swapRouter = swapRouter_;
    preferredSettlementAsset = preferredSettlementAsset_;
  }

  /*//////////////////////////////////////////////////////////////
                        POOL CONFIGURATION
  //////////////////////////////////////////////////////////////*/

  /// @notice Sets the Morpho markets used by a pool
  /// @dev Must match exactly the markets used by strategies
  function setPoolMarkets(address pool, Id[] calldata markets)
    external
    onlyPoolManager(pool)
  {
    poolMarkets[pool] = markets;
  }

  /*//////////////////////////////////////////////////////////////
                        BALANCE LOGIC
  //////////////////////////////////////////////////////////////*/

  /// @notice Returns the pool's net USD exposure on Morpho
  /// @dev USD value is returned with 18 decimals
  function getBalance(address pool, address)
    public
    view
    override
    returns (uint256 balanceUsd18)
  {
    Id[] memory mids = poolMarkets[pool];
    address factory = IPoolLogic(pool).factory();

    for (uint256 i; i < mids.length; i++) {
      Position memory p = IMorpho(morpho).position(mids[i], pool);
      if (p.collateral == 0 && p.borrowShares == 0 && p.supplyShares == 0) continue;

      MarketParams memory mp = IMorpho(morpho).idToMarketParams(mids[i]);
      Market memory m = IMorpho(morpho).market(mids[i]);

      // Collateral increases balance
      if (p.collateral > 0) {
        uint256 price = IHasAssetInfo(factory).getAssetPrice(mp.collateralToken);
        uint256 unit = 10 ** IERC20Extended(mp.collateralToken).decimals();
        balanceUsd18 += (uint256(p.collateral) * price) / unit;
      }

      // Supplied assets increase balance
      if (p.supplyShares > 0) {
        uint256 assets =
          _sharesToAssetsDown(p.supplyShares, m.totalSupplyAssets, m.totalSupplyShares);
        uint256 price = IHasAssetInfo(factory).getAssetPrice(mp.loanToken);
        uint256 unit = 10 ** IERC20Extended(mp.loanToken).decimals();
        balanceUsd18 += (assets * price) / unit;
      }

      // Borrowed assets decrease balance
      if (p.borrowShares > 0) {
        uint256 assets =
          _sharesToAssetsUp(p.borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
        uint256 price = IHasAssetInfo(factory).getAssetPrice(mp.loanToken);
        uint256 unit = 10 ** IERC20Extended(mp.loanToken).decimals();
        balanceUsd18 -= (assets * price) / unit;
      }
    }
  }

  /// @notice AssetGuard balances are always expressed in USD (18 decimals)
  function getDecimals(address) external pure override returns (uint256) {
    return 18;
  }

  /// @notice Ensures no open Morpho position exists before asset removal
  function removeAssetCheck(address pool, address) public view override {
    Id[] memory mids = poolMarkets[pool];
    for (uint256 i; i < mids.length; i++) {
      Position memory p = IMorpho(morpho).position(mids[i], pool);
      require(
        p.collateral == 0 &&
        p.borrowShares == 0 &&
        p.supplyShares == 0,
        "MBAG: position not empty"
      );
    }
  }

  /*//////////////////////////////////////////////////////////////
                      WITHDRAW PROCESSING
  //////////////////////////////////////////////////////////////*/

  /// @notice Builds a deterministic withdrawal execution plan
  /// @dev Called by PoolLogic before executing withdrawal
  function withdrawProcessing(
    address pool,
    address,
    uint256 withdrawPortion,
    address to
  )
    external
    view
    override
    returns (address, uint256, MultiTransaction[] memory txs)
  {
    require(withdrawPortion <= PORTION_DENOMINATOR, "MBAG: bad portion");
    require(to != address(0), "MBAG: to=0");

    // Collect debt and supply plans
    (DebtPlan[] memory debts, bool hasDebt) =
      _collectDebts(pool, withdrawPortion);
    SupplyPlan[] memory supplies =
      _collectSupplies(pool, withdrawPortion);

    // No debt → direct withdraw
    if (!hasDebt) {
      txs = _withdrawNoDebt(pool, supplies, to);
      return (address(0), 0, txs);
    }

    // Debt exists → flashloan unwind
    address settlementToken = _chooseSettlementToken(debts);
    uint256 flashAmount =
      _estimateFlashAmount(pool, debts, settlementToken, defaultSlippageBps);

    FlashloanParams memory fp = FlashloanParams({
      withdrawPortion: withdrawPortion,
      settlementToken: settlementToken,
      slippageBps: defaultSlippageBps,
      debts: debts,
      supplies: supplies
    });

    txs[0].to = morpho;
    txs[0].txData = abi.encodeWithSelector(
      IMorphoBase.flashLoan.selector,
      settlementToken,
      flashAmount,
      abi.encode(fp)
    );

    return (settlementToken, 0, txs);
  }

  /*//////////////////////////////////////////////////////////////
                    FLASHLOAN CALLBACK
  //////////////////////////////////////////////////////////////*/

  /// @notice Builds the execution plan after receiving a flashloan
  function flashloanProcessing(
    address pool,
    address repayAsset,
    uint256 repayAmount,
    bytes calldata params
  )
    external
    view
    override
    returns (MultiTransaction[] memory out)
  {
    FlashloanParams memory fp = abi.decode(params, (FlashloanParams));
    require(fp.settlementToken == repayAsset, "MBAG: settlement mismatch");

    MultiTransaction[] memory p1 = _swapSettlementToDebts(pool, fp);
    MultiTransaction[] memory p2 = _repayDebts(pool, fp.debts);

    (
      MultiTransaction[] memory p3,
      address[] memory tokens,
      uint256[] memory amounts
    ) = _withdrawAllAssets(pool, fp);

    MultiTransaction[] memory p4 =
      _swapAssetsToSettlement(pool, tokens, amounts, fp);

    MultiTransaction[] memory p5 =
      _approveFlashRepay(fp.settlementToken, repayAmount);

    out = _concat5(p1, p2, p3, p4, p5);
  }
  /*//////////////////////////////////////////////////////////////
                    DEBT COLLECTION
  //////////////////////////////////////////////////////////////*/

  /// @notice Builds pro-rata debt repayment plans
  function _collectDebts(address pool, uint256 portion)
    internal
    view
    returns (DebtPlan[] memory plans, bool hasDebt)
  {
    Id[] memory mids = poolMarkets[pool];
    plans = new DebtPlan[](mids.length);

    uint256 n;
    for (uint256 i; i < mids.length; i++) {
      Position memory p = IMorpho(morpho).position(mids[i], pool);
      if (p.borrowShares == 0) continue;

      uint256 repayShares =
        _mulPortionRoundUp(p.borrowShares, portion);

      MarketParams memory mp = IMorpho(morpho).idToMarketParams(mids[i]);
      Market memory m = IMorpho(morpho).market(mids[i]);

      uint256 repayAssets =
        _sharesToAssetsUp(
          repayShares,
          m.totalBorrowAssets,
          m.totalBorrowShares
        );

      plans[n++] = DebtPlan({
        id: mids[i],
        mp: mp,
        repayBorrowShares: repayShares,
        repayAssetsEst: repayAssets
      });
      hasDebt = true;
    }

    assembly { mstore(plans, n) }
  }

  /// @notice Builds pro-rata supply withdrawal plans
  function _collectSupplies(address pool, uint256 portion)
    internal
    view
    returns (SupplyPlan[] memory plans)
  {
    Id[] memory mids = poolMarkets[pool];
    plans = new SupplyPlan[](mids.length);

    uint256 n;
    for (uint256 i; i < mids.length; i++) {
      Position memory p = IMorpho(morpho).position(mids[i], pool);
      if (p.supplyShares == 0) continue;

      uint256 shares =
        _mulPortionRoundUp(p.supplyShares, portion);

      MarketParams memory mp = IMorpho(morpho).idToMarketParams(mids[i]);
      Market memory m = IMorpho(morpho).market(mids[i]);

      uint256 assets =
        _sharesToAssetsDown(
          shares,
          m.totalSupplyAssets,
          m.totalSupplyShares
        );

      plans[n++] = SupplyPlan({
        id: mids[i],
        mp: mp,
        withdrawSupplyShares: shares,
        withdrawAssetsEst: assets
      });
    }

    assembly { mstore(plans, n) }
  }

  /// @notice Withdraws supplies directly when no debt exists
  function _withdrawNoDebt(
    address pool,
    SupplyPlan[] memory supplies,
    address to
  ) internal view returns (MultiTransaction[] memory txs) {
    txs = new MultiTransaction[](supplies.length);
    uint256 n;

    for (uint256 i; i < supplies.length; i++) {
      if (supplies[i].withdrawSupplyShares == 0) continue;

      txs[n].to = morpho;
      txs[n++].txData = abi.encodeWithSelector(
        IMorphoBase.withdraw.selector,
        supplies[i].mp,
        uint256(0),
        supplies[i].withdrawSupplyShares,
        pool,
        to
      );
    }

    assembly { mstore(txs, n) }
  }

  /// @notice Chooses the optimal settlement token
  function _chooseSettlementToken(DebtPlan[] memory debts)
    internal
    view
    returns (address)
  {
    address only;
    uint256 count;

    for (uint256 i; i < debts.length; i++) {
      if (debts[i].repayAssetsEst == 0) continue;
      only = debts[i].mp.loanToken;
      count++;
      if (count > 1) break;
    }

    return count == 1 ? only : preferredSettlementAsset;
  }

  /// @notice Estimates flashloan amount required to repay all debts
  function _estimateFlashAmount(
    address pool,
    DebtPlan[] memory debts,
    address settlement,
    uint256 slippageBps
  ) internal view returns (uint256 amt) {
    address factory = IPoolLogic(pool).factory();
    uint256 priceSettle = IHasAssetInfo(factory).getAssetPrice(settlement);
    uint256 unitSettle = 10 ** IERC20Extended(settlement).decimals();

    uint256 usd;
    for (uint256 i; i < debts.length; i++) {
      if (debts[i].repayAssetsEst == 0) continue;
      uint256 price =
        IHasAssetInfo(factory).getAssetPrice(debts[i].mp.loanToken);
      uint256 unit =
        10 ** IERC20Extended(debts[i].mp.loanToken).decimals();
      usd += (debts[i].repayAssetsEst * price) / unit;
    }

    uint256 raw = (usd * unitSettle) / priceSettle;
    amt =
      (raw * (BPS_DENOMINATOR + slippageBps + flashAmountBufferBps)) /
      BPS_DENOMINATOR;
  }

  /// @notice Swaps settlement asset into debt tokens
  function _swapSettlementToDebts(
    address pool,
    FlashloanParams memory fp
  ) internal view returns (MultiTransaction[] memory txs) {
    txs = new MultiTransaction[](fp.debts.length);
    uint256 n;

    for (uint256 i; i < fp.debts.length; i++) {
      DebtPlan memory d = fp.debts[i];
      if (d.repayAssetsEst == 0) continue;
      if (d.mp.loanToken == fp.settlementToken) continue;

      uint256 maxIn =
        _oracleMaxIn(
          IPoolLogic(pool).factory(),
          fp.settlementToken,
          d.mp.loanToken,
          d.repayAssetsEst,
          fp.slippageBps
        );

      txs[n].to = swapRouter;
      txs[n++].txData = abi.encodeWithSelector(
        IV3SwapRouter.exactOutputSingle.selector,
        IV3SwapRouter.ExactOutputSingleParams({
          tokenIn: fp.settlementToken,
          tokenOut: d.mp.loanToken,
          fee: uniV3Fee[fp.settlementToken][d.mp.loanToken],
          recipient: pool,
          amountOut: d.repayAssetsEst,
          amountInMaximum: maxIn,
          sqrtPriceLimitX96: 0
        })
      );
    }

    assembly { mstore(txs, n) }
  }

  /// @notice Repays all Morpho debts
  function _repayDebts(
    address pool,
    DebtPlan[] memory debts
  ) internal view returns (MultiTransaction[] memory txs) {
    txs = new MultiTransaction[](debts.length);
    uint256 n;

    for (uint256 i; i < debts.length; i++) {
      if (debts[i].repayBorrowShares == 0) continue;

      txs[n].to = morpho;
      txs[n++].txData = abi.encodeWithSelector(
        IMorphoBase.repay.selector,
        debts[i].mp,
        debts[i].repayAssetsEst,
        debts[i].repayBorrowShares,
        pool,
        pool
      );
    }

    assembly { mstore(txs, n) }
  }

  /// @notice Withdraws all supplies after debts are repaid
  function _withdrawAllAssets(
    address pool,
    FlashloanParams memory fp
  )
    internal
    view
    returns (
      MultiTransaction[] memory txs,
      address[] memory tokens,
      uint256[] memory amounts
    )
  {
    txs = new MultiTransaction[](fp.supplies.length);
    tokens = new address[](fp.supplies.length);
    amounts = new uint256[](fp.supplies.length);

    uint256 n;
    for (uint256 i; i < fp.supplies.length; i++) {
      SupplyPlan memory s = fp.supplies[i];
      if (s.withdrawSupplyShares == 0) continue;

      txs[n].to = morpho;
      txs[n].txData = abi.encodeWithSelector(
        IMorphoBase.withdraw.selector,
        s.mp,
        uint256(0),
        s.withdrawSupplyShares,
        pool,
        pool
      );

      tokens[n] = s.mp.loanToken;
      amounts[n] = s.withdrawAssetsEst;
      n++;
    }

    assembly {
      mstore(txs, n)
      mstore(tokens, n)
      mstore(amounts, n)
    }
  }

  /// @notice Swaps withdrawn assets back to settlement token
  function _swapAssetsToSettlement(
    address pool,
    address[] memory tokens,
    uint256[] memory amounts,
    FlashloanParams memory fp
  ) internal view returns (MultiTransaction[] memory txs) {
    txs = new MultiTransaction[](tokens.length);
    uint256 n;

    for (uint256 i; i < tokens.length; i++) {
      if (tokens[i] == fp.settlementToken || amounts[i] == 0) continue;

      uint256 minOut =
        _oracleMinOut(
          IPoolLogic(pool).factory(),
          tokens[i],
          fp.settlementToken,
          amounts[i],
          fp.slippageBps
        );

      txs[n].to = swapRouter;
      txs[n++].txData = abi.encodeWithSelector(
        IV3SwapRouter.exactInputSingle.selector,
        IV3SwapRouter.ExactInputSingleParams({
          tokenIn: tokens[i],
          tokenOut: fp.settlementToken,
          fee: uniV3Fee[tokens[i]][fp.settlementToken],
          recipient: pool,
          amountIn: amounts[i],
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0
        })
      );
    }

    assembly { mstore(txs, n) }
  }

  /// @notice Approves Morpho to pull flashloan repayment
  function _approveFlashRepay(address token, uint256 amount)
    internal
    view
    returns (MultiTransaction[] memory txs)
  {
    txs[0].to = token;
    txs[0].txData = abi.encodeWithSelector(
      IERC20Extended.approve.selector,
      morpho,
      amount
    );
  }

  /*//////////////////////////////////////////////////////////////
                    ORACLE & MATH HELPERS
  //////////////////////////////////////////////////////////////*/

  function _oracleMinOut(
    address factory,
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 slippageBps
  ) internal view returns (uint256) {
    uint256 pIn = IHasAssetInfo(factory).getAssetPrice(tokenIn);
    uint256 pOut = IHasAssetInfo(factory).getAssetPrice(tokenOut);
    uint256 uIn = 10 ** IERC20Extended(tokenIn).decimals();
    uint256 uOut = 10 ** IERC20Extended(tokenOut).decimals();

    uint256 usd = (amountIn * pIn) / uIn;
    uint256 out = (usd * uOut) / pOut;
    return (out * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
  }

  function _oracleMaxIn(
    address factory,
    address tokenIn,
    address tokenOut,
    uint256 amountOut,
    uint256 slippageBps
  ) internal view returns (uint256) {
    uint256 pIn = IHasAssetInfo(factory).getAssetPrice(tokenIn);
    uint256 pOut = IHasAssetInfo(factory).getAssetPrice(tokenOut);
    uint256 uIn = 10 ** IERC20Extended(tokenIn).decimals();
    uint256 uOut = 10 ** IERC20Extended(tokenOut).decimals();

    uint256 usd = (amountOut * pOut) / uOut;
    uint256 inAmt = (usd * uIn) / pIn;
    return (inAmt * (BPS_DENOMINATOR + slippageBps)) / BPS_DENOMINATOR;
  }

  function _concat5(
    MultiTransaction[] memory a,
    MultiTransaction[] memory b,
    MultiTransaction[] memory c,
    MultiTransaction[] memory d,
    MultiTransaction[] memory e
  ) internal pure returns (MultiTransaction[] memory out) {
    out = new MultiTransaction[](a.length + b.length + c.length + d.length + e.length);
    uint256 k;
    for (uint256 i; i < a.length; i++) out[k++] = a[i];
    for (uint256 i; i < b.length; i++) out[k++] = b[i];
    for (uint256 i; i < c.length; i++) out[k++] = c[i];
    for (uint256 i; i < d.length; i++) out[k++] = d[i];
    for (uint256 i; i < e.length; i++) out[k++] = e[i];
  }

  function _sharesToAssetsUp(uint256 s, uint256 a, uint256 t)
    internal pure returns (uint256)
  {
    if (s == 0 || t == 0) return 0;
    return (s * a + t - 1) / t;
  }

  function _sharesToAssetsDown(uint256 s, uint256 a, uint256 t)
    internal pure returns (uint256)
  {
    if (s == 0 || t == 0) return 0;
    return (s * a) / t;
  }

  function _mulPortionRoundUp(uint256 x, uint256 p)
    internal pure returns (uint256)
  {
    return (x * p + PORTION_DENOMINATOR - 1) / PORTION_DENOMINATOR;
  }
}
