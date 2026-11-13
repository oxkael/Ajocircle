import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider } from '../frontend/node_modules/near-api-js/lib/index.js';

const envPath = path.resolve('frontend', '.env.local');
const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
const accountId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const circles = await provider.callFunction({ contractId: accountId, method: 'get_circles', args: {} });
const daoView = await provider.callFunction({ contractId: accountId, method: 'get_circle_dao', args: { circle_id: 0 } });
console.log(JSON.stringify({
  accountId,
  circleCount: circles.length,
  existingCircles: circles.map(({ id, name, status, members }) => ({ id, name, status, memberCount: members?.length ?? 0 })),
  daoViewMethodAvailable: daoView === null || typeof daoView === 'string',
}, null, 2));
