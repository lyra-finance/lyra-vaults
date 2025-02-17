import { lyraConstants, lyraDefaultParams, lyraEvm, TestSystem } from '@lyrafinance/protocol';
import { toBN } from '@lyrafinance/protocol/dist/scripts/util/web3utils';
import { TestSystemContractsType } from '@lyrafinance/protocol/dist/test/utils/deployTestSystem';
import { PricingParametersStruct } from '@lyrafinance/protocol/dist/typechain-types/OptionMarketViewer';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';
import { DeltaLongStrategy, LyraVault, MockERC20 } from '../../../typechain-types';
import { DeltaLongStrategyDetailStruct } from '../../../typechain-types/DeltaLongStrategy';
import { strikeIdToDetail } from './utils';

const strategyDetail: DeltaLongStrategyDetailStruct = {
  minTradeInterval: 600,
  maxVolVariance: toBN('0.1'),
  gwavPeriod: 600,
  minTimeToExpiry: lyraConstants.DAY_SEC,
  maxTimeToExpiry: lyraConstants.WEEK_SEC * 2,
  targetDelta: toBN('0.15'),
  maxDeltaGap: toBN('0.05'), // accept delta from 0.1~0.2
  minVol: toBN('0.6'), // min vol to buy. (also used to calculate max premium for call buying vault)
  maxVol: toBN('0.9'), // max vol to buy.
  size: toBN('10'),
};

describe('Long Call Strategy integration test', async () => {
  // mocked tokens
  let susd: MockERC20;

  let lyraTestSystem: TestSystemContractsType;
  let vault: LyraVault;
  let strategy: DeltaLongStrategy;

  // roles
  let deployer: SignerWithAddress;
  let manager: SignerWithAddress;
  let randomUser: SignerWithAddress;
  let randomUser2: SignerWithAddress;

  // testing parameters
  const spotPrice = toBN('3000');
  let boardId = BigNumber.from(0);
  const boardParameter = {
    expiresIn: lyraConstants.DAY_SEC * 7,
    baseIV: '0.9',
    strikePrices: ['2500', '3000', '3200', '3300', '3350', '3500'],
    skews: ['0.9', '0.8', '0.7', '0.8', '0.9', '0.9'],
  };
  const initialPoolDeposit = toBN('1500000'); // 1.5m

  before('assign roles', async () => {
    const addresses = await ethers.getSigners();
    deployer = addresses[0];
    manager = addresses[1];
    randomUser = addresses[8];
    randomUser2 = addresses[9];
  });

  before('deploy lyra core', async () => {
    const pricingParams: PricingParametersStruct = {
      ...lyraDefaultParams.PRICING_PARAMS,
      standardSize: toBN('10'),
      spotPriceFeeCoefficient: toBN('0.001'),
    };

    lyraTestSystem = await TestSystem.deploy(deployer, true, false, { pricingParams });

    await TestSystem.seed(deployer, lyraTestSystem, {
      initialBoard: boardParameter,
      initialBasePrice: spotPrice,
      initialPoolDeposit: initialPoolDeposit,
    });

    // assign test tokens
    susd = lyraTestSystem.snx.quoteAsset as MockERC20;

    // set boardId
    const boards = await lyraTestSystem.optionMarket.getLiveBoards();
    boardId = boards[0];

    await lyraTestSystem.optionGreekCache.updateBoardCachedGreeks(boardId);

    // fast forward do vol gwap can work
    await lyraEvm.fastForward(600);
  });

  before('deploy vault', async () => {
    const LyraVault = await ethers.getContractFactory('LyraVault');

    const cap = toBN('5000000');
    const decimals = 18;

    vault = (await LyraVault.connect(manager).deploy(
      susd.address,
      manager.address, // feeRecipient,
      lyraConstants.DAY_SEC * 7,
      'LyraVault Share',
      'Lyra VS',
      {
        decimals,
        cap,
        asset: susd.address,
      },
    )) as LyraVault;
  });

  before('deploy strategy', async () => {
    strategy = (await (
      await ethers.getContractFactory('DeltaLongStrategy', {
        libraries: {
          BlackScholes: lyraTestSystem.blackScholes.address,
        },
      })
    )
      .connect(manager)
      .deploy(vault.address, TestSystem.OptionType.LONG_CALL)) as DeltaLongStrategy;
  });

  before('initialize strategy and adaptor', async () => {
    await strategy.connect(manager).initAdapter(
      lyraTestSystem.lyraRegistry.address,
      lyraTestSystem.optionMarket.address,
      lyraTestSystem.testCurve.address, // curve swap
      lyraTestSystem.basicFeeCounter.address,
    );
  });

  before('link strategy to vault', async () => {
    await vault.connect(manager).setStrategy(strategy.address);
  });

  describe('check strategy setup', async () => {
    it('deploys with correct vault and optionType', async () => {
      expect(await strategy.vault()).to.be.eq(vault.address);
      expect(await strategy.optionType()).to.be.eq(TestSystem.OptionType.LONG_CALL);
      expect(await strategy.gwavOracle()).to.be.eq(lyraTestSystem.GWAVOracle.address);
    });
  });

  describe('setStrategy', async () => {
    it('setting strategy should correctly update strategy variables', async () => {
      await strategy.connect(manager).setStrategyDetail(strategyDetail);
      const newStrategy = await strategy.strategyDetail();
      expect(newStrategy.minTimeToExpiry).to.be.eq(strategyDetail.minTimeToExpiry);
      expect(newStrategy.maxTimeToExpiry).to.be.eq(strategyDetail.maxTimeToExpiry);
      expect(newStrategy.targetDelta).to.be.eq(strategyDetail.targetDelta);
      expect(newStrategy.maxDeltaGap).to.be.eq(strategyDetail.maxDeltaGap);
      expect(newStrategy.minVol).to.be.eq(strategyDetail.minVol);
      expect(newStrategy.maxVol).to.be.eq(strategyDetail.maxVol);
      expect(newStrategy.size).to.be.eq(strategyDetail.size);
      expect(newStrategy.minTradeInterval).to.be.eq(strategyDetail.minTradeInterval);
    });

    it('should revert if setStrategy is not called by owner', async () => {
      await expect(strategy.connect(randomUser).setStrategyDetail(strategyDetail)).to.be.revertedWith(
        'Ownable: caller is not the owner',
      );
    });
  });

  describe('start the first round', async () => {
    let strikes: BigNumber[] = [];
    before('create fake susd for users', async () => {
      await susd.mint(randomUser.address, toBN('1000000'));
      await susd.mint(randomUser2.address, toBN('1000000'));
    });
    before('set strikes array', async () => {
      strikes = await lyraTestSystem.optionMarket.getBoardStrikes(boardId);
    });
    it('user should be able to deposit sUSD', async () => {
      // user 1 deposits
      await susd.connect(randomUser).approve(vault.address, lyraConstants.MAX_UINT);
      await vault.connect(randomUser).deposit(toBN('50000'));
      // user 2 deposits
      await susd.connect(randomUser2).approve(vault.address, lyraConstants.MAX_UINT);
      await vault.connect(randomUser2).deposit(toBN('50000'));

      const state = await vault.vaultState();
      expect(state.totalPending.eq(toBN('100000'))).to.be.true;
    });
    it('should revert when trying to start with invalid boardId', async () => {
      await expect(vault.connect(manager).startNextRound(0)).to.be.revertedWith('timestamp expired');
    });
    it('manager can start round 1', async () => {
      await vault.connect(manager).startNextRound(boardId);
    });
    it('should revert when trying to update strategy mid-round', async () => {
      await expect(strategy.connect(manager).setStrategyDetail(strategyDetail)).to.revertedWith(
        'cannot change strategy if round is active',
      );
    });
    it('will not trade when delta is out of range"', async () => {
      // 2500 is a bad strike because delta is close to 1
      await expect(vault.connect(randomUser).trade(strikes[0])).to.be.revertedWith('invalid strike');

      // 3000 is a bad strike because delta is close to 0.5
      await expect(vault.connect(randomUser).trade(strikes[1])).to.be.revertedWith('invalid strike');

      // 3200 is a bad strike (delta is close to 0.21)
      await expect(vault.connect(randomUser).trade(strikes[2])).to.be.revertedWith('invalid strike');
    });

    it('should revert when premium > max premium calculated with min vol', async () => {
      // significantly increasing lyra spot fees to 2% of spot to make premiums high threshold
      let pricingParams: PricingParametersStruct = {
        ...lyraDefaultParams.PRICING_PARAMS,
        standardSize: toBN('10'),
        spotPriceFeeCoefficient: toBN('0.02'),
      };
      await lyraTestSystem.optionMarketPricer.setPricingParams(pricingParams);

      // 33000 is good strike with reasonable delta, but won't go through because premium will be too high. (higher than amount transfered from vault)
      await expect(vault.connect(randomUser).trade(strikes[3])).to.be.revertedWith(
        'ERC20: transfer amount exceeds balance',
      );

      // resetting back to normal
      pricingParams = { ...pricingParams, spotPriceFeeCoefficient: toBN('0.001') };
      await lyraTestSystem.optionMarketPricer.setPricingParams(pricingParams);
    });

    it('should trade when delta and vol are within range', async () => {
      const vaultStateBefore = await vault.vaultState();
      const strategySUSDBalance = await susd.balanceOf(strategy.address);

      // 3350 is a good strike
      const tx = await vault.connect(randomUser).trade(strikes[4]);
      const receipt = await tx.wait();
      const event = receipt.events?.find(e => e.event === 'Trade');
      const premium = event ? event.args?.premium : 0;

      // const strategyBalance = await susd.balanceOf(strategy.address);
      const vaultStateAfter = await vault.vaultState();
      const strategySUDCBalanceAfter = await susd.balanceOf(strategy.address);
      // strategy could hold some sUSD because of inaccurate fee caluclation
      expect(strategySUDCBalanceAfter.isZero()).to.be.false;
      // check state.lockAmount left is updated
      expect(vaultStateBefore.lockedAmountLeft.sub(vaultStateAfter.lockedAmountLeft).eq(premium)).to.be.true;
      // check that we receive sUSD
      expect(strategySUDCBalanceAfter.sub(strategySUSDBalance).gt(0)).to.be.true;

      // active strike is updated
      const storedStrikeId = await strategy.activeStrikeIds(0);
      expect(storedStrikeId.eq(strikes[4])).to.be.true;

      // check that position size is correct
      const positionId = await strategy.strikeToPositionId(storedStrikeId);
      const [position] = await lyraTestSystem.optionToken.getOptionPositions([positionId]);

      expect(position.amount.eq(strategyDetail.size)).to.be.true;
      expect(position.collateral.eq(0)).to.be.true;
    });

    it('should revert when user try to trigger another trade during cooldown', async () => {
      await expect(vault.connect(randomUser).trade(strikes[4])).to.be.revertedWith('min time interval not passed');
    });

    it('should be able to trade again after time interval', async () => {
      await lyraEvm.fastForward(650);
      const strikeObj = await strikeIdToDetail(lyraTestSystem.optionMarket, strikes[4]);
      const positionId = await strategy.strikeToPositionId(strikeObj.id);

      const vaultStateBefore = await vault.vaultState();
      const [positionBefore] = await lyraTestSystem.optionToken.getOptionPositions([positionId]);

      const tx = await vault.connect(randomUser).trade(strikes[4]);
      const receipt = await tx.wait();
      const event = receipt.events?.find(e => e.event === 'Trade');
      const premium = event ? event.args?.premium : 0;

      const vaultStateAfter = await vault.vaultState();
      expect(vaultStateBefore.lockedAmountLeft.sub(vaultStateAfter.lockedAmountLeft).eq(premium)).to.be.true;

      const [positionAfter] = await lyraTestSystem.optionToken.getOptionPositions([positionId]);
      expect(positionAfter.amount.sub(positionBefore.amount).eq(strategyDetail.size)).to.be.true;
    });

    it('should be able to trade a higher strike if spot price goes up', async () => {
      await TestSystem.marketActions.mockPrice(lyraTestSystem, toBN('3125'), 'sETH');

      // triger with new strike (3500)
      await vault.connect(randomUser).trade(strikes[5]);

      // check that active strikes are updated
      const storedStrikeId = await strategy.activeStrikeIds(1);
      expect(storedStrikeId.eq(strikes[5])).to.be.true;
      const positionId = await strategy.strikeToPositionId(storedStrikeId);
      const [position] = await lyraTestSystem.optionToken.getOptionPositions([positionId]);

      expect(position.amount.eq(strategyDetail.size)).to.be.true;
    });
    it('should revert when trying to trade the old strike', async () => {
      await lyraEvm.fastForward(600);
      await expect(vault.connect(randomUser).trade(strikes[4])).to.be.revertedWith('invalid strike');
    });

    const additionalDepositAmount = toBN('30');
    it('can add more deposit during the round', async () => {
      await vault.connect(randomUser).deposit(additionalDepositAmount);
      const state = await vault.vaultState();
      expect(state.totalPending.eq(additionalDepositAmount)).to.be.true;
      const receipt = await vault.depositReceipts(randomUser.address);
      expect(receipt.amount.eq(additionalDepositAmount)).to.be.true;
    });
    it('fastforward to the expiry', async () => {
      await lyraEvm.fastForward(boardParameter.expiresIn);
    });
    it('should revert when closeRound is called before options are settled', async () => {
      await expect(vault.closeRound()).to.be.revertedWith('cannot clear active position');
    });
    it('should revert when returnFundsAndClearStrikes is called by non-vault address', async () => {
      await expect(strategy.returnFundsAndClearStrikes()).to.be.revertedWith('only Vault');
    });
    it('should be able to close closeRound after settlement', async () => {
      // assume our option expires ITM ;)
      await TestSystem.marketActions.mockPrice(lyraTestSystem, toBN('3450'), 'sETH');

      await lyraTestSystem.optionMarket.settleExpiredBoard(boardId);

      // settle all positions, from 1 to highest position
      const totalPositions = (await lyraTestSystem.optionToken.nextId()).sub(1).toNumber();
      const idsToSettle = Array.from({ length: totalPositions }, (_, i) => i + 1); // create array of [1... totalPositions]
      await lyraTestSystem.shortCollateral.settleOptions(idsToSettle);

      const susdInVaultBefore = await susd.balanceOf(vault.address);
      const susdInStrategyBefore = await susd.balanceOf(strategy.address);

      await vault.closeRound();

      const susdInStrategyAfter = await susd.balanceOf(strategy.address);
      const susdInVaultAfter = await susd.balanceOf(vault.address);

      // strategy should be empty after close round
      expect(susdInStrategyAfter.isZero()).to.be.true;

      // final sUSD balance in vault increase: we make profit from settlement ;)
      expect(susdInVaultBefore.add(susdInStrategyBefore).lt(susdInVaultAfter));
    });
  });
  describe('start round 2', async () => {
    const withdrawAmount = toBN('50000');
    let strikes: BigNumber[] = [];
    let positionId: BigNumber;
    let snapshot: number;
    let strategySUSDBalanceBefore: BigNumber;
    before('prepare before new round start', async () => {
      // set price back to initial spot price
      await TestSystem.marketActions.mockPrice(lyraTestSystem, spotPrice, 'sETH');

      // initiate withdraw for later test
      await vault.connect(randomUser2).initiateWithdraw(withdrawAmount);
    });
    before('create new board', async () => {
      await TestSystem.marketActions.createBoard(lyraTestSystem, boardParameter);
      const boards = await lyraTestSystem.optionMarket.getLiveBoards();
      boardId = boards[0];

      strikes = await lyraTestSystem.optionMarket.getBoardStrikes(boardId);
    });

    before('start the next round', async () => {
      await lyraEvm.fastForward(lyraConstants.DAY_SEC);
      await vault.connect(manager).startNextRound(boardId);
    });

    before('should be able to complete the withdraw', async () => {
      const susdBefore = await susd.balanceOf(randomUser2.address);

      await vault.connect(randomUser2).completeWithdraw();

      const susdAfter = await susd.balanceOf(randomUser2.address);

      expect(susdAfter.sub(susdBefore).gt(withdrawAmount)).to.be.true;
    });

    before('make a trade', async () => {
      strategySUSDBalanceBefore = await susd.balanceOf(strategy.address);
      await vault.connect(randomUser).trade(strikes[3]);

      positionId = await strategy.strikeToPositionId(strikes[3]);

      const strategySUDCBalanceAfter = await susd.balanceOf(strategy.address);
      expect(strategySUDCBalanceAfter.sub(strategySUSDBalanceBefore).gt(0)).to.be.true;
    });

    beforeEach(async () => {
      snapshot = await lyraEvm.takeSnapshot();
    });

    afterEach(async () => {
      await lyraEvm.restoreSnapshot(snapshot);
    });

    it('should revert when trading with old strike', async () => {
      // strikeId 1 is the old strike from last round.
      await expect(vault.connect(randomUser).trade(1)).to.be.revertedWith('invalid strike');
    });

    it('should revert when trying to reduce a position', async () => {
      await expect(vault.connect(randomUser).reducePosition(positionId, 0)).to.be.revertedWith('not supported');
    });

    it('should be able to emergency close when the price move down, settled with 0 profit.', async () => {
      const balanceBefore = (await susd.balanceOf(strategy.address)).add(await susd.balanceOf(vault.address));

      await TestSystem.marketActions.mockPrice(lyraTestSystem, toBN('2500'), 'sETH');
      const storedStrikeId1 = await strategy.activeStrikeIds(0);

      await vault.connect(manager).emergencyCloseRound();
      const balanceAfter = await susd.balanceOf(vault.address);

      expect(await strategy.strikeToPositionId(storedStrikeId1)).to.be.eq(0);
      expect(balanceAfter).to.be.eq(balanceBefore);
    });

    it('should be able to emergency close when price goes up, settled with less profit', async () => {
      const balanceBefore = (await susd.balanceOf(strategy.address)).add(await susd.balanceOf(vault.address));
      await TestSystem.marketActions.mockPrice(lyraTestSystem, toBN('3500'), 'sETH');
      const storedStrikeId1 = await strategy.activeStrikeIds(0);

      await vault.connect(manager).emergencyCloseRound();

      const balanceAfter = await susd.balanceOf(vault.address);

      expect(await strategy.strikeToPositionId(storedStrikeId1)).to.be.eq(0);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });
  });
});
