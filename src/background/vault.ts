/**
 * Credential vault — encrypts secrets an automation needs at rest in chrome.storage.local.
 *
 * Key custody for this phase: a random AES-GCM key is generated once and stored (as raw
 * bytes) in the same chrome.storage.local the ciphertext lives in — no user passphrase, no
 * unlock step, matching eeveon-deploy's SecretsManager model of "key sits next to what it
 * protects." This stops a casual read of the extension's on-disk storage from handing over
 * plaintext credentials; it does not stop something that can already run code as the user.
 * That stronger bar — independent key custody backed by real auth — is deliberately out of
 * scope here and arrives with a future cloud-backed vault.
 */
import type { VaultEntry, VaultEntryId } from '../types/vault';
import { vaultEntryId } from '../types/vault';

const KEY_STORAGE_KEY = 'eeveon_flow_vault_key';
const ENTRIES_STORAGE_KEY = 'eeveon_flow_vault_entries';
const AES_LENGTH = 256;

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getOrCreateKey(): Promise<CryptoKey> {
  const bag = await chrome.storage.local.get(KEY_STORAGE_KEY);
  const existing = bag[KEY_STORAGE_KEY] as string | undefined;

  if (existing) {
    return crypto.subtle.importKey('raw', base64ToBytes(existing), { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  }

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: AES_LENGTH }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = await crypto.subtle.exportKey('raw', key);
  await chrome.storage.local.set({ [KEY_STORAGE_KEY]: bytesToBase64(raw) });
  return key;
}

async function readEntries(): Promise<Record<VaultEntryId, VaultEntry>> {
  const bag = await chrome.storage.local.get(ENTRIES_STORAGE_KEY);
  return (bag[ENTRIES_STORAGE_KEY] as Record<VaultEntryId, VaultEntry> | undefined) ?? {};
}

async function writeEntries(entries: Record<VaultEntryId, VaultEntry>): Promise<void> {
  await chrome.storage.local.set({ [ENTRIES_STORAGE_KEY]: entries });
}

export async function storeSecret(flowId: string, variable: string, plaintext: string): Promise<void> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  const entries = await readEntries();
  const id = vaultEntryId(flowId, variable);
  entries[id] = {
    flow_id: flowId,
    variable,
    cipher: bytesToBase64(cipherBuffer),
    iv: bytesToBase64(iv.buffer),
    created_at: new Date().toISOString(),
  };
  await writeEntries(entries);
}

/** Returns null if no secret has been stored for this flow+variable. */
export async function readSecret(flowId: string, variable: string): Promise<string | null> {
  const entries = await readEntries();
  const entry = entries[vaultEntryId(flowId, variable)];
  if (!entry) return null;

  const key = await getOrCreateKey();
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(entry.iv) },
    key,
    base64ToBytes(entry.cipher),
  );
  return new TextDecoder().decode(plainBuffer);
}

export async function hasSecret(flowId: string, variable: string): Promise<boolean> {
  const entries = await readEntries();
  return vaultEntryId(flowId, variable) in entries;
}

export async function deleteSecret(flowId: string, variable: string): Promise<void> {
  const entries = await readEntries();
  delete entries[vaultEntryId(flowId, variable)];
  await writeEntries(entries);
}

/** Metadata only — never returns cipher/iv to a caller that doesn't need to decrypt. */
export async function listSecretMeta(): Promise<Array<Pick<VaultEntry, 'flow_id' | 'variable' | 'created_at'>>> {
  const entries = await readEntries();
  return Object.values(entries).map(({ flow_id, variable, created_at }) => ({ flow_id, variable, created_at }));
}
