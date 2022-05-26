# Lyra Vault

[![Coverage Status](https://coveralls.io/repos/github/rokusk/lyra-vaults/badge.svg?branch=master)](https://coveralls.io/github/rokusk/lyra-vaults?branch=master)

The `lyra-vaults` repo is a round-based options vault able to both buy and sell options against the Lyra options market. It is intended to be used as an example project to showcase how a vault might interact with Lyra contracts, testing/deployment tools provided by the @lyrafinance/protocol SDK and various options strategies. 

## Documentation:
1. [Installation & Testing](#install)
3. [Behavior](#behavior)
4. [Architecture](#architecture)
5. [Vault Accounting](#vault)
6. [Strategy](#strategy)
7. [Deploy](#deploy)

## Installation & Testing <a name="install"></a>

```bash
yarn install --frozen-lockfile
yarn test
yarn coverage
```

## Behavior <a name="behaviour"></a>
1. Before round start
    1. `manager` sets the `managementFee`, `performanceFee`, `managementRecipient`, `lyraRewardRecipient`, vault `cap`,  
    2. `manager` also sets the strategy contract which will determine what/when to trade via `LyraVault.setStrategy()`
    3. users `LyraVault.deposit()` the base ERC20 into the vault while getting an allocation of ERC20 vault shares in return
2. On round start
    1. `manager` calls `LyraVault.startNextRound(boardId)` to set the board which will be traded
    2. unlocked funds from last round are accounted for
    3. queued withdrawals/deposits from last round are processed
3. During round
    1. anyone can "poke" the vault to `trade(strikeId)` or `reducePosition(positionId, closeAmount)`
    2. the strategy contract determines whether the requested trade or reducePosition are valid
    3. if valid, strategy will transfer required funds from `LyraVault` to itself and execute the trade
4. On round end
    1. unlocked funds from last round are accounted for
    2. all funds are moved from the strategy contract back to the vault.  

*Note: to accrue lyra trading rewards, Lyra must whitelist the strategy contract to make sure
(a) inherit the `LyraAdapter.sol` with no modifications to `_open/close/forceClosePosition` functions 
(b) the strategy contract must not be upgradeable*


## Architecture <a name="architecture"></a>

The vault structure is broken down into 3x main components:
* vault accounting - contracts/libraries in `core/` and `libraries/` that manage share deposit/withdrawal/NAV logic as well as roll-over logic between rounds
* strategy - contracts in `strategies/` that determine what positions to trade.
* @lyrafinance/protocol - uses `LyraAdapter.sol` and `GWAVOracle.sol` to interact with Lyra and accrue trading rewards.

This component breakdown accomodates wide range of option strategies as only the contracts in the `strategy` component need to be swapped out for a novel options stratagy.

## Vault Accounting <a name="vault"></a>



## Strategy <a name="strategy"></a>



## Deploy <a name="deploy"></a>
