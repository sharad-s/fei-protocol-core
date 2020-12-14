const { ZERO_ADDRESS } = require("@openzeppelin/test-helpers/src/constants");
const { accounts, contract } = require('@openzeppelin/test-environment');

const { BN, expectEvent, expectRevert, balance } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');

const MockEthPCVDeposit = contract.fromArtifact('MockEthPCVDeposit');
const Core = contract.fromArtifact('Core');
const Fei = contract.fromArtifact('Fei');
const MockOracle = contract.fromArtifact('MockOracle');
const EthBondingCurve = contract.fromArtifact('EthBondingCurve');

describe('EthBondingCurve', function () {
  const [ userAddress, beneficiaryAddress1, beneficiaryAddress2, governorAddress, genesisGroup ] = accounts;

  beforeEach(async function () {
    this.core = await Core.new({from: governorAddress});
    await this.core.setGenesisGroup(genesisGroup, {from: governorAddress});
    await this.core.setGenesisPeriodEnd(0, {from: governorAddress});
    await this.core.completeGenesisGroup({from: genesisGroup});

    this.fei = await Fei.at(await this.core.fei());
    this.oracle = await MockOracle.new(500); // 500 USD per ETH exchange rate 
    this.pcvDeposit1 = await MockEthPCVDeposit.new(beneficiaryAddress1);
    this.pcvDeposit2 = await MockEthPCVDeposit.new(beneficiaryAddress2);
    this.bondingCurve = await EthBondingCurve.new(100000, this.core.address, [this.pcvDeposit1.address, this.pcvDeposit2.address], [9000, 1000], this.oracle.address);
    await this.core.grantMinter(this.bondingCurve.address, {from: governorAddress});
  });

  describe('Purchase', function() {
    describe('Incorrect ETH sent', function() {
      it('Too little ETH', async function() {
        await expectRevert(this.bondingCurve.purchase("1000000000000000000", userAddress, {value: "100"}), "Bonding Curve: Sent value does not equal input");
      });
      it('Too much ETH', async function() {
        await expectRevert(this.bondingCurve.purchase("100", userAddress, {value: "1000000000000000000"}), "Bonding Curve: Sent value does not equal input");
      });
    });
    describe('Correct ETH sent', function() {
      describe('Pre Scale', function() {
        beforeEach(async function() {
          await this.bondingCurve.purchase("50", userAddress, {value: "50"});
        });

        it('Correct FEI sent', async function() {
          expect(await this.fei.balanceOf(userAddress)).to.be.bignumber.equal(new BN(51977));
        });

        it('Updates total purchased', async function() {
          expect(await this.bondingCurve.totalPurchased()).to.be.bignumber.equal(new BN(51977));
        });

        it('stays pre-scale', async function() {
          expect(await this.bondingCurve.atScale()).to.be.equal(false);
        });

        it('Second purchase moves along curve', async function() {
          await this.bondingCurve.purchase("50", beneficiaryAddress1, {value: "50"});
          expect(await this.fei.balanceOf(beneficiaryAddress1)).to.be.bignumber.equal(new BN(30531));
          expect(await this.bondingCurve.totalPurchased()).to.be.bignumber.equal(new BN(82508));
          expect(await this.bondingCurve.atScale()).to.be.equal(false);
        });

        it('Changes in oracle price', async function() {
          // 20% reduction in exchange rate
          await this.oracle.setExchangeRate(400);
          await this.bondingCurve.purchase("50", beneficiaryAddress1, {value: "50"});
          expect(await this.fei.balanceOf(beneficiaryAddress1)).to.be.bignumber.equal(new BN(24934));
          expect(await this.bondingCurve.totalPurchased()).to.be.bignumber.equal(new BN(76911));
          expect(await this.bondingCurve.atScale()).to.be.equal(false);
        });

        it('Correct current price', async function() {
          expect((await this.bondingCurve.getCurrentPrice()).value).to.be.equal("696035242290748899107");
        });
      });
      describe('Crossing Scale', function() {
        beforeEach(async function() {
          expect(await this.bondingCurve.atScale()).to.be.equal(false);
          await this.bondingCurve.purchase("200", userAddress, {value: "200"});
        });

        it('registers scale cross', async function() {
          // Uses bonding curve for entire trade
          expect(await this.fei.balanceOf(userAddress)).to.be.bignumber.equal(new BN(130974));
          expect(await this.bondingCurve.totalPurchased()).to.be.bignumber.equal(new BN(130974));
          expect(await this.bondingCurve.atScale()).to.be.equal(true);
        });

        it('Correct current price', async function() {
          expect((await this.bondingCurve.getCurrentPrice()).value).to.be.equal("495000000000000000000");
        });
      });
      describe('Post Scale', function() {
        beforeEach(async function() {
           // First reach scale
          await this.bondingCurve.purchase("134", beneficiaryAddress1, {value: "134"});
          expect(await this.bondingCurve.atScale()).to.be.equal(true);
          expect(await this.bondingCurve.totalPurchased()).to.be.bignumber.equal(new BN(100284));
          // Then buy 100 more
          await this.bondingCurve.purchase("100", userAddress, {value: "100"});
        });

        it('Correct FEI sent', async function() {
          expect(await this.fei.balanceOf(userAddress)).to.be.bignumber.equal(new BN(49500));

        });

        it('Updates total supply', async function() {
          expect(await this.bondingCurve.totalPurchased()).to.be.bignumber.equal(new BN(149784));
        });

        it('stays post-scale', async function() {
          expect(await this.bondingCurve.atScale()).to.be.equal(true);
        });

        it('Changes in buffer', async function() {
          // 5% buffer
          await this.bondingCurve.setBuffer(500, {from: governorAddress});
          await this.bondingCurve.purchase("100", beneficiaryAddress2, {value: "100"});
          expect(await this.fei.balanceOf(beneficiaryAddress2)).to.be.bignumber.equal(new BN(47500));
          expect(await this.bondingCurve.totalPurchased()).to.be.bignumber.equal(new BN(197284));
          expect((await this.bondingCurve.getCurrentPrice()).value).to.be.equal("475000000000000000000");
        });

        it('Changes in oracle price', async function() {
          await this.oracle.setExchangeRate(600);
          await this.bondingCurve.purchase("100", beneficiaryAddress2, {value: "100"});
          expect(await this.fei.balanceOf(beneficiaryAddress2)).to.be.bignumber.equal(new BN(59400));
          expect(await this.bondingCurve.totalPurchased()).to.be.bignumber.equal(new BN(209184));
          expect((await this.bondingCurve.getCurrentPrice()).value).to.be.equal("594000000000000000000");
        });

        it('Correct current price', async function() {
          expect((await this.bondingCurve.getCurrentPrice()).value).to.be.equal("495000000000000000000");
        });
      });
    });
  });

  describe('Allocation Rule', function() {
    it('Mismatched lengths revert', async function() {
      await expectRevert(this.bondingCurve.checkAllocation([this.pcvDeposit1.address], [9000, 1000]), "Allocation Rule: PCV Deposits and ratios are different lengths");
    });

    it('Incomplete allocation rule reverts', async function() {
      await expectRevert(this.bondingCurve.checkAllocation([this.pcvDeposit1.address, this.pcvDeposit2.address], [9000, 2000]), "Allocation Rule: ratios do not total 100%");
    });

    it('Overflow reverts', async function() {
      await expectRevert(this.bondingCurve.checkAllocation([this.pcvDeposit1.address, this.pcvDeposit2.address], [65535, 10001]), "Some kind of revert");
    });

    it('Correct allocation rule succeeds', async function() {
      expect(await this.bondingCurve.checkAllocation([this.pcvDeposit1.address, this.pcvDeposit2.address], [5000, 5000])).to.be.equal(true);
    });

    describe('With Purchase', function() {
      beforeEach(async function () {
        this.beneficiaryBalance1 = await balance.current(beneficiaryAddress1);
        this.beneficiaryBalance2 = await balance.current(beneficiaryAddress2);
      });
      it('splits funds accurately', async function() {
        await this.bondingCurve.purchase("1000000000000000000", userAddress, {value: "1000000000000000000"});
        expect(await this.pcvDeposit1.totalValue()).to.be.bignumber.equal(new BN("900000000000000000"));
        expect(await balance.current(beneficiaryAddress1)).to.be.bignumber.equal(this.beneficiaryBalance1.add(new BN("900000000000000000")));
        expect(await this.pcvDeposit2.totalValue()).to.be.bignumber.equal(new BN("100000000000000000"));
        expect(await balance.current(beneficiaryAddress2)).to.be.bignumber.equal(this.beneficiaryBalance2.add(new BN("100000000000000000")));
      });

      it('respects an updated allocation', async function() {
        await this.bondingCurve.setAllocation([this.pcvDeposit1.address, this.pcvDeposit2.address], [5000, 5000], {from: governorAddress});
        await this.bondingCurve.purchase("1000000000000000000", userAddress, {value: "1000000000000000000"});
        expect(await this.pcvDeposit1.totalValue()).to.be.bignumber.equal(new BN("500000000000000000"));
        expect(await balance.current(beneficiaryAddress1)).to.be.bignumber.equal(this.beneficiaryBalance1.add(new BN("500000000000000000")));
        expect(await this.pcvDeposit2.totalValue()).to.be.bignumber.equal(new BN("500000000000000000"));
        expect(await balance.current(beneficiaryAddress2)).to.be.bignumber.equal(this.beneficiaryBalance2.add(new BN("500000000000000000")));

      });
    });
  });

  describe('Access', function() {
    describe('Oracle', function() {
      it('Governor set succeeds', async function() {
        await this.bondingCurve.setOracle(userAddress, {from: governorAddress});
        expect(await this.bondingCurve.oracle()).to.be.equal(userAddress);
      });

      it('Non-governor set reverts', async function() {
        await expectRevert(this.bondingCurve.setOracle(userAddress, {from: userAddress}), "CoreRef: Caller is not a governor");
      });
    });
    describe('Scale', function() {
      it('Governor set succeeds', async function() {
        await this.bondingCurve.setScale(100, {from: governorAddress});
        expect(await this.bondingCurve.scale()).to.be.bignumber.equal(new BN(100));
      });

      it('Non-governor set reverts', async function() {
        await expectRevert(this.bondingCurve.setScale(100, {from: userAddress}), "CoreRef: Caller is not a governor");
      });
    });
    describe('Buffer', function() {
      it('Governor set succeeds', async function() {
        await this.bondingCurve.setBuffer(1000, {from: governorAddress});
        expect(await this.bondingCurve.buffer()).to.be.bignumber.equal(new BN(1000));
      });

      it('Non-governor set reverts', async function() {
        await expectRevert(this.bondingCurve.setBuffer(1000, {from: userAddress}), "CoreRef: Caller is not a governor");
      });
    });
    describe('Allocation Rule', function() {
      it('Governor set succeeds', async function() {
        await this.bondingCurve.setAllocation([this.pcvDeposit1.address], [10000], {from: governorAddress});
        var result = await this.bondingCurve.getAllocationRule();
        expect(result[0].length).to.be.equal(1);
        expect(result[0][0]).to.be.equal(this.pcvDeposit1.address);
        expect(result[1].length).to.be.equal(1);
        expect(result[1][0]).to.be.bignumber.equal(new BN(10000));
      });

      it('Non-governor set reverts', async function() {
        await expectRevert(this.bondingCurve.setAllocation([this.pcvDeposit1.address], [10000], {from: userAddress}), "CoreRef: Caller is not a governor");
      });
    });
  });
});