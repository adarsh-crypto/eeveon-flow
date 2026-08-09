/**
 * A single credential an automation needs to run unattended. See
 * src/background/vault.ts for the encrypt/decrypt logic and the key-custody trade-off this
 * phase accepts (extension-managed key, not user-passphrase-derived — real auth arrives
 * with the future cloud API).
 */
export interface VaultEntry {
  flow_id: string;
  /** Matches a FlowVariable.name of kind "secret" on that flow. */
  variable: string;
  /** Base64 AES-GCM ciphertext. */
  cipher: string;
  /** Base64 initialization vector, unique per encryption. */
  iv: string;
  created_at: string;
}

export type VaultEntryId = `${string}::${string}`;

export function vaultEntryId(flowId: string, variable: string): VaultEntryId {
  return `${flowId}::${variable}`;
}
