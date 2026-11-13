export const CONTRACT_ID = 'ajopool.testnet';
export const TEST_TOKEN_ID = 'ajusd.ajopool.testnet';
export const TEST_TOKEN_SYMBOL = 'AJUSD';
export const TEST_TOKEN_DECIMALS = 6;
export const RPC_URL = 'https://test.rpc.fastnear.com';

export type CircleProposalType =
  | { RemoveMember: { member: string; had_collected: boolean } }
  | { ContinueCircle: null };

export interface CircleProposal {
  id: number;
  proposer: string;
  proposal_type: CircleProposalType;
  votes: Record<string, boolean>;
  passed: boolean;
  executed: boolean;
}

export interface OnChainCircle {
  id: number;
  name: string;
  organizer: string;
  amount_per_round: string;
  interval_seconds: number;
  grace_period_seconds: number;
  max_members: number;
  members: string[];
  slots: (string | null)[];
  status: 'Open' | 'Active' | 'Ended';
  current_round: number;
  round_start_time: number;
  round_deadline: number;
  round_payments: Record<string, string[]>;
  collected_members: string[];
  payout_request: { requester: string; round: number; created_at: number } | null;
  proposals: CircleProposal[];
  removed_members: string[];
}

export interface RoundStatus {
  circle_id: number;
  current_round: number;
  total_rounds: number;
  scheduled_recipient: string | null;
  amount_per_member: string;
  pot_amount: string;
  round_start_time: number;
  round_deadline: number;
  grace_period_seconds: number;
  paid_members: string[];
  missing_members: string[];
  is_round_fully_paid: boolean;
  is_round_late: boolean;
  payout_ready: boolean;
  payout_request: { requester: string; round: number; created_at: number } | null;
}

export interface MemberProfile {
  completed_cycles: number;
  on_time_rounds: number;
  late_rounds: number;
  defaults: number;
}

// Browser-native ultra-resilient RPC query (zero external node dependency, 100% browser-safe)
export async function queryContractView<T>(method: string, args: Record<string, unknown> = {}): Promise<T | null> {
  return queryAccountView<T>(CONTRACT_ID, method, args);
}

export async function queryAccountView<T>(
  accountId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T | null> {
  try {
    const argsBase64 = typeof window !== 'undefined'
      ? btoa(JSON.stringify(args))
      : Buffer.from(JSON.stringify(args)).toString('base64');

    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ajocircle',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'optimistic',
          account_id: accountId,
          method_name: method,
          args_base64: argsBase64,
        },
      }),
    });

    const data = await res.json();
    if (data.result && data.result.result) {
      const bytes = new Uint8Array(data.result.result);
      const str = new TextDecoder().decode(bytes);
      return JSON.parse(str) as T;
    }
    return null;
  } catch (err) {
    console.warn(`RPC query error for ${method}:`, err);
    return null;
  }
}

export async function fetchOnChainCircles(): Promise<OnChainCircle[]> {
  const circles = await queryContractView<OnChainCircle[]>('get_circles', {});
  return circles || [];
}

export async function fetchRoundStatus(circleId: number): Promise<RoundStatus | null> {
  return await queryContractView<RoundStatus>('get_round_status', { circle_id: circleId });
}

export async function fetchMemberProfile(accountId: string): Promise<MemberProfile> {
  const profile = await queryContractView<MemberProfile>('get_profile', { account_id: accountId });
  return profile || { completed_cycles: 0, on_time_rounds: 0, late_rounds: 0, defaults: 0 };
}

export async function fetchCircleToken(circleId: number): Promise<string | null> {
  return queryContractView<string>('get_circle_token', { circle_id: circleId });
}
