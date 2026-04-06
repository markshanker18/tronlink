/**
 * Shared address utilities for EVM and TRON.
 * Ensures consistent validation and representation across frontend and backend.
 */

import { getAddress, isAddress } from "ethers";

const TRON_ADDRESS_REGEX = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export const AddressUtils = {
  /**
   * Validates an address for the given chain type.
   */
  isValid(address: string | null | undefined, chainType: "evm" | "tron"): boolean {
    if (!address) return false;
    if (chainType === "evm") {
      return isAddress(address);
    }
    return TRON_ADDRESS_REGEX.test(address);
  },

  /**
   * Normalizes an address based on chain standards.
   * EVM: Checksum format (e.g. 0xAb12...)
   * TRON: Base58Check T-address (preserved exactly)
   */
  normalize(address: string, chainType: "evm" | "tron"): string {
    if (chainType === "evm") {
      try {
        return getAddress(address);
      } catch {
        return address.toLowerCase();
      }
    }
    return address; // TRON is case-sensitive Base58
  },

  /**
   * Shortens an address for UI display.
   */
  shorten(address: string | null | undefined): string {
    if (!address) return "";
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  },

  /**
   * Compares two addresses for equality based on chain rules.
   */
  isEqual(addr1: string, addr2: string, chainType: "evm" | "tron"): boolean {
    if (chainType === "evm") {
      return addr1.toLowerCase() === addr2.toLowerCase();
    }
    return addr1 === addr2; // TRON is case-sensitive
  }
};
