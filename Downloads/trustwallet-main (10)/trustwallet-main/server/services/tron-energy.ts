/**
 * TRON Energy Automation / Cost Protection
 * 
 * Executing TRC20 transfers natively burns significant TRX (~15-30 TRX/$1.50-$3.00 per tx)
 * if the executor wallet lacks sufficient 'Energy'.
 * 
 * This service sits natively before all executeSubscription() attempts. 
 * If expected Energy < available Energy, it intercepts the call and automatically
 * pings an external marketplace (e.g. TRONNrg, TokenGoodies) to rent the missing energy
 * for pennies, deferring the execution until the energy arrives.
 */

// Arbitrary safe limit for a standard Proxy subscription trigger
const MIN_ENERGY_THRESHOLD = 80000; 

export class TronEnergyManager {
  
  /**
   * Pre-flight check on an executor wallet to ensure we don't accidentally
   * burn expensive raw TRX.
   * 
   * @param tronWeb The initialized tronWeb instance
   * @param address The base58 executor address
   */
  static async checkAndRentEnergy(tronWeb: any, address: string): Promise<boolean> {
    try {
      const resources = await tronWeb.trx.getAccountResources(address);
      
      const energyLimit = resources.EnergyLimit || 0;
      const energyUsed = resources.EnergyUsed || 0;
      const availableEnergy = energyLimit - energyUsed;

      if (availableEnergy >= MIN_ENERGY_THRESHOLD) {
        return true;
      }

      console.warn("[TronEnergy] Wallet " + address + " low on Energy (" + availableEnergy + " / " + MIN_ENERGY_THRESHOLD + ").");

      // Attempt Rental Automation only if an API key is configured
      if (process.env.TRON_RENTAL_API_KEY) {
        const rented = await this.rentEnergyFromMarketplace(address, MIN_ENERGY_THRESHOLD);
        if (rented) {
          console.log("[TronEnergy] Energy rental triggered for " + address + ". Deferring to next cycle.");
          return false; // false = defer this cycle, retry next tick
        }
      }

      // No rental configured (or rental failed) — proceed and burn TRX from executor balance.
      // The hasMinimumExecutorBalance check in the scheduler ensures sufficient TRX exists.
      console.warn("[TronEnergy] No energy rental configured. Proceeding — TRX will be burned for this execution.");
      return true;

    } catch (e: any) {
      // If the account resource query itself fails, proceed rather than blocking all executions.
      console.error("[TronEnergy] Failed to retrieve account resources:", e.message, "— proceeding with execution.");
      return true;
    }
  }

  /**
   * Stub external API integration for Energy rental.
   * Examples: TRONNrg API, TokenGoodies bulk purchasing, etc.
   */
  private static async rentEnergyFromMarketplace(targetAddress: string, amount: number): Promise<boolean> {
    if (!process.env.TRON_RENTAL_API_KEY) {
      console.log("[TronEnergy] Auto-rental disabled (missing TRON_RENTAL_API_KEY environment variable).");
      return false;
    }

    try {
      console.log(`[TronEnergy] Requesting ${amount} Energy for ${targetAddress}...`);
      
      const response = await fetch("https://api.tronnrg.com/v1/rent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.TRON_RENTAL_API_KEY}`
        },
        body: JSON.stringify({
          receiver: targetAddress,
          amount: amount,
          period: "1h"
        }),
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[TronEnergy] Marketplace error (${response.status}): ${error}`);
        return false;
      }

      console.log(`[TronEnergy] Successfully rented energy for ${targetAddress}. Waiting for propagation.`);
      return true;
    } catch (e: any) {
      console.error(`[TronEnergy] Failed to contact rental provider: ${e.message}`);
      return false;
    }
  }
}
