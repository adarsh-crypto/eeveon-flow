/**
 * src/background/vault.ts against a fake chrome.storage.local. Node's global crypto.subtle
 * / btoa / atob are the real Web Crypto implementation, so this exercises the actual
 * encrypt/decrypt path, not a mock of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MemoryStore {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (values: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

function memoryStore(): MemoryStore {
  const data: Record<string, unknown> = {};
  return {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (values: Record<string, unknown>) => {
      Object.assign(data, values);
    },
    remove: async (key: string) => {
      delete data[key];
    },
  };
}

function installChrome() {
  vi.stubGlobal('chrome', { storage: { local: memoryStore() } });
}

describe('vault', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installChrome();
  });

  it('round-trips a secret through encrypt and decrypt', async () => {
    const vault = await import('../src/background/vault');
    await vault.storeSecret('flow-1', 'password', 'hunter2');
    expect(await vault.readSecret('flow-1', 'password')).toBe('hunter2');
  });

  it('returns null for a secret that was never stored', async () => {
    const vault = await import('../src/background/vault');
    expect(await vault.readSecret('flow-1', 'password')).toBeNull();
  });

  it('uses a fresh IV each time, so ciphertext differs for the same plaintext', async () => {
    const vault = await import('../src/background/vault');
    const readEntry = async () => {
      const bag = (await chrome.storage.local.get('eeveon_flow_vault_entries')) as Record<
        string,
        Record<string, { cipher: string; iv: string }>
      >;
      return bag['eeveon_flow_vault_entries']!['flow-1::a']!;
    };

    await vault.storeSecret('flow-1', 'a', 'same-value');
    const first = await readEntry();
    await vault.storeSecret('flow-1', 'a', 'same-value');
    const second = await readEntry();

    expect(first.iv).not.toBe(second.iv);
    expect(first.cipher).not.toBe(second.cipher);
    // Both still decrypt to the same plaintext — only the encoding differs, not the value.
    expect(await vault.readSecret('flow-1', 'a')).toBe('same-value');
  });

  it('stored entries never contain the plaintext', async () => {
    const vault = await import('../src/background/vault');
    await vault.storeSecret('flow-1', 'password', 'hunter2-super-secret');
    const bag = (await chrome.storage.local.get('eeveon_flow_vault_entries')) as Record<string, unknown>;
    expect(JSON.stringify(bag)).not.toContain('hunter2-super-secret');
  });

  it('hasSecret reflects presence without decrypting', async () => {
    const vault = await import('../src/background/vault');
    expect(await vault.hasSecret('flow-1', 'password')).toBe(false);
    await vault.storeSecret('flow-1', 'password', 'x');
    expect(await vault.hasSecret('flow-1', 'password')).toBe(true);
  });

  it('deleteSecret removes the entry', async () => {
    const vault = await import('../src/background/vault');
    await vault.storeSecret('flow-1', 'password', 'x');
    await vault.deleteSecret('flow-1', 'password');
    expect(await vault.hasSecret('flow-1', 'password')).toBe(false);
    expect(await vault.readSecret('flow-1', 'password')).toBeNull();
  });

  it('listSecretMeta never includes cipher or iv', async () => {
    const vault = await import('../src/background/vault');
    await vault.storeSecret('flow-1', 'password', 'x');
    const meta = await vault.listSecretMeta();
    expect(meta).toHaveLength(1);
    expect(meta[0]).toEqual({ flow_id: 'flow-1', variable: 'password', created_at: expect.any(String) });
    expect(Object.keys(meta[0]!)).not.toContain('cipher');
  });

  it('keeps the same key across calls, so a later read still works', async () => {
    const vault = await import('../src/background/vault');
    await vault.storeSecret('flow-1', 'a', 'value-a');
    await vault.storeSecret('flow-1', 'b', 'value-b');
    expect(await vault.readSecret('flow-1', 'a')).toBe('value-a');
    expect(await vault.readSecret('flow-1', 'b')).toBe('value-b');
  });
});
