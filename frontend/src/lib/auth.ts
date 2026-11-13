import { KeyPair } from 'near-api-js';

export interface UserAccount {
  id: string; // NEAR Account ID e.g. chidi-8192.testnet
  displayName: string;
  email?: string;
  authMethod: 'passkey' | 'google';
  publicKey: string;
  txHash?: string;
  nairaBalance: number;
  createdAt: number;
}

const STORAGE_KEY = 'ajopool_user_account';

export function isSecureOrigin(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.isSecureContext ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1')
  );
}

export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    window.PublicKeyCredential !== undefined &&
    typeof window.PublicKeyCredential === 'function'
  );
}

export function isInAppBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || navigator.vendor || '';
  return /FBAN|FBAV|Instagram|TikTok|MicroMessenger|Snapchat|BytedanceWebview/i.test(ua);
}

export function getCurrentUser(): UserAccount | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveUser(account: UserAccount): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
}

export function logout(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// Gasless Testnet Account Creator via official NEAR Testnet Helper
async function createNearTestnetAccount(
  desiredPrefix: string,
  publicKey: string
): Promise<{ accountId: string; txHash: string }> {
  const cleanPrefix =
    desiredPrefix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15) || 'ajo';
  const randomSuffix = Math.floor(1000 + Math.random() * 90000);
  const accountId = `${cleanPrefix}-${randomSuffix}.testnet`;

  const response = await fetch('https://helper.testnet.near.org/account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      newAccountId: accountId,
      newAccountPublicKey: publicKey,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NEAR testnet registration failed (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  const txHash =
    result?.transaction?.hash || result?.receipts_outcome?.[0]?.id || 'confirmed';
  return { accountId, txHash };
}

// 1. Passkey (WebAuthn) Registration
export async function registerWithPasskey(displayName: string): Promise<UserAccount> {
  if (!isSecureOrigin()) {
    throw new Error(
      'WebAuthn Passkey requires an HTTPS connection. Please access using HTTPS on your phone.'
    );
  }

  if (!isWebAuthnSupported()) {
    throw new Error(
      'Your browser or in-app webview does not support WebAuthn Passkeys. Please open directly in Safari or Chrome.'
    );
  }

  const cleanName = displayName.trim() || 'Savings Member';

  // Perform standard WebAuthn Ceremony
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = new TextEncoder().encode(cleanName);

  const publicKeyCredentialCreationOptions: PublicKeyCredentialCreationOptions = {
    challenge,
    rp: {
      name: 'Ajocircle Savings Circle',
      id: window.location.hostname,
    },
    user: {
      id: userId as unknown as BufferSource,
      name: cleanName,
      displayName: cleanName,
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' },
      { alg: -257, type: 'public-key' },
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred',
    },
    timeout: 60000,
  };

  try {
    await navigator.credentials.create({
      publicKey: publicKeyCredentialCreationOptions,
    });
  } catch (err: any) {
    if (err.name === 'NotAllowedError') {
      throw new Error('Biometric passkey prompt was cancelled.');
    }
    throw new Error(`Passkey error: ${err.message || err.name}`);
  }

  // Generate real NEAR keypair & register on-chain via testnet helper
  const keyPair = KeyPair.fromRandom('ed25519');
  const pubKeyString = keyPair.getPublicKey().toString();
  const { accountId, txHash } = await createNearTestnetAccount(cleanName, pubKeyString);

  // Store keypair for transaction signing
  localStorage.setItem(`near_account_key_${accountId}`, keyPair.toString());

  const user: UserAccount = {
    id: accountId,
    displayName: cleanName,
    authMethod: 'passkey',
    publicKey: pubKeyString,
    txHash,
    nairaBalance: 150000,
    createdAt: Date.now(),
  };

  saveUser(user);
  return user;
}

// 2. Google Login Flow (Laptop & Desktop)
export async function loginWithGoogleFlow(
  displayName: string,
  email: string
): Promise<UserAccount> {
  const cleanName = displayName.trim() || 'Ajo Member';

  // Generate real NEAR keypair & register on-chain via testnet helper
  const keyPair = KeyPair.fromRandom('ed25519');
  const pubKeyString = keyPair.getPublicKey().toString();
  const { accountId, txHash } = await createNearTestnetAccount(cleanName, pubKeyString);

  // Store keypair for transaction signing
  localStorage.setItem(`near_account_key_${accountId}`, keyPair.toString());

  const user: UserAccount = {
    id: accountId,
    displayName: cleanName,
    email,
    authMethod: 'google',
    publicKey: pubKeyString,
    txHash,
    nairaBalance: 150000,
    createdAt: Date.now(),
  };

  saveUser(user);
  return user;
}
