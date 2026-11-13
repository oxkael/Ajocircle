import { usePrivy } from '@privy-io/react-auth';
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { JsonRpcProvider, Account } from 'near-api-js';
import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { NearContext } from './useNear';
import { providerUrl } from '../config';
import { privySigner } from './signer';

const provider = new JsonRpcProvider({ url: providerUrl });

export function NEARxPrivy({ children }: PropsWithChildren) {
  const { ready: privyReady, authenticated, user } = usePrivy();
  const [walletId, setWalletId] = useState('');
  const [nearAccount, setNearAccount] = useState<Account | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const { signRawHash } = useSignRawHash();
  const { createWallet } = useCreateWallet();
  const creatingWallet = useRef(false);
  const initializingAddress = useRef('');

  useEffect(() => {
    if (!privyReady) {
      setWalletLoading(true);
      return;
    }

    if (!authenticated || !user) {
      initializingAddress.current = '';
      setWalletId('');
      setNearAccount(null);
      setWalletLoading(false);
      setWalletError(null);
      return;
    }

    // Select the NEAR wallet explicitly
    const nearWallet = user.linkedAccounts.find(
      (account) => account.type === 'wallet' && account.chainType === 'near'
    );

    if (nearWallet?.type !== 'wallet') {
      if (!creatingWallet.current) {
        creatingWallet.current = true;
        setWalletLoading(true);
        setWalletError(null);
        createWallet({ chainType: 'near' })
          .catch((error) => {
            console.error('Could not create NEAR wallet', error);
            setWalletError(error instanceof Error ? error.message : 'Could not create your NEAR wallet.');
          })
          .finally(() => {
            creatingWallet.current = false;
            setWalletLoading(false);
          });
      }
      return;
    }

    if (initializingAddress.current === nearWallet.address) return;
    initializingAddress.current = nearWallet.address;
    setWalletLoading(true);
    setWalletError(null);

    void (async () => {
      try {
        const embeddedSigner = new privySigner(signRawHash, nearWallet.address, provider);
        const publicKey = (await embeddedSigner.getPublicKey()).toString();
        const implicitAccountId = nearWallet.address.replace(/^0x/i, '').toLowerCase();
        const storageKey = `ajocircle:near-account:${nearWallet.address}`;
        let accountId = '';
        if (/^[a-f0-9]{64}$/.test(implicitAccountId)) {
          try {
            await provider.viewAccount({ accountId: implicitAccountId });
            accountId = implicitAccountId;
          } catch {
            // A new Privy key has no funded implicit account yet. The testnet helper creates one.
          }
        }
        const savedAccountId = window.localStorage.getItem(storageKey);
        if (savedAccountId) {
          try {
            await provider.viewAccount({ accountId: savedAccountId });
            accountId = savedAccountId;
          } catch {
            window.localStorage.removeItem(storageKey);
          }
        }

        if (!accountId) {
          accountId = `ajo-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}.testnet`;
          const response = await fetch('https://helper.testnet.near.org/account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
          });
          if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Could not prepare your testnet account (${response.status}): ${detail}`);
          }
          window.localStorage.setItem(storageKey, accountId);
        }

        if (initializingAddress.current !== nearWallet.address) return;
        const signer = new privySigner(signRawHash, accountId, provider, nearWallet.address);
        setNearAccount(new Account(accountId, provider, signer));
        setWalletId(accountId);
      } catch (error) {
        console.error('Could not prepare NEAR testnet account', error);
        setNearAccount(null);
        setWalletId('');
        setWalletError(error instanceof Error ? error.message : 'Could not prepare your NEAR testnet account.');
      } finally {
        if (initializingAddress.current === nearWallet.address) setWalletLoading(false);
      }
    })();
  }, [privyReady, authenticated, user, createWallet, signRawHash]);

  return (
    <NearContext.Provider value={{ provider, nearAccount, walletId, walletLoading, walletError }}>
      {children}
    </NearContext.Provider>
  );
}
