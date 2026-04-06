// TronPaySubscription contract tests.
// Uses Hardhat + ethers.js to run against the EVM-compiled version of TronPaySubscription.sol.
// The TVM deployment uses the same Solidity logic; these tests validate contract correctness.
// Note: activateWithPermit is intentionally absent from TronPaySubscription.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("TronPaySubscription", function () {
  async function deployFixture() {
    const [owner, receiver, sender, newReceiver] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockTRC20");
    const token = await MockToken.deploy("Test USDT", "USDT", 6);
    await token.waitForDeployment();

    const TronPaySubscription = await ethers.getContractFactory("TronPaySubscription");
    const subscription = await TronPaySubscription.deploy();
    await subscription.waitForDeployment();

    const amount = ethers.parseUnits("100", 6);
    await token.mint(sender.address, ethers.parseUnits("10000", 6));
    await token.connect(sender).approve(await subscription.getAddress(), ethers.MaxUint256);

    return { subscription, token, owner, receiver, sender, newReceiver, amount };
  }

  describe("Deployment", function () {
    it("should set deployer as owner", async function () {
      const { subscription, owner } = await loadFixture(deployFixture);
      expect(await subscription.owner()).to.equal(owner.address);
    });

    it("should start with subscription ID 0", async function () {
      const { subscription } = await loadFixture(deployFixture);
      expect(await subscription.nextSubscriptionId()).to.equal(0);
    });

    it("should NOT have activateWithPermit function", async function () {
      const { subscription } = await loadFixture(deployFixture);
      expect(subscription.activateWithPermit).to.be.undefined;
    });
  });

  describe("createSubscription", function () {
    it("should create a subscription and emit SubscriptionCreated", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      const interval = 30 * 24 * 60 * 60;

      const tx = await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        interval
      );

      await expect(tx)
        .to.emit(subscription, "SubscriptionCreated")
        .withArgs(0, sender.address, receiver.address, await token.getAddress(), amount, interval);

      const sub = await subscription.getSubscription(0);
      expect(sub.sender).to.equal(sender.address);
      expect(sub.receiver).to.equal(receiver.address);
      expect(sub.amount).to.equal(amount);
      expect(sub.active).to.be.true;
      expect(sub.paymentCount).to.equal(0);
    });

    it("should reject zero address receiver", async function () {
      const { subscription, token, sender, amount } = await loadFixture(deployFixture);
      await expect(
        subscription.connect(sender).createSubscription(ethers.ZeroAddress, await token.getAddress(), amount, 3600)
      ).to.be.revertedWith("Invalid receiver");
    });

    it("should reject interval below 60 seconds", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await expect(
        subscription.connect(sender).createSubscription(receiver.address, await token.getAddress(), amount, 59)
      ).to.be.revertedWith("Interval too small");
    });

    it("should reject zero amount", async function () {
      const { subscription, token, receiver, sender } = await loadFixture(deployFixture);
      await expect(
        subscription.connect(sender).createSubscription(receiver.address, await token.getAddress(), 0, 3600)
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("should reject insufficient allowance", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await token.connect(sender).approve(await subscription.getAddress(), amount - 1n);
      await expect(
        subscription.connect(sender).createSubscription(receiver.address, await token.getAddress(), amount, 3600)
      ).to.be.revertedWith("Insufficient allowance");
    });
  });

  describe("activate", function () {
    it("should transfer initial amount and create subscription", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      const interval = 30 * 24 * 60 * 60;
      const initialAmount = ethers.parseUnits("50", 6);

      const receiverBefore = await token.balanceOf(receiver.address);

      const tx = await subscription.connect(sender).activate(
        receiver.address,
        await token.getAddress(),
        initialAmount,
        amount,
        interval
      );

      await expect(tx).to.emit(subscription, "SubscriptionCreated");

      const receiverAfter = await token.balanceOf(receiver.address);
      expect(receiverAfter - receiverBefore).to.equal(initialAmount);

      const sub = await subscription.getSubscription(0);
      expect(sub.amount).to.equal(amount);
    });

    it("should work with zero initial amount", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await expect(
        subscription.connect(sender).activate(receiver.address, await token.getAddress(), 0, amount, 3600)
      ).to.emit(subscription, "SubscriptionCreated");
    });
  });

  describe("executeSubscription", function () {
    it("should execute payment when due and emit PaymentExecuted", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      const interval = 3600;

      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, interval
      );

      await time.increase(interval + 1);

      const receiverBefore = await token.balanceOf(receiver.address);
      const tx = await subscription.executeSubscription(0);
      await expect(tx).to.emit(subscription, "PaymentExecuted");

      const receiverAfter = await token.balanceOf(receiver.address);
      expect(receiverAfter - receiverBefore).to.equal(amount);

      const sub = await subscription.getSubscription(0);
      expect(sub.paymentCount).to.equal(1);
      expect(sub.totalPaid).to.equal(amount);
    });

    it("should reject execution before due time", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );

      await expect(subscription.executeSubscription(0)).to.be.revertedWith("Too early");
    });

    it("should reject duplicate execution in same period", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );

      await time.increase(3601);
      await subscription.executeSubscription(0);

      await expect(subscription.executeSubscription(0)).to.be.revertedWith("Too early");
    });

    it("should reject execution with insufficient allowance", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      const interval = 3600;
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, interval
      );
      await time.increase(interval + 1);
      await token.connect(sender).approve(await subscription.getAddress(), 0);

      await expect(subscription.executeSubscription(0)).to.be.revertedWith("Insufficient allowance");
    });

    it("should handle missed periods correctly", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      const interval = 3600;
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, interval
      );

      await time.increase(interval * 5 + 1); // miss 5 periods
      await subscription.executeSubscription(0);

      const sub = await subscription.getSubscription(0);
      expect(sub.paymentCount).to.equal(1); // still 1 execution
    });
  });

  describe("cancelSubscription", function () {
    it("should allow sender to cancel", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );

      const tx = await subscription.connect(sender).cancelSubscription(0);
      await expect(tx).to.emit(subscription, "SubscriptionCancelled").withArgs(0);

      const sub = await subscription.getSubscription(0);
      expect(sub.active).to.be.false;
    });

    it("should allow receiver to cancel", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );

      await expect(subscription.connect(receiver).cancelSubscription(0))
        .to.emit(subscription, "SubscriptionCancelled");
    });

    it("should reject cancel from unauthorized address", async function () {
      const { subscription, token, receiver, sender, newReceiver, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );

      await expect(subscription.connect(newReceiver).cancelSubscription(0))
        .to.be.revertedWith("Not authorized");
    });

    it("should prevent execution after cancel", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );
      await subscription.connect(sender).cancelSubscription(0);
      await time.increase(3601);

      await expect(subscription.executeSubscription(0)).to.be.revertedWith("Subscription not active");
    });
  });

  describe("updateReceiver", function () {
    it("should only allow owner to update receiver", async function () {
      const { subscription, token, receiver, sender, newReceiver, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );

      await expect(
        subscription.connect(sender).updateReceiver(0, newReceiver.address)
      ).to.be.revertedWith("Not owner");
    });

    it("should allow owner to update receiver", async function () {
      const { subscription, token, receiver, sender, owner, newReceiver, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );

      const tx = await subscription.connect(owner).updateReceiver(0, newReceiver.address);
      await expect(tx).to.emit(subscription, "ReceiverUpdated")
        .withArgs(0, receiver.address, newReceiver.address);

      const sub = await subscription.getSubscription(0);
      expect(sub.receiver).to.equal(newReceiver.address);
    });
  });

  describe("isDue / hasEnoughAllowance", function () {
    it("isDue returns false before interval", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );
      expect(await subscription.isDue(0)).to.be.false;
    });

    it("isDue returns true after interval", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );
      await time.increase(3601);
      expect(await subscription.isDue(0)).to.be.true;
    });

    it("hasEnoughAllowance returns false when allowance revoked", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await subscription.connect(sender).createSubscription(
        receiver.address, await token.getAddress(), amount, 3600
      );
      await token.connect(sender).approve(await subscription.getAddress(), 0);
      expect(await subscription.hasEnoughAllowance(0)).to.be.false;
    });
  });
});
