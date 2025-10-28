// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {IFlashLoanReceiver} from "./interfaces/aave/IFlashLoanReceiver.sol";
import {IAaveLendingPoolAssetGuard} from "./interfaces/guards/IAaveLendingPoolAssetGuard.sol";
import {IAssetGuard} from "./interfaces/guards/IAssetGuard.sol";
import {IERC721VerifyingGuard} from "./interfaces/guards/IERC721VerifyingGuard.sol";
import {IGuard} from "./interfaces/guards/IGuard.sol";
import {IComplexAssetGuard} from "./interfaces/guards/IComplexAssetGuard.sol";
import {ITxTrackingGuard} from "./interfaces/guards/ITxTrackingGuard.sol";
import {IGovernance} from "./interfaces/IGovernance.sol";
import {IHasDaoInfo} from "./interfaces/IHasDaoInfo.sol";
import {IHasFeeInfo} from "./interfaces/IHasFeeInfo.sol";
import {IHasGuardInfo} from "./interfaces/IHasGuardInfo.sol";
import {IHasOwnable} from "./interfaces/IHasOwnable.sol";
import {IHasPausable} from "./interfaces/IHasPausable.sol";
import {IHasSupportedAsset} from "./interfaces/IHasSupportedAsset.sol";
import {IManaged} from "./interfaces/IManaged.sol";
import {IPoolFactory} from "./interfaces/IPoolFactory.sol";
import {IPoolLogic} from "./interfaces/IPoolLogic.sol";
import {IPoolManagerLogic} from "./interfaces/IPoolManagerLogic.sol";
import {AddressHelper} from "./utils/AddressHelper.sol";

/// @title SFUSD — Pool shares + staking yield + optional withdrawal queue (upgradeable)
/// @notice Pool token with PoolLogic features, but no generic deposit(). Users stake FUSD and receive SFUSD.
///         Yield accrues from tokenPrice growth; users can harvest FUSD. Immediate withdrawal (PoolLogic) or queued.
contract SFUSD is
  ERC20Upgradeable,
  ReentrancyGuardUpgradeable,
  IERC721Receiver,
  IFlashLoanReceiver
{
  using AddressHelper for address;

  // =========================
  //          TYPES
  // =========================

  struct FundSummary {
    string name;
    uint256 totalSupply;
    uint256 totalFundValue;
    address manager;
    string managerName;
    uint256 creationTime;
    bool privatePool;
    uint256 performanceFeeNumerator;
    uint256 managerFeeNumerator;
    uint256 managerFeeDenominator;
    uint256 exitFeeNumerator;
    uint256 exitFeeDenominator;
    uint256 entryFeeNumerator;
  }

  struct TxToExecute {
    address to;
    bytes data;
  }

  struct WithdrawnAsset {
    address asset;
    uint256 amount;
    bool externalWithdrawProcessed;
  }

  struct WithdrawProcessing {
    uint256 portionBalance;
    uint256 expectedWithdrawValue;
    bool regularProcessingUsed;
    address guard;
  }

  struct WithdrawExecution {
    uint256 supplyAfterBurn;
    uint256 fundValue;
    uint256 feesMinted;
  }

  // Staking yield accounting
  struct UserYield {
    uint256 rewardDebt;   // user’s last yieldPerShare checkpoint
    uint256 claimable;    // accrued FUSD rewards pending harvest
  }

  // Lido-like queue
  enum WithdrawMode { Immediate, Queued }

  struct WithdrawalRequest {
    address owner;
    uint256 sharesLocked;
    uint256 requestedAt;
    bool    finalized;
    uint256 fusdAmount;
    bool    claimed;
  }

  // =========================
  //          EVENTS
  // =========================

  event Stake(address indexed user, uint256 fusdAmount, uint256 mintedShares, uint256 entryFeeShares);
  event Unstake(address indexed user, uint256 fusdAmount, uint256 burnedShares, uint256 exitFeeShares);
  event Harvest(address indexed user, uint256 fusdAmount);

  event Withdrawal(
    address fundAddress,
    address investor,
    uint256 valueWithdrawn,
    uint256 fundTokensWithdrawn,
    uint256 totalInvestorFundTokens,
    uint256 fundValue,
    uint256 totalSupply,
    WithdrawnAsset[] withdrawnAssets,
    uint256 time
  );

  event TransactionExecuted(address pool, address manager, uint16 transactionType, uint256 time);
  event PoolPrivacyUpdated(bool isPoolPrivate);

  event ManagerFeeMinted(
    address pool,
    address manager,
    uint256 available,
    uint256 daoFee,
    uint256 managerFee,
    uint256 tokenPriceAtLastFeeMint
  );

  event PoolManagerLogicSet(address poolManagerLogic, address from);
  event EntryFeeMinted(address manager, uint256 entryFeeAmount);
  event ExitFeeMinted(address manager, uint256 exitFeeAmount);

  // Withdrawal queue events
  event WithdrawModeChanged(WithdrawMode mode);
  event WithdrawRequested(uint256 indexed requestId, address indexed user, uint256 sharesLocked, uint256 exitFeeShares);
  event WithdrawFinalized(uint256 indexed requestId, uint256 fusdAmount);
  event WithdrawClaimed(uint256 indexed requestId, address indexed user, uint256 fusdAmount);

  // =========================
  //   STATE (order preserved)
  // =========================

  bool public privatePool;
  address public creator;
  uint256 public creationTime;
  address public factory;
  uint256 public tokenPriceAtLastFeeMint;
  mapping(address => uint256) public lastDeposit;
  address public poolManagerLogic;
  mapping(address => uint256) public lastWhitelistTransfer;
  uint256 public lastFeeMintTime;
  mapping(address => uint256) public lastExitCooldown;

  // Staking config & accounting
  address public fusd;                 // staking asset (FUSD)
  uint256 public yieldPerShare;        // FUSD per share (scaled 1e18)
  uint256 public lastTokenPriceForYield; // track price for yield accrual (1e18)
  mapping(address => UserYield) public userYields;

  // Withdrawal queue
  WithdrawMode public withdrawMode;
  uint256 public lastRequestId;
  mapping(uint256 => WithdrawalRequest) public withdrawalRequests;
  mapping(address => uint256[]) public requestsByUser;

  // =========================
  //        MODIFIERS
  // =========================

  modifier whenNotFactoryPaused() {
    require(!IHasPausable(factory).isPaused(), "contracts paused");
    _;
  }

  modifier whenNotPaused() {
    require(!IHasPausable(factory).pausedPools(address(this)), "pool paused");
    _;
  }

  /// @dev On every user touch, mint manager fees (PoolLogic) and roll yieldPerShare based on token price growth,
  ///      then accrue the caller’s personal claimable rewards before changing balances.
  modifier updateFeesAndYieldFor(address account) {
    _updateFeesAndYieldInternal(account);
    _;
  }

  // =========================
  //      INITIALIZATION
  // =========================

  function initialize(
    address _factory,
    bool _privatePool,
    string memory _name,
    string memory _symbol,
    address _fusd
  ) external initializer {
    __ERC20_init(_name, _symbol);
    __ReentrancyGuard_init();

    require(_factory != address(0) && _fusd != address(0), "invalid init");
    factory = _factory;
    privatePool = _privatePool;
    creator = msg.sender;
    creationTime = block.timestamp;

    fusd = _fusd;

    lastFeeMintTime = block.timestamp;
    tokenPriceAtLastFeeMint = 1e18;
    lastTokenPriceForYield = 1e18;

    withdrawMode = WithdrawMode.Immediate;
  }

  // =========================
  //   TOKEN UPDATE HOOK (OZ v5)
  // =========================

  /// @dev Replaces _beforeTokenTransfer in OZ v5. Applies only on transfers (not mint/burn).
  function _update(address from, address to, uint256 value) internal virtual override {
    // pause checks
    require(!IHasPausable(factory).isPaused(), "contracts paused");
    require(!IHasPausable(factory).pausedPools(address(this)), "pool paused");

    // only for real transfers (not mint/burn)
    if (from != address(0) && to != address(0)) {
      if (!IPoolFactory(factory).receiverWhitelist(to)) {
        require(getExitRemainingCooldown(from) == 0, "cooldown active");
      }
    }

    super._update(from, to, value);
  }

  // =========================
  //        PRIVACY
  // =========================

  function setPoolPrivate(bool _privatePool) external {
    require(msg.sender == _manager(), "only manager");
    privatePool = _privatePool;
    emit PoolPrivacyUpdated(_privatePool);
    _emitFactoryEvent();
  }

  // =========================
  //         STAKING
  // =========================

  function stake(uint256 amountFusd)
    external
    nonReentrant
    whenNotFactoryPaused
    whenNotPaused
    updateFeesAndYieldFor(msg.sender)
  {
    require(amountFusd > 0, "zero amount");
    require(_isMemberAllowed(msg.sender) || !privatePool || msg.sender == _manager(), "only members");
    require(IPoolManagerLogic(poolManagerLogic).isDepositAsset(fusd), "unsupported asset");

    // Pull FUSD
    fusd.tryAssemblyCall(
      abi.encodeWithSelector(IERC20.transferFrom.selector, msg.sender, address(this), amountFusd)
    );

    // Manager fee first (keeps PoolLogic semantics)
    (uint256 fundValueBefore, ) = _mintManagerFee();

    uint256 totalSupplyBefore = totalSupply();
    uint256 usdAmount = _assetValue(fusd, amountFusd);

    // Compute shares to mint
    uint256 liquidityMinted = totalSupplyBefore > 0
      ? (usdAmount * totalSupplyBefore) / fundValueBefore
      : usdAmount;

    // Entry fee (minted in shares to manager)
    (, , uint256 entryFeeNumerator, , uint256 denominator) = _managerFees();
    uint256 entryFeeShares = 0;
    if (entryFeeNumerator > 0 && liquidityMinted > 0) {
      entryFeeShares = (liquidityMinted * entryFeeNumerator) / denominator;
      require(liquidityMinted > entryFeeShares, "fee exceeds mint");
      liquidityMinted -= entryFeeShares;
      _mint(_manager(), entryFeeShares);
      emit EntryFeeMinted(_manager(), entryFeeShares);
    }

    // Anti-inflation lower bound (same rationale as PoolLogic)
    require(liquidityMinted >= 100_000, "invalid liquidityMinted");

    _mint(msg.sender, liquidityMinted);

    // Cooldown update
    lastExitCooldown[msg.sender] = _calculateCooldown(
      balanceOf(msg.sender),
      liquidityMinted,
      _exitCooldown(),
      lastExitCooldown[msg.sender],
      lastDeposit[msg.sender],
      block.timestamp
    );
    lastDeposit[msg.sender] = block.timestamp;

    // Min deposit check using current (post-deposit) totals
    uint256 fundValueAfter = fundValueBefore + usdAmount;
    uint256 totalSupplyAfter = totalSupply();
    require(
      (balanceOf(msg.sender) * _tokenPrice(fundValueAfter, totalSupplyAfter)) / 1e18 >=
        IPoolManagerLogic(poolManagerLogic).minDepositUSD(),
      "need min deposit"
    );

    emit Stake(msg.sender, amountFusd, liquidityMinted, entryFeeShares);
    _emitFactoryEvent();
  }

  // =========================
  //     WITHDRAW (POOLLOGIC)
  // =========================

  function unstake(uint256 fundTokenAmount)
    external
    nonReentrant
    whenNotFactoryPaused
    whenNotPaused
    updateFeesAndYieldFor(msg.sender)
  {
    require(withdrawMode == WithdrawMode.Immediate, "queue mode");
    _withdrawImmediate(msg.sender, fundTokenAmount);
  }

  function harvest()
    external
    nonReentrant
    whenNotFactoryPaused
    whenNotPaused
    updateFeesAndYieldFor(msg.sender)
  {
    uint256 amount = userYields[msg.sender].claimable;
    require(amount > 0, "nothing to harvest");
    userYields[msg.sender].claimable = 0;

    fusd.tryAssemblyCall(abi.encodeWithSelector(IERC20.transfer.selector, msg.sender, amount));
    emit Harvest(msg.sender, amount);
  }

  function _withdrawImmediate(address _recipient, uint256 _fundTokenAmount) internal {
    require(lastDeposit[msg.sender] < block.timestamp, "can withdraw soon");
    require(balanceOf(msg.sender) >= _fundTokenAmount, "not enough balance");

    WithdrawExecution memory execution;
    execution.supplyAfterBurn = totalSupply() - _fundTokenAmount;
    require(execution.supplyAfterBurn >= 100_000 || execution.supplyAfterBurn == 0, "below threshold");

    (execution.fundValue, execution.feesMinted) = _mintManagerFee();

    {
      (, , , uint256 exitFeeNumerator, uint256 denominator) = _managerFees();
      if (exitFeeNumerator > 0) {
        uint256 exitFeeShares = (_fundTokenAmount * exitFeeNumerator) / denominator;
        _fundTokenAmount -= exitFeeShares;
        execution.supplyAfterBurn += exitFeeShares;

        require(transfer(_manager(), exitFeeShares), "exitFee failed");
        emit ExitFeeMinted(_manager(), exitFeeShares);
      }
    }

    uint256 portion = (_fundTokenAmount * 1e18) / totalSupply();

    _burn(msg.sender, _fundTokenAmount);
    if (totalSupply() == 0) {
      tokenPriceAtLastFeeMint = 1e18;
    }

    IHasSupportedAsset.Asset[] memory supported = IHasSupportedAsset(poolManagerLogic).getSupportedAssets();
    WithdrawnAsset[] memory withdrawnAssets = new WithdrawnAsset[](supported.length);
    uint256 index = 0;

    for (uint256 i = 0; i < supported.length; ) {
      // Properly create an empty ComplexAsset struct
      IPoolLogic.ComplexAsset memory emptyComplex = IPoolLogic.ComplexAsset({
        supportedAsset: address(0),
        withdrawData: "",
        slippageTolerance: 0
      });

      (address asset, uint256 portionBal, bool extProcessed) = _withdrawProcessing(
        supported[i].asset,
        _recipient,
        portion,
        emptyComplex
      );

      if (portionBal > 0) {
        require(asset != address(0), "need withdraw asset");
        asset.tryAssemblyCall(abi.encodeWithSelector(IERC20.transfer.selector, _recipient, portionBal));
      }

      if (extProcessed || portionBal > 0) {
        withdrawnAssets[index] = WithdrawnAsset({asset: asset, amount: portionBal, externalWithdrawProcessed: extProcessed});
        unchecked { ++index; }
      }

      unchecked { ++i; }
    }

    {
      uint256 reduceLength = supported.length - index;
      assembly { mstore(withdrawnAssets, sub(mload(withdrawnAssets), reduceLength)) }
    }

    uint256 valueWithdrawn = (portion * execution.fundValue) / 1e18;

    require(execution.fundValue - _totalValue() <= valueWithdrawn + 1e15, "value mismatch");
    require(execution.supplyAfterBurn + execution.feesMinted == totalSupply(), "supply mismatch");

    emit Withdrawal(
      address(this),
      _recipient,
      valueWithdrawn,
      _fundTokenAmount,
      balanceOf(_recipient),
      execution.fundValue - valueWithdrawn,
      totalSupply(),
      withdrawnAssets,
      block.timestamp
    );
    _emitFactoryEvent();
  }

  // =========================
  //    WITHDRAWAL QUEUE
  // =========================

  function setWithdrawMode(WithdrawMode mode) external {
    require(msg.sender == _manager(), "only manager");
    withdrawMode = mode;
    emit WithdrawModeChanged(mode);
  }

  function requestWithdraw(uint256 shares)
    external
    nonReentrant
    whenNotFactoryPaused
    whenNotPaused
    updateFeesAndYieldFor(msg.sender)
    returns (uint256 requestId)
  {
    require(withdrawMode == WithdrawMode.Queued, "not queued");
    require(shares > 0 && shares <= balanceOf(msg.sender), "invalid shares");

    (, , , uint256 exitFeeNumerator, uint256 denominator) = _managerFees();
    uint256 exitFeeShares = (shares * exitFeeNumerator) / denominator;

    if (exitFeeShares > 0) {
      _transfer(msg.sender, _manager(), exitFeeShares);
      emit ExitFeeMinted(_manager(), exitFeeShares);
    }
    uint256 locked = shares - exitFeeShares;
    _transfer(msg.sender, address(this), locked);

    requestId = ++lastRequestId;
    withdrawalRequests[requestId] = WithdrawalRequest({
      owner: msg.sender,
      sharesLocked: locked,
      requestedAt: block.timestamp,
      finalized: false,
      fusdAmount: 0,
      claimed: false
    });
    requestsByUser[msg.sender].push(requestId);

    emit WithdrawRequested(requestId, msg.sender, locked, exitFeeShares);
  }

  function finalizeWithdraw(uint256 requestId)
    external
    nonReentrant
    whenNotFactoryPaused
    whenNotPaused
  {
    require(msg.sender == _manager(), "only manager");
    WithdrawalRequest storage r = withdrawalRequests[requestId];
    require(!r.finalized && r.owner != address(0), "invalid request");

    _updateFeesAndYieldInternal(address(0));

    uint256 price = _tokenPrice(_totalValue(), totalSupply());
    uint256 fusdAmount = (r.sharesLocked * price) / 1e18;

    _burn(address(this), r.sharesLocked);

    r.finalized = true;
    r.fusdAmount = fusdAmount;

    emit WithdrawFinalized(requestId, fusdAmount);
  }

  function claimWithdraw(uint256 requestId)
    external
    nonReentrant
    whenNotFactoryPaused
    whenNotPaused
    updateFeesAndYieldFor(msg.sender)
  {
    WithdrawalRequest storage r = withdrawalRequests[requestId];
    require(r.finalized && !r.claimed, "not ready");
    require(r.owner == msg.sender, "not owner");
    r.claimed = true;

    fusd.tryAssemblyCall(abi.encodeWithSelector(IERC20.transfer.selector, msg.sender, r.fusdAmount));
    emit WithdrawClaimed(requestId, msg.sender, r.fusdAmount);
  }

  // =========================
  //   WITHDRAW PROCESSING
  // =========================

  function _withdrawProcessing(
    address _asset,
    address _to,
    uint256 _portion,
    IPoolLogic.ComplexAsset memory _complexAssetData
  ) internal returns (address withdrawAsset, uint256 withdrawBalance, bool externalWithdrawProcessed) {
    WithdrawProcessing memory params;

    params.guard = IHasGuardInfo(factory).getAssetGuard(_asset);
    require(params.guard != address(0), "invalid guard");

    params.portionBalance = (IAssetGuard(params.guard).getBalance(address(this), _asset) * _portion) / 1e18;
    params.expectedWithdrawValue = _assetValue(_asset, params.portionBalance);

    IAssetGuard.MultiTransaction[] memory transactions;

    if (_complexAssetData.withdrawData.length > 0) {
      require(_asset == _complexAssetData.supportedAsset, "invalid asset data");
      (withdrawAsset, withdrawBalance, transactions) = IComplexAssetGuard(params.guard).withdrawProcessing(
        address(this),
        _asset,
        _portion,
        _to,
        _complexAssetData.withdrawData
      );
    } else {
      (withdrawAsset, withdrawBalance, transactions) = IAssetGuard(params.guard).withdrawProcessing(
        address(this),
        _asset,
        _portion,
        _to
      );
      params.regularProcessingUsed = true;
    }

    uint256 txCount = transactions.length;
    if (txCount > 0) {
      uint256 assetBalanceBefore;
      if (withdrawAsset != address(0)) {
        assetBalanceBefore = IERC20(withdrawAsset).balanceOf(address(this));
      }
      for (uint256 i = 0; i < txCount; ) {
        externalWithdrawProcessed = transactions[i].to.tryAssemblyCall(transactions[i].txData);
        unchecked { ++i; }
      }
      if (withdrawAsset != address(0)) {
        uint256 assetBalanceAfter = IERC20(withdrawAsset).balanceOf(address(this));
        withdrawBalance = withdrawBalance + (assetBalanceAfter - assetBalanceBefore);
      }
    }

    if (params.regularProcessingUsed && _complexAssetData.slippageTolerance != 0 && withdrawAsset != address(0)) {
      require(
        _assetValue(withdrawAsset, withdrawBalance) >=
          (params.expectedWithdrawValue * (10_000 - _complexAssetData.slippageTolerance)) / 10_000,
        "high withdraw slippage"
      );
    }
  }

  // =========================
  //  GUARDED TX EXECUTION
  // =========================

  function _execTransaction(
    address _to,
    bytes memory _data
  ) private nonReentrant whenNotFactoryPaused returns (bool success) {
    require(!IHasPausable(factory).tradingPausedPools(address(this)), "trading paused");
    require(_to != address(0), "invalid address");

    address contractGuard = IHasGuardInfo(factory).getContractGuard(_to);
    address assetGuard;
    address guard;
    uint16 txType;
    bool isPublic;

    if (contractGuard != address(0)) {
      guard = contractGuard;
      (txType, isPublic) = IGuard(contractGuard).txGuard(poolManagerLogic, _to, _data);
    }

    if (txType == 0) {
      assetGuard = IHasGuardInfo(factory).getAssetGuard(_to);

      if (assetGuard == address(0)) {
        address governanceAddress = IPoolFactory(factory).governanceAddress();
        assetGuard = IGovernance(governanceAddress).assetGuards(0); // ERC20Guard
      } else {
        require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(_to), "asset disabled");
      }
      guard = assetGuard;
      (txType, isPublic) = IGuard(assetGuard).txGuard(poolManagerLogic, _to, _data);
    }

    require(txType > 0, "invalid transaction");
    require(isPublic || msg.sender == _manager() || msg.sender == _trader(), "only manager, trader, public");

    success = _to.tryAssemblyCall(_data);

    (bool hasFunction, bytes memory returnData) = guard.call(abi.encodeWithSignature("isTxTrackingGuard()"));
    if (hasFunction && abi.decode(returnData, (bool))) {
      ITxTrackingGuard(guard).afterTxGuard(poolManagerLogic, _to, _data);
    }

    emit TransactionExecuted(address(this), _manager(), txType, block.timestamp);
    _emitFactoryEvent();
  }

  function execTransaction(address to, bytes calldata data) external returns (bool success) {
    return _execTransaction(to, data);
  }

  function execTransactions(TxToExecute[] calldata txs) external {
    for (uint256 i; i < txs.length; ) {
      require(_execTransaction(txs[i].to, txs[i].data), "tx failed");
      unchecked { ++i; }
    }
  }

  // =========================
  //     VIEW / PRICING
  // =========================

  function getFundSummary() external view returns (FundSummary memory) {
    (
      uint256 performanceFeeNumerator,
      uint256 managementFeeNumerator,
      uint256 entryFeeNumerator,
      uint256 exitFeeNumerator,
      uint256 denominator
    ) = _managerFees();

    return
      FundSummary(
        name(),
        totalSupply(),
        _totalValue(),
        _manager(),
        IManaged(poolManagerLogic).managerName(),
        creationTime,
        privatePool,
        performanceFeeNumerator,
        managementFeeNumerator,
        denominator,
        exitFeeNumerator,
        denominator,
        entryFeeNumerator
      );
  }

  function tokenPrice() external view returns (uint256 price) {
    uint256 fundValue = _totalValue();
    uint256 tokenSupply = totalSupply() + calculateAvailableManagerFee(fundValue);
    price = _tokenPrice(fundValue, tokenSupply);
  }

  function tokenPriceWithoutManagerFee() external view returns (uint256 price) {
    price = _tokenPrice(_totalValue(), totalSupply());
  }

  function _tokenPrice(uint256 _fundValue, uint256 _tokenSupply) internal pure returns (uint256 price) {
    if (_tokenSupply == 0 || _fundValue == 0) return 0;
    price = (_fundValue * 1e18) / _tokenSupply;
  }

  function calculateAvailableManagerFee(uint256 _fundValue) public view returns (uint256 fee) {
    (uint256 performanceFeeNumerator, uint256 managementFeeNumerator, , , uint256 denominator) = _managerFees();

    (uint256 performanceFee, uint256 streamingFee) = _availableManagerFee(
      _fundValue,
      totalSupply(),
      performanceFeeNumerator,
      managementFeeNumerator,
      denominator
    );

    return performanceFee + streamingFee;
  }

  function _availableManagerFee(
    uint256 _fundValue,
    uint256 _tokenSupply,
    uint256 _performanceFeeNumerator,
    uint256 _managerFeeNumerator,
    uint256 _feeDenominator
  ) internal view returns (uint256 performanceFee, uint256 streamingFee) {
    if (_tokenSupply == 0 || _fundValue == 0) return (0, 0);

    uint256 currentTokenPrice = (_fundValue * 1e18) / _tokenSupply;

    if (currentTokenPrice > tokenPriceAtLastFeeMint) {
      uint256 feeUsdAmount =
        ((currentTokenPrice - tokenPriceAtLastFeeMint) * _performanceFeeNumerator * _tokenSupply) /
        (_feeDenominator * 1e18);
      performanceFee = (feeUsdAmount * _tokenSupply) / (_fundValue - feeUsdAmount);
    }

    if (lastFeeMintTime != 0) {
      uint256 timeChange = block.timestamp - lastFeeMintTime;
      streamingFee = (_tokenSupply * timeChange * _managerFeeNumerator) / _feeDenominator / 365 days;
    }
  }

  // =========================
  //       FEE MINTING
  // =========================

  function mintManagerFee() external nonReentrant whenNotFactoryPaused whenNotPaused {
    _mintManagerFee();
  }

  function _mintManagerFee() internal returns (uint256 fundValue, uint256 amountMinted) {
    fundValue = _totalValue();
    uint256 tokenSupply = totalSupply();

    (uint256 performanceFeeNumerator, uint256 managementFeeNumerator, , , uint256 denominator) = _managerFees();

    (uint256 performanceFee, uint256 streamingFee) = _availableManagerFee(
      fundValue,
      tokenSupply,
      performanceFeeNumerator,
      managementFeeNumerator,
      denominator
    );
    amountMinted = performanceFee + streamingFee;

    (uint256 daoFeeNumerator, uint256 daoFeeDenominator) = IHasDaoInfo(factory).getDaoFee();

    uint256 daoFee = (amountMinted * daoFeeNumerator) / daoFeeDenominator;
    uint256 managerFee = amountMinted - daoFee;
    uint256 currentTokenPrice = _tokenPrice(fundValue, tokenSupply);

    if (tokenPriceAtLastFeeMint < currentTokenPrice) {
      tokenPriceAtLastFeeMint = currentTokenPrice;
    }

    if (streamingFee > 0) lastFeeMintTime = block.timestamp;

    if (daoFee > 0) _mint(IHasDaoInfo(factory).daoAddress(), daoFee);
    if (managerFee > 0) _mint(_manager(), managerFee);

    emit ManagerFeeMinted(address(this), _manager(), amountMinted, daoFee, managerFee, tokenPriceAtLastFeeMint);
    _emitFactoryEvent();
  }

  // =========================
  //       COOLDOWN LOGIC
  // =========================

  function _calculateCooldown(
    uint256 _currentBalance,
    uint256 _liquidityMinted,
    uint256 _newCooldown,
    uint256 _lastCooldown,
    uint256 _lastDepositTime,
    uint256 _blockTimestamp
  ) internal pure returns (uint256 cooldown) {
    uint256 cooldownEndsAt = _lastDepositTime + _lastCooldown;
    uint256 remainingCooldown = cooldownEndsAt < _blockTimestamp ? 0 : (cooldownEndsAt - _blockTimestamp);

    if (_currentBalance == 0 && _liquidityMinted == 0) {
      cooldown = 0;
    } else if (_currentBalance == 0) {
      cooldown = _newCooldown;
    } else if (_liquidityMinted == 0 || _newCooldown < remainingCooldown) {
      cooldown = remainingCooldown;
    } else {
      uint256 aggregated = (_newCooldown * _liquidityMinted) / _currentBalance + remainingCooldown;
      cooldown = aggregated > _newCooldown ? _newCooldown : (aggregated != 0 ? aggregated : 1);
    }
  }

  function getExitRemainingCooldown(address _depositor) public view returns (uint256 remaining) {
    uint256 cooldownFinished = lastDeposit[_depositor] + lastExitCooldown[_depositor];
    if (cooldownFinished < block.timestamp) return 0;
    remaining = cooldownFinished - block.timestamp;
  }

  // =========================
  //     ADMIN / LINKING
  // =========================

  function setPoolManagerLogic(address _poolManagerLogic) external {
    require(_poolManagerLogic != address(0), "invalid address");
    require(msg.sender == factory || msg.sender == IHasOwnable(factory).owner(), "only owner, factory");
    poolManagerLogic = _poolManagerLogic;
    emit PoolManagerLogicSet(_poolManagerLogic, msg.sender);
  }

  // =========================
  //        LIGHT HELPERS
  // =========================

  function _manager() internal view returns (address managerAddr) {
    managerAddr = IManaged(poolManagerLogic).manager();
  }

  function _trader() internal view returns (address traderAddr) {
    traderAddr = IManaged(poolManagerLogic).trader();
  }

  function _exitCooldown() internal view returns (uint256 cooldown) {
    cooldown = IHasFeeInfo(factory).getExitCooldown();
  }

  function _totalValue() internal view returns (uint256 totalValue) {
    totalValue = IPoolManagerLogic(poolManagerLogic).totalFundValue();
  }

  function _assetValue(address _asset, uint256 _amount) internal view returns (uint256 assetValue) {
    assetValue = IPoolManagerLogic(poolManagerLogic).assetValue(_asset, _amount);
  }

  function _managerFees()
    internal
    view
    returns (uint256 performance, uint256 management, uint256 entry, uint256 exit, uint256 denominator)
  {
    (performance, management, entry, exit, denominator) = IPoolManagerLogic(poolManagerLogic).getFee();
  }

  function _isMemberAllowed(address _member) internal view returns (bool allowed) {
    allowed = IPoolManagerLogic(poolManagerLogic).isMemberAllowed(_member);
  }

  // =========================
  //    FLASHLOAN CALLBACK
  // =========================

  function executeOperation(
    address[] calldata assets,
    uint256[] calldata amounts,
    uint256[] calldata premiums,
    address initiator,
    bytes calldata params
  ) external override returns (bool success) {
    require(initiator == address(this), "only pool flash loan origin");

    address aaveGuard = IHasGuardInfo(factory).getAssetGuard(msg.sender);
    require(
      aaveGuard != address(0) && msg.sender == IAaveLendingPoolAssetGuard(aaveGuard).aaveLendingPool(),
      "invalid lending pool"
    );

    uint256 balBefore = IERC20(assets[0]).balanceOf(address(this));

    IAssetGuard.MultiTransaction[] memory txs = IAaveLendingPoolAssetGuard(aaveGuard)
      .flashloanProcessing(address(this), assets[0], amounts[0], premiums[0], params);

    for (uint256 i; i < txs.length; ) {
      success = txs[i].to.tryAssemblyCall(txs[i].txData);
      unchecked { ++i; }
    }

    require(balBefore + premiums[0] <= IERC20(assets[0]).balanceOf(address(this)), "high slippage");
  }

  // =========================
  //   ERC721 RECEIVER CHECK
  // =========================

  function onERC721Received(
    address operator,
    address from,
    uint256 tokenId,
    bytes calldata data
  ) external override returns (bytes4) {
    address contractGuard = IHasGuardInfo(factory).getContractGuard(operator);
    require(contractGuard != address(0), "only guarded address");
    require(IERC721VerifyingGuard(contractGuard).verifyERC721(operator, from, tokenId, data), "not verified");
    return IERC721Receiver.onERC721Received.selector;
  }

  // =========================
  //        INTERNALS
  // =========================

  function _updateFeesAndYieldInternal(address account) internal {
    (uint256 fundValue, ) = _mintManagerFee();

    uint256 supplyAdj = totalSupply() + calculateAvailableManagerFee(fundValue);
    uint256 currentPrice = _tokenPrice(fundValue, supplyAdj);
    if (currentPrice == 0) currentPrice = 1e18;

    if (currentPrice > lastTokenPriceForYield) {
      uint256 gain = currentPrice - lastTokenPriceForYield;
      yieldPerShare += gain;
      lastTokenPriceForYield = currentPrice;
    }

    if (account != address(0)) {
      UserYield storage u = userYields[account];
      uint256 delta = yieldPerShare - u.rewardDebt;
      if (delta > 0) {
        uint256 earned = (balanceOf(account) * delta) / 1e18;
        if (earned > 0) u.claimable += earned;
      }
      u.rewardDebt = yieldPerShare;
    }
  }

  function _emitFactoryEvent() internal {
    IPoolFactory(factory).emitPoolEvent();
  }

  uint256[37] private __gap;
}