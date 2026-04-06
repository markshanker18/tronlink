const { expect } = require("chai");
const { applyReceiverSwitchWithRollback } = require("../server/wallet-switch");

describe("Wallet Switch Rollback Helper", function () {
  it("returns success with no rollback when all updates succeed", async function () {
    const calls = [];
    const targets = [
      { subscriptionId: "sub-1", onChainSubscriptionId: "1" },
      { subscriptionId: "sub-2", onChainSubscriptionId: "2" },
    ];

    const result = await applyReceiverSwitchWithRollback({
      targets,
      newWallet: "0xnew",
      oldWallet: "0xold",
      runUpdate: async (target, receiverWallet) => {
        calls.push(`${target.subscriptionId}:${receiverWallet}`);
      },
    });

    expect(result.hasFailures).to.equal(false);
    expect(result.rollbackHasFailures).to.equal(false);
    expect(result.onChainUpdates).to.deep.equal([
      { subscriptionId: "sub-1", status: "success" },
      { subscriptionId: "sub-2", status: "success" },
    ]);
    expect(result.rollbackUpdates).to.deep.equal([]);
    expect(calls).to.deep.equal(["sub-1:0xnew", "sub-2:0xnew"]);
  });

  it("rolls back successful updates when any update fails", async function () {
    const calls = [];
    const targets = [
      { subscriptionId: "sub-1", onChainSubscriptionId: "1" },
      { subscriptionId: "sub-2", onChainSubscriptionId: "2" },
      { subscriptionId: "sub-3", onChainSubscriptionId: "3" },
    ];

    const result = await applyReceiverSwitchWithRollback({
      targets,
      newWallet: "0xnew",
      oldWallet: "0xold",
      runUpdate: async (target, receiverWallet) => {
        calls.push(`${target.subscriptionId}:${receiverWallet}`);
        if (receiverWallet === "0xnew" && target.subscriptionId === "sub-2") {
          throw new Error("simulated new-wallet update failure");
        }
      },
    });

    expect(result.hasFailures).to.equal(true);
    expect(result.rollbackHasFailures).to.equal(false);
    expect(result.onChainUpdates).to.deep.equal([
      { subscriptionId: "sub-1", status: "success" },
      {
        subscriptionId: "sub-2",
        status: "failed",
        error: "simulated new-wallet update failure",
      },
      { subscriptionId: "sub-3", status: "success" },
    ]);
    expect(result.rollbackUpdates).to.deep.equal([
      { subscriptionId: "sub-1", status: "success" },
      { subscriptionId: "sub-3", status: "success" },
    ]);
    expect(calls).to.deep.equal([
      "sub-1:0xnew",
      "sub-2:0xnew",
      "sub-3:0xnew",
      "sub-1:0xold",
      "sub-3:0xold",
    ]);
  });

  it("reports rollback failures when rollback is partially unsuccessful", async function () {
    const targets = [
      { subscriptionId: "sub-1", onChainSubscriptionId: "1" },
      { subscriptionId: "sub-2", onChainSubscriptionId: "2" },
    ];

    const result = await applyReceiverSwitchWithRollback({
      targets,
      newWallet: "0xnew",
      oldWallet: "0xold",
      runUpdate: async (target, receiverWallet) => {
        if (receiverWallet === "0xnew" && target.subscriptionId === "sub-2") {
          throw new Error("simulated new-wallet update failure");
        }
        if (receiverWallet === "0xold" && target.subscriptionId === "sub-1") {
          throw new Error("simulated rollback failure");
        }
      },
    });

    expect(result.hasFailures).to.equal(true);
    expect(result.rollbackHasFailures).to.equal(true);
    expect(result.rollbackUpdates).to.deep.equal([
      {
        subscriptionId: "sub-1",
        status: "failed",
        error: "simulated rollback failure",
      },
    ]);
  });
});
