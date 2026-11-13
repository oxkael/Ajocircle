import { usePrivy, useUser } from '@privy-io/react-auth';
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { JsonRpcProvider, Account } from 'near-api-js';
import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { NearContext } from './useNear';
import { providerUrl } from '../config';
import { privySigner } from './signer';

const provider = new JsonRpcProvider({ url: providerUrl });

export function NEARxPrivy({ children }: PropsWithChildren) {
  const { ready: privyReady, authenticated, user } = usePrivy();
  const { refreshUser } = useUser();
  const [walletId, setWalletId] = useState('');
  const [nearAccount, setNearAccount] = useState<Account | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [provisionedWallet, setProvisionedWallet] = useState<{ userId: string; address: string } | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  const { signRawHash } = useSignRawHash();
  const { createWallet } = useCreateWallet();
  const creatingWallet = useRef(false);
  const initializingAttempt = useRef('');

  const retryWalletSetup = useCallback(async () => {
    setNearAccount(null);
    setWalletId('');
    setWalletError(null);
    setWalletLoading(true);
    initializingAttempt.current = '';

    try {
      const refreshedUser = await refreshUser();
      const nearWallet = refreshedUser.linkedAccounts.find(
        (account) => account.type === 'wallet' && account.chainType === 'near'
      );
      if (nearWallet?.type === 'wallet') {
        setProvisionedWallet({ userId: refreshedUser.id, address: nearWallet.address });
      }
    } catch (error) {
      console.warn('Could not refresh Privy wallet details before retrying', error);
    } finally {
      setRetryKey((key) => key + 1);
    }
  }, [refreshUser]);

  useEffect(() => {
    if (!privyReady) {
      setWalletLoading(true);
      return;
    }

    if (!authenticated || !user) {
      initializingAttempt.current = '';
      creatingWallet.current = false;
      setProvisionedWallet(null);
      setWalletId('');
      setNearAccount(null);
      setWalletLoading(false);
      setWalletError(null);
      return;
    }

    const linkedNearWallet = user.linkedAccounts.find(
      (account) => account.type === 'wallet' && account.chainType === 'near'
    );
    const provisionedAddress = provisionedWallet?.userId === user.id
      ? provisionedWallet.address
      : '';
    const nearWalletAddress = linkedNearWallet?.type === 'wallet'
      ? linkedNearWallet.address
      : provisionedAddress;

    if (!nearWalletAddress) {
      setWalletLoading(true);
      setWalletError(null);
      if (creatingWallet.current) return;

      creatingWallet.current = true;
      void (async () => {
        try {
          const { user: refreshedUser, wallet } = await createWallet({ chainType: 'near' });
          const refreshedNearWallet = refreshedUser.linkedAccounts.find(
            (account) => account.type === 'wallet' && account.chainType === 'near'
          );
          const address = refreshedNearWallet?.type === 'wallet'
            ? refreshedNearWallet.address
            : wallet.address;
          setProvisionedWallet({ userId: refreshedUser.id, address });
        } catch (error) {
          console.error('Could not create NEAR wallet', error);
          setWalletError('We could not prepare your account. Try again.');
          setWalletLoading(false);
        } finally {
          creatingWallet.current = false;
        }
      })();
      return;
    }

    const attemptId = `${user.id}:${nearWalletAddress}:${retryKey}`;
    if (initializingAttempt.current === attemptId) return;
    initializingAttempt.current = attemptId;
    setWalletLoading(true);
    setWalletError(null);
    setNearAccount(null);
    setWalletId('');

    void (async () => {
      try {
        const embeddedSigner = new privySigner(signRawHash, nearWalletAddress, provider);
        const publicKey = (await embeddedSigner.getPublicKey()).toString();
        const implicitAccountId = nearWalletAddress.replace(/^0x/i, '').toLowerCase();
        const storageKey = `ajocircle:near-account:${nearWalletAddress}`;
        let accountId = '';

        if (/^[a-f0-9]{64}$/.test(implicitAccountId)) {
          try {
            await provider.viewAccount({ accountId: implicitAccountId });
            accountId = implicitAccountId;
          } catch {
            // A newly created Privy key has no funded implicit account yet.
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

        if (initializingAttempt.current !== attemptId) return;
        const signer = new privySigner(signRawHash, accountId, provider, nearWalletAddress);
        setNearAccount(new Account(accountId, provider, signer));
        setWalletId(accountId);
      } catch (error) {
        console.error('Could not prepare NEAR testnet account', error);
        if (initializingAttempt.current === attemptId) {
          initializingAttempt.current = '';
          setNearAccount(null);
          setWalletId('');
          setWalletError('We could not prepare your NEAR account. Try again.');
        }
      } finally {
        if (initializingAttempt.current === attemptId) setWalletLoading(false);
      }
    })();
  }, [privyReady, authenticated, user, createWallet, signRawHash, provisionedWallet, retryKey]);

  return (
    <NearContext.Provider value={{ provider, nearAccount, walletId, walletLoading, walletError, retryWalletSetup }}>
      {children}
    </NearContext.Provider>
  );
}
