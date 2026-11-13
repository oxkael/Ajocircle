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
    const { signature } = await this.signRawHash({
      address: this.privyAddress,
      chainType: 'near',
      hash: `0x${bytesToHex(bytes)}`,
    });
    return hexToBytes(signature.replace(/^0x/, ''));
  }
}
