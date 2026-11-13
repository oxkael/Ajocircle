import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider } from '../frontend/node_modules/near-api-js/lib/index.js';

const env = Object.fromEntries(fs.readFileSync(path.resolve('frontend', '.env.local'), 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim()]; }));
const daoId = env.AJOCIRCLE_SPIKE_DAO_ID;
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const account = await provider.viewAccount({ accountId: daoId });
const lastId = await provider.callFunction({ contractId: daoId, method: 'get_last_proposal_id', args: {} });
const pending = Number(lastId) > 1 ? await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: Number(lastId) - 1 } }) : null;
console.log(JSON.stringify({ daoId, balanceNear: (Number(BigInt(account.amount)) / 1e24).toFixed(3), nextProposalId: lastId, latestProposal: pending }, null, 2));
