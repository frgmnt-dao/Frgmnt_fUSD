# Withdrawal attester service

Signs EIP-712 `WithdrawalPlan`s for `PoolLogic.withdrawCashImmediateWithPlan()`. A user asks for a
redemption; the service reads the pool, composes a plan that draws from the assets that can pay,
signs it, and returns it. The user submits the transaction themselves.

## What it does and does not protect

The contract enforces every value bound itself (value in and out, the volume cap, the surcharge
ceiling, the deadline, the nonce). A stolen attester key can therefore not drain the pool; it can
only compose withdrawals that stay inside those bounds. The service exists to make plans that will
**execute**, and to avoid signing plans that cannot:

- it refuses to sign anything it has not first **simulated** against current state, from the
  requesting user, so a plan the pool would reject is never released;
- it composes with the rules in `scripts/utils/withdrawalPlanBuilder.ts` (fixed amounts, aim at the
  middle of the value band, exact surcharge quote), so ordinary balance drift does not revert it;
- it tracks what it has signed but not yet seen executed or expire, and stays under the pool's own
  circuit-breaker cap;
- it stops when the pool does: feature disabled, the `factoryOwner`'s emergency stop, or the service
  not being the pool's current attester.

It does **not** support position-level selection (Aave V4 reserves, Morpho markets, Uniswap NFTs) or
assets that need `complexAssetsData`. Those plans need a person or a purpose-built composer.

## Run

```bash
RPC_URL=<node url> \
ATTESTER_API_KEY=<at least 16 random characters> \
ATTESTER_PRIVATE_KEY=<attester key> \
  npx ts-node services/attester/src/index.ts services/attester/config.json
```

Copy `config.example.json` to `config.json` and fill in the pool, its `FundCalculationLibrary`, and
the allowed assets (plain ERC-20-style guards only). The key is read from the environment in
`index.ts` and nowhere else, and is never logged. **In production, replace `WalletSigner` with a
`PlanSigner` backed by a KMS or HSM** so the key never enters the process; the interface is two
methods (`address()` and `signTypedData()`).

The server binds to `127.0.0.1` by default. Put a TLS-terminating proxy in front of it and keep it
on a private network; the API key only stops casual callers.

## API

`POST /v1/withdrawal-plan` with `Authorization: Bearer <API key>`:

```json
{ "user": "0x…", "fusdAmount": "100000000000000000000", "assets": ["0x…"] }
```

`fusdAmount` is a decimal string in wei; `assets` is optional. On success (200) the response holds
`plan`, `signature`, `expiresAt`, `expectedValue` and `surchargeAmount` (all numbers as decimal
strings). The user then calls `withdrawCashImmediateWithPlan(plan, signature, [])` from their own
address (after approving the pool to burn their fUSD).

| Status | Meaning                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| 400    | Malformed body (`INVALID_JSON`, `INVALID_USER`, `INVALID_AMOUNT`, `INVALID_ASSETS`, …) |
| 401    | Missing or wrong API key                                                               |
| 409    | A deliberate refusal; the body has a machine-readable `error` code and a `message`     |
| 413    | Body over 4 KiB                                                                        |
| 500    | Unexpected error; no detail in the response, the operator's log has it                 |

Refusal codes: `FEATURE_DISABLED`, `ATTESTER_MISMATCH`, `COOLDOWN_ACTIVE`, `AMOUNT_OUT_OF_RANGE`,
`ASSET_NOT_ALLOWED`, `INSUFFICIENT_LIQUIDITY`, `VOLUME_CAP`, `OUTSTANDING_CAP`, `RATE_LIMITED`,
`SURCHARGE_TOO_HIGH`, `SIMULATION_FAILED` (the message names the pool's revert, for example a
missing fUSD allowance), `NOT_SOLVENT_FOR_PLAN`, `CHAIN_STATE_UNAVAILABLE`.

## Operating notes

- **One instance per pool.** The outstanding-plan ledger is in memory: a restart forgets it (plans
  already signed still expire on their own within `planTtlSeconds`), and two instances would not see
  each other's plans.
- **Rotating the attester key** is done on the pool (`proposeWithdrawalAttester`, then
  `activateWithdrawalAttester` after the rotation delay). Until the new key is active, a service
  holding it refuses with `ATTESTER_MISMATCH` rather than signing plans the pool would reject.
- **Time** comes from the chain (the latest block), not the host clock, so a wrong system clock
  cannot produce a plan that is already expired or too far in the future.
- **Monitoring worth having:** the count of 409s by code, `SIMULATION_FAILED` in particular (it
  means users are asking for plans the pool would reject), and the gap between plans signed and
  `AttestedWithdrawPlanExecuted` events.
- `minValueOutBps` (1 to 100) is the band signed into every plan. A wider band survives more
  drift; the contract caps it at 1%.

## Tests

`test/AttesterService.test.ts` runs the service against a real `PoolLogic` on the Hardhat network:
plans it signs are executed on-chain, refusals are checked one by one, the HTTP layer is exercised
end to end, and the service's copies of the contract's arithmetic are checked against the contract.
