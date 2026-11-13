import { createContext, useContext } from 'react';
import type { Account, JsonRpcProvider } from 'near-api-js';

export interface NearContextValue {
  provider: JsonRpcProvider;
  nearAccount: Account | null;
  walletId: string;
  walletLoading: boolean;
  walletError: string | null;
  retryWalletSetup: () => Promise<void>;
}

export const NearContext = createContext<NearContextValue | undefined>(undefined);

export function useNEAR(): NearContextValue {
  const context = useContext(NearContext);
  if (!context) {
    throw new Error('useNEAR must be used within a NEARxPrivy provider');
  }
  return context;
}
