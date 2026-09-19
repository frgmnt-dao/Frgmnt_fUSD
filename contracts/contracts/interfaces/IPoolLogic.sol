// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IPoolLogic
interface IPoolLogic {
    struct ComplexAsset {
        address supportedAsset;
        bytes withdrawData; // at the moment could be only struct ComplexAssetSwapData
        uint256 slippageTolerance; // duplicated from ComplexAssetSwapData on purpose
    }

    /// @notice One asset's contribution to an attested selective withdrawal.
    /// @dev See docs/attested-selective-withdrawal-design.md's "Data Structures" section.
    struct AssetAllocation {
        address asset;
        bool useFixedAmount;
        uint256 portion; // 1e18-scale, meaningful iff !useFixedAmount
        // raw asset units, meaningful iff useFixedAmount. Converted on-chain to a portion via
        // fixedAmount * 1e18 / guard.getBalance(pool, asset) — only meaningful for assets
        // whose getBalance() reports a divisible, fungible-style raw balance (e.g. a plain
        // ERC20 held directly or an interest-bearing wrapper). For indivisible or
        // NFT-backed positions (e.g. a Uniswap V3 LP position, where guard.getBalance()
        // typically reports a USD-denominated value rather than a raw redeemable unit
        // count), useFixedAmount produces a portion the attester did not intend — use direct
        // portion (0 to 1e18) for those asset types instead.
        uint256 fixedAmount;
    }

    /// @notice Attester-signed withdrawal composition for one specific redemption.
    struct WithdrawalPlan {
        address user;
        uint256 fusdAmount;
        uint256 minValueOutBps;
        AssetAllocation[] allocations;
        uint256 nonce;
        uint256 deadline;
        // Attester's own ceiling on the pool-usage surcharge (see WithdrawalPlanLib's
        // MAX_SURCHARGE_BPS_CEILING) this specific plan will tolerate. The surcharge itself is
        // computed on-chain from live state the attester cannot know precisely at signing time
        // (recent attested-withdraw volume relative to fund size), so this field lets the
        // attester bound their own exposure to that drift, the same way minValueOutBps already
        // bounds ordinary execution drift. Appended last (not inserted among the original
        // fields) to minimize the diff across every place the WithdrawalPlan field order must
        // stay in sync: the EIP-712 typehash string, the struct-hash abi.encode call in
        // WithdrawalPlanLib._hashPlan(), this declaration, and whatever off-chain service signs
        // plans. Zero means "reject any nonzero surcharge outright", the same convention
        // minValueOutBps == 0 already uses.
        uint256 maxAcceptableSurchargeBps;
    }

    function factory() external view returns (address);

    function fusd() external view returns (address);

    function poolManagerLogic() external view returns (address);

    function mintManagerFee() external;

    function reservedAssetBalance(address asset) external view returns (uint256);

    // Attested-withdrawal configuration, read by WithdrawalPlanLib through self-calls so that
    // PoolLogic need not encode ten storage reads into a struct on every call (bytecode).
    // Implemented by PoolLogic's public state variables of the same names.
    function withdrawalAttester() external view returns (address);

    function consumedPlanNonce(address user, uint256 nonce) external view returns (bool);

    function attestedWithdrawDecayWindow() external view returns (uint256);

    function maxAttestedWithdrawVolumePerWindow() external view returns (uint256);

    function attestedWithdrawVolume()
        external
        view
        returns (uint64 lastWithdrawTimestamp, uint128 accumulatedValueUsd);

    function maxSurchargeBps() external view returns (uint256);

    /// @notice FNA-34: cumulative net yield ever routed into the staking reward index
    ///         (_accrueYield()'s appliedNetYield), regardless of whether any staker has
    ///         harvested it yet. Together with totalRewardHarvested below, the difference is
    ///         the FUSD the protocol is already committed to minting via harvest() — a real,
    ///         outstanding claim against the pool that existing FUSD claims-haircut math must
    ///         not ignore.
    function totalRewardAccrued() external view returns (uint256);

    /// @notice FNA-34: cumulative amount already minted out via harvest(). See
    ///         totalRewardAccrued above — the difference between the two is what's still owed.
    function totalRewardHarvested() external view returns (uint256);

    /// @notice FNA-38: sum of fusdNetForAsset across every request currently
    ///         Finalized/FinalizedEscrowed but not yet Claimed — FUSD still counted in
    ///         totalSupply() (not burned until claim) whose backing asset has already been
    ///         carved out of active NAV at finalize time. Existing claims-haircut math must
    ///         exclude it from totalClaims or it double-counts the same value.
    function finalizedUnclaimedFusd() external view returns (uint256);

    function incrementAccountedAssets(uint256 amount) external;

    /// @notice FNA-04 follow-up: reverted by checkpointFeesForDeposit() when the pool's active
    ///         NAV reading is incomplete (see IPoolManagerLogic.totalFundValueWithCompleteness()),
    ///         so a deposit cannot proceed while a position's true value is transiently unknown.
    error IncompleteNAV();

    function checkpointFeesForDeposit() external;

    // ------------------------------------------------------------------
    // Errors declared here (not directly in PoolLogic.sol) specifically because each is thrown
    // from both PoolLogic's own code and WithdrawalPlanLib.sol (an externally-linked library —
    // see its own docs). A library cannot reference an error declared directly inside a contract
    // it doesn't implement, so these live on the shared interface instead; PoolLogic's own call
    // sites keep working unqualified since PoolLogic implements this interface.
    // ------------------------------------------------------------------

    error SlippageExceeded();
    error InvalidReservedBalance();
    error InvalidAssetData();
    error AssetNotSupported();
    error InvalidFundValue();

    // Errors thrown only from WithdrawalPlanLib (the pro-rata guard-dispatch path and the
    // attested-plan path). Declared here, not in the library, so they appear in PoolLogic's own
    // ABI — a caller of any withdrawal entry point can receive them, and ABI-driven decoders
    // (frontends, subgraphs, bots) read PoolLogic's ABI. Selectors are unchanged.
    error InvalidGuard();
    error ComplexWithdrawFailed(address asset, address guard);
    error TxFailed();
    error InvalidCallData();
    error EmptyFund();
    error WithdrawAmountTooSmall();
    error InvalidAttesterSignature();
    error PlanDeadlineExpired();
    error PlanNonceAlreadyUsed();
    error DuplicateAllocation();
    error ZeroAssetBalance();
    error MinValueOutBpsTooHigh();
    error AttestedWithdrawVolumeCapExceeded();
    error ValueConservationViolated();
    error InvalidPortion();
    /// @dev The live-computed pool-usage surcharge exceeds the ceiling the attester signed into
    ///      plan.maxAcceptableSurchargeBps. Checked before the per-asset loop, so it fails cheaply.
    error SurchargeTooHigh();
}
