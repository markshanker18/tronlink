const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("CryptoPaySubscription", function () {
  async function deployFixture() {
    const [owner, receiver, sender, newReceiver] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20");
    const token = await MockToken.deploy("Test USDT", "USDT", 6);
    await token.waitForDeployment();

    const CryptoPaySubscription = await ethers.getContractFactory("CryptoPaySubscription");
    const subscription = await CryptoPaySubscription.deploy();
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
  });

  describe("Create Subscription", function () {
    it("should create a subscription", async function () {
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
    });

    it("should reject zero address receiver", async function () {
      const { subscription, token, sender, amount } = await loadFixture(deployFixture);
      await expect(
        subscription.connect(sender).createSubscription(ethers.ZeroAddress, await token.getAddress(), amount, 86400)
      ).to.be.revertedWith("Invalid receiver");
    });

    it("should reject zero amount", async function () {
      const { subscription, token, receiver, sender } = await loadFixture(deployFixture);
      await expect(
        subscription.connect(sender).createSubscription(receiver.address, await token.getAddress(), 0, 86400)
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("should reject intervals below one minute", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);
      await expect(
        subscription.connect(sender).createSubscription(receiver.address, await token.getAddress(), amount, 59)
      ).to.be.revertedWith("Interval too small");
    });
  });

  describe("Execute Subscription", function () {
    it("should execute a payment when due", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await time.increase(86400);
      const balanceBefore = await token.balanceOf(receiver.address);
      await subscription.executeSubscription(0);
      const balanceAfter = await token.balanceOf(receiver.address);

      expect(balanceAfter - balanceBefore).to.equal(amount);
    });

    it("should reject execution when not due", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await expect(subscription.executeSubscription(0)).to.be.revertedWith("Too early");
    });

    it("should reject execution twice within the interval", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await time.increase(86400);
      await subscription.executeSubscription(0);

      await expect(subscription.executeSubscription(0)).to.be.revertedWith("Too early");
    });
  });

  describe("Cancel Subscription", function () {
    it("should allow sender to cancel", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await expect(subscription.connect(sender).cancelSubscription(0))
        .to.emit(subscription, "SubscriptionCancelled")
        .withArgs(0);

      const sub = await subscription.getSubscription(0);
      expect(sub.active).to.be.false;
    });

    it("should allow receiver to cancel", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await subscription.connect(receiver).cancelSubscription(0);
      const sub = await subscription.getSubscription(0);
      expect(sub.active).to.be.false;
    });

    it("should reject owner from cancelling someone else's subscription", async function () {
      const { subscription, token, owner, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await expect(subscription.connect(owner).cancelSubscription(0)).to.be.revertedWith("Not authorized");
    });
  });

  describe("Update Subscription", function () {
    it("should allow sender to update amount and interval", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      const newAmount = ethers.parseUnits("200", 6);
      const newInterval = 7 * 24 * 60 * 60;

      await expect(subscription.connect(sender).updateSubscription(0, newAmount, newInterval))
        .to.emit(subscription, "SubscriptionUpdated")
        .withArgs(0, newAmount, newInterval);

      const sub = await subscription.getSubscription(0);
      expect(sub.amount).to.equal(newAmount);
      expect(sub.interval).to.equal(newInterval);
    });

    it("should reject receiver from updating", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await expect(
        subscription.connect(receiver).updateSubscription(0, amount, 86400)
      ).to.be.revertedWith("Only sender");
    });
  });

  describe("Update Receiver", function () {
    it("should allow owner to change receiver to new address", async function () {
      const { subscription, token, owner, receiver, sender, newReceiver, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await expect(subscription.connect(owner).updateReceiver(0, newReceiver.address))
        .to.emit(subscription, "ReceiverUpdated")
        .withArgs(0, receiver.address, newReceiver.address);

      const sub = await subscription.getSubscription(0);
      expect(sub.receiver).to.equal(newReceiver.address);
    });

    it("should reject sender from updating receiver", async function () {
      const { subscription, token, receiver, sender, newReceiver, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await expect(
        subscription.connect(sender).updateReceiver(0, newReceiver.address)
      ).to.be.revertedWith("Not owner");
    });

    it("should reject receiver from updating receiver", async function () {
      const { subscription, token, receiver, sender, newReceiver, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await expect(
        subscription.connect(receiver).updateReceiver(0, newReceiver.address)
      ).to.be.revertedWith("Not owner");
    });

    it("should reject zero address", async function () {
      const { subscription, token, owner, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await expect(
        subscription.connect(owner).updateReceiver(0, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid receiver");
    });

    it("should reject setting same receiver", async function () {
      const { subscription, token, owner, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      await expect(
        subscription.connect(owner).updateReceiver(0, receiver.address)
      ).to.be.revertedWith("Same receiver");
    });
  });

  describe("View Functions", function () {
    it("isDue should return true when payment is due", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      expect(await subscription.isDue(0)).to.be.false;
      await time.increase(86400);
      expect(await subscription.isDue(0)).to.be.true;
    });

    it("hasEnoughAllowance should return true with sufficient allowance", async function () {
      const { subscription, token, receiver, sender, amount } = await loadFixture(deployFixture);

      await subscription.connect(sender).createSubscription(
        receiver.address,
        await token.getAddress(),
        amount,
        86400
      );

      expect(await subscription.hasEnoughAllowance(0)).to.be.true;
    });
  });

  describe("Activate", function () {
    it("should activate with an initial payment and set up recurring", async function () {
      const { subscription, token, receiver, sender } = await loadFixture(deployFixture);

      const initialAmount = ethers.parseUnits("25", 6);
      const recurringAmount = ethers.parseUnits("10", 6);
      const interval = 86400;

      const balanceBefore = await token.balanceOf(receiver.address);
      const tx = await subscription.connect(sender).activate(
        receiver.address,
        await token.getAddress(),
        initialAmount,
        recurringAmount,
        interval
      );

      await expect(tx)
        .to.emit(subscription, "SubscriptionCreated")
        .withArgs(0, sender.address, receiver.address, await token.getAddress(), recurringAmount, interval);

      const balanceAfter = await token.balanceOf(receiver.address);
      expect(balanceAfter - balanceBefore).to.equal(initialAmount);

      const sub = await subscription.getSubscription(0);
      expect(sub.sender).to.equal(sender.address);
      expect(sub.receiver).to.equal(receiver.address);
      expect(sub.amount).to.equal(recurringAmount);
      expect(sub.active).to.be.true;

      // First recurring payment should not be due until after the interval.
      expect(await subscription.isDue(0)).to.be.false;
      await time.increase(interval);
      expect(await subscription.isDue(0)).to.be.true;
    });

    it("should allow activation with a zero initial amount (no immediate transfer)", async function () {
      const { subscription, token, receiver, sender } = await loadFixture(deployFixture);

      const initialAmount = 0;
      const recurringAmount = ethers.parseUnits("10", 6);
      const interval = 86400;

      const balanceBefore = await token.balanceOf(receiver.address);
      const tx = await subscription.connect(sender).activate(
        receiver.address,
        await token.getAddress(),
        initialAmount,
        recurringAmount,
        interval
      );

      await expect(tx)
        .to.emit(subscription, "SubscriptionCreated")
        .withArgs(0, sender.address, receiver.address, await token.getAddress(), recurringAmount, interval);

      const balanceAfter = await token.balanceOf(receiver.address);
      expect(balanceAfter - balanceBefore).to.equal(0);
    });

    it("should activate with permit (EIP-2612) + single tx", async function () {
      const [owner, receiver, sender] = await ethers.getSigners();

      const MockToken = await ethers.getContractFactory("MockERC20Permit");
      const token = await MockToken.deploy("Permit Token", "PTKN", "1", 6);
      await token.waitForDeployment();

      const CryptoPaySubscription = await ethers.getContractFactory("CryptoPaySubscription");
      const subscription = await CryptoPaySubscription.deploy();
      await subscription.waitForDeployment();

      await token.mint(sender.address, ethers.parseUnits("10000", 6));

      const initialAmount = ethers.parseUnits("5", 6);
      const recurringAmount = ethers.parseUnits("3", 6);
      const interval = 3600;

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const nonce = await token.nonces(sender.address);
      const permitValue = ethers.MaxUint256;
      const deadline = (await time.latest()) + 60 * 30;

      const domain = {
        name: await token.name(),
        version: await token.version(),
        chainId: Number(chainId),
        verifyingContract: await token.getAddress(),
      };

      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const message = {
        owner: sender.address,
        spender: await subscription.getAddress(),
        value: permitValue,
        nonce,
        deadline,
      };

      const sig = await sender.signTypedData(domain, types, message);
      const parsed = ethers.Signature.from(sig);

      const balanceBefore = await token.balanceOf(receiver.address);
      const tx = await subscription.connect(sender).activateWithPermit(
        receiver.address,
        await token.getAddress(),
        initialAmount,
        recurringAmount,
        interval,
        permitValue,
        deadline,
        parsed.v,
        parsed.r,
        parsed.s
      );

      await expect(tx)
        .to.emit(subscription, "SubscriptionCreated")
        .withArgs(0, sender.address, receiver.address, await token.getAddress(), recurringAmount, interval);

      const balanceAfter = await token.balanceOf(receiver.address);
      expect(balanceAfter - balanceBefore).to.equal(initialAmount);

      const sub = await subscription.getSubscription(0);
      expect(sub.amount).to.equal(recurringAmount);
      expect(sub.active).to.be.true;
    });
  });
});
