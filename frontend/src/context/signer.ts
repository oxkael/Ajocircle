import { Account, PublicKey, Signer } from 'near-api-js';
import type { JsonRpcProvider } from 'near-api-js';
import type { useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

type SignRawHash = ReturnType<typeof useSignRawHash>['signRawHash'];

export class privySigner extends Signer {
  private signRawHash: SignRawHash;
  private nearAccountId: string;
  private privyAddress: string;
  private provider: JsonRpcProvider;

  constructor(
    signRawHash: SignRawHash,
    nearAccountId: string,
    provider: JsonRpcProvider,
    privyAddress = nearAccountId,
  ) {
    super();
    this.signRawHash = signRawHash;
    this.nearAccountId = nearAccountId;
    this.privyAddress = privyAddress;
    this.provider = provider;
  }

  async getPublicKey() {
    const implicitKey = this.nearAccountId.replace(/^0x/i, '');
    if (/^[a-f0-9]{64}$/i.test(implicitKey)) {
      return new PublicKey({ keyType: 0, data: hexToBytes(implicitKey) });
    }
    const account = new Account(this.nearAccountId, this.provider);
    const { keys } = await account.getAccessKeyList();
    if (!keys.length) throw new Error('The account has no registered access key');
    return PublicKey.fromString(keys[0].public_key);
  }

  async signBytes(bytes: Uint8Array) {
    const request = {
      address: this.privyAddress,
      chainType: 'near' as const,
      hash: `0x${bytesToHex(bytes)}` as `0x${string}`,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { signature } = await this.signRawHash(request);
        return hexToBytes(signature.replace(/^0x/, ''));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const walletProxyNotReady = message.includes('Wallet proxy not initialized');
        if (!walletProxyNotReady || attempt === 1) throw error;

        // Privy's extended-chain signer initializes its wallet proxy lazily.
        // Give that initialization a brief chance to settle, then retry only
        // the signature request (the NEAR transaction has not been submitted).
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    }

    throw new Error('We could not approve this action. Please try again.');
  }
}
