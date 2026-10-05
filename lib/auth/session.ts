/**
 * Session authentication module and canonical wallet address normalization.
 *
 * Normalizes wallet addresses at the auth boundary so all downstream lookups,
 * JWT claims, session checks, and member comparisons use the canonical
 * uppercase, whitespace-trimmed format.
 */

export * from "@/lib/supabase/session";
export { normalizeWalletAddress, canonicalAddress, areWalletAddressesEqual } from "@/lib/trip/members";
