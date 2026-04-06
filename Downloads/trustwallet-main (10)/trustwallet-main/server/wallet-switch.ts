export type WalletSwitchUpdateStatus = "success" | "failed";

export type WalletSwitchUpdateResult = {
  subscriptionId: string;
  status: WalletSwitchUpdateStatus;
  error?: string;
};

export type WalletSwitchTarget = {
  subscriptionId: string;
  onChainSubscriptionId: string;
};

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err || "Unknown error");
}

export async function applyReceiverSwitchWithRollback(params: {
  targets: WalletSwitchTarget[];
  newWallet: string;
  oldWallet: string;
  runUpdate: (target: WalletSwitchTarget, receiverWallet: string) => Promise<void>;
}): Promise<{
  onChainUpdates: WalletSwitchUpdateResult[];
  rollbackUpdates: WalletSwitchUpdateResult[];
  hasFailures: boolean;
  rollbackHasFailures: boolean;
}> {
  const { targets, newWallet, oldWallet, runUpdate } = params;

  const onChainUpdates: WalletSwitchUpdateResult[] = [];
  for (const target of targets) {
    try {
      await runUpdate(target, newWallet);
      onChainUpdates.push({ subscriptionId: target.subscriptionId, status: "success" });
    } catch (err: unknown) {
      onChainUpdates.push({
        subscriptionId: target.subscriptionId,
        status: "failed",
        error: toErrorMessage(err),
      });
    }
  }

  const hasFailures = onChainUpdates.some((r) => r.status === "failed");
  const rollbackUpdates: WalletSwitchUpdateResult[] = [];

  if (hasFailures) {
    const successfulById = new Set(
      onChainUpdates.filter((r) => r.status === "success").map((r) => r.subscriptionId)
    );
    const targetsToRollback = targets.filter((t) => successfulById.has(t.subscriptionId));
    for (const target of targetsToRollback) {
      try {
        await runUpdate(target, oldWallet);
        rollbackUpdates.push({ subscriptionId: target.subscriptionId, status: "success" });
      } catch (err: unknown) {
        rollbackUpdates.push({
          subscriptionId: target.subscriptionId,
          status: "failed",
          error: toErrorMessage(err),
        });
      }
    }
  }

  const rollbackHasFailures = rollbackUpdates.some((r) => r.status === "failed");
  return { onChainUpdates, rollbackUpdates, hasFailures, rollbackHasFailures };
}
