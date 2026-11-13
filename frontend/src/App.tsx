import { useState, useEffect } from 'react';
import { useLogin, useLogout, usePrivy } from '@privy-io/react-auth';
import { fetchOnChainCircles, fetchRoundStatus, CONTRACT_ID, type CircleProposal, type OnChainCircle, type RoundStatus } from './lib/near';
import { TEST_TOKEN_ID } from './lib/near';
import { useNEAR } from './context/useNear';
import './App.css';

type SectionId = 'home' | 'circle' | 'create' | 'activity' | 'profile' | 'settings' | 'help';
type ActivityItem = {
  id: string;
  circleId: number;
  kind: 'contribution' | 'payout' | 'vote';
  title: string;
  detail: string;
  status: string;
  overdue?: boolean;
  deadline?: number;
};
type RecentActivityItem = {
  id: string;
  circleId: number;
  round: number;
  title: string;
  detail: string;
};

function formatAjusd(units: string): string {
  return (Number(units) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function memberLabel(accountId: string, walletId: string): string {
  if (accountId === walletId) return 'you';
  if (accountId.length <= 18) return accountId;
  return `${accountId.slice(0, 9)}…${accountId.slice(-5)}`;
}

function memberInitials(accountId: string | null, walletId: string, slot: number, ownName?: string): string {
  if (!accountId) return String(slot + 1).padStart(2, '0');
  if (accountId === walletId && ownName) {
    return ownName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  }
  if (accountId === walletId) return 'ME';
  const name = accountId.includes('-') ? accountId.split('-')[1] : accountId;
  return name.slice(0, 2).toUpperCase();
}

function proposalDescription(proposal: CircleProposal, walletId: string): string {
  if ('RemoveMember' in proposal.proposal_type) {
    const { member } = proposal.proposal_type.RemoveMember;
    return `Remove ${memberLabel(member, walletId)} from this circle`;
  }
  return 'Continue this circle with its remaining members';
}

function activityDeadline(deadline: number): { label: string; overdue: boolean } {
  const now = new Date();
  const due = new Date(deadline * 1000);
  if (due.getTime() < now.getTime()) return { label: 'Past due date', overdue: true };
  const sameDay = now.getFullYear() === due.getFullYear()
    && now.getMonth() === due.getMonth()
    && now.getDate() === due.getDate();
  return {
    label: sameDay ? 'Due today' : `Due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    overdue: false,
  };
}

function friendlyTransactionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/not enough|insufficient/i.test(message)) return 'There is not enough testnet NEAR in your account to cover this step. Ask the prototype organiser to top up your test account.';
  if (/already paid/i.test(message)) return 'Your contribution for this round is already recorded.';
  if (/faucet limit/i.test(message)) return 'The test-token faucet can provide up to 10,000 AJUSD per request.';
  return message.length > 0 && message.length < 220 ? message : fallback;
}

export default function App() {
  const { authenticated, user } = usePrivy();
  const { login } = useLogin();
  const { logout } = useLogout();
  const { nearAccount, provider, walletId, walletLoading, walletError, retryWalletSetup } = useNEAR();
  const [customDisplayName, setCustomDisplayName] = useState('');
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [displayNameSaved, setDisplayNameSaved] = useState(false);
  const [expandedPaymentMember, setExpandedPaymentMember] = useState<number | null>(null);

  const suggestedDisplayName = user?.google?.name
    || user?.google?.email?.split('@')[0]
    || user?.email?.address?.split('@')[0]
    || '';

  useEffect(() => {
    if (!authenticated || !user?.id) {
      setCustomDisplayName('');
      setDisplayNameDraft('');
      return;
    }

    const storageKey = `ajocircle.display-name.${user.id}`;
    let savedName = '';
    try {
      savedName = window.localStorage.getItem(storageKey)?.trim() || '';
    } catch (error) {
      console.warn('Could not read the saved display name', error);
    }
    setCustomDisplayName(savedName);
    setDisplayNameDraft(savedName || suggestedDisplayName);
    setDisplayNameSaved(false);
  }, [authenticated, user?.id, suggestedDisplayName]);

  const saveDisplayName = () => {
    const name = displayNameDraft.trim();
    if (name.length < 2 || name.length > 32) return;
    setCustomDisplayName(name);
    setDisplayNameDraft(name);
    setDisplayNameSaved(true);
    if (user?.id) {
      try {
        window.localStorage.setItem(`ajocircle.display-name.${user.id}`, name);
      } catch (error) {
        console.warn('Could not save the display name on this device', error);
      }
    }
  };

  // Active Section Routing (matches #home, #circle, etc.)
  const [activeTab, setActiveTab] = useState<SectionId>('home');
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState(false);

  // Live on-chain circles
  const [onChainCircles, setOnChainCircles] = useState<OnChainCircle[]>([]);
  const [selectedCircleId, setSelectedCircleId] = useState<number | null>(null);
  const [roundStatus, setRoundStatus] = useState<RoundStatus | null>(null);
  const [tokenBalance, setTokenBalance] = useState<string | null>(null);
  const [circleDataLoading, setCircleDataLoading] = useState(false);
  const [circleRefreshKey, setCircleRefreshKey] = useState(0);
  const [contributionBusy, setContributionBusy] = useState<'tokens' | 'payment' | null>(null);
  const [contributionNotice, setContributionNotice] = useState<string | null>(null);
  const [contributionError, setContributionError] = useState<string | null>(null);

  // Settings Technical Details Switch State
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);

  // Create Circle Form State
  const [circleName, setCircleName] = useState('');
  const [amount, setAmount] = useState('1');
  const [frequency, setFrequency] = useState<'Weekly' | 'Monthly'>('Weekly');
  const [memberCount, setMemberCount] = useState('3');
  const [graceDays, setGraceDays] = useState('2');
  const [createdNotice, setCreatedNotice] = useState<string | null>(null);
  const [createdCircleId, setCreatedCircleId] = useState<number | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingCircle, setCreatingCircle] = useState(false);
  const [createStage, setCreateStage] = useState<'idle' | 'creating' | 'joining' | 'complete'>('idle');
  const [retryingOrganizerJoin, setRetryingOrganizerJoin] = useState(false);
  const [joiningCircleId, setJoiningCircleId] = useState<number | null>(null);
  const [joinNotice, setJoinNotice] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<number | null>(null);
  const [inviteCopyNotice, setInviteCopyNotice] = useState<string | null>(null);
  const [payoutBusy, setPayoutBusy] = useState<'request' | 'confirm' | null>(null);
  const [payoutNotice, setPayoutNotice] = useState<string | null>(null);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [walletActionRecovery, setWalletActionRecovery] = useState<string | null>(null);
  const [voteBusyId, setVoteBusyId] = useState<number | null>(null);
  const [voteNotice, setVoteNotice] = useState<string | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const walletActionDisabled = authenticated && (walletLoading || !nearAccount || Boolean(walletError));

  const recoverWalletAfterSigningError = (error: unknown, actionKey: string) => {
    const message = error instanceof Error ? error.message : String(error || '');
    if (!message.includes('Wallet proxy not initialized')) return false;
    setWalletActionRecovery(actionKey);
    void retryWalletSetup();
    return true;
  };

  const walletRecoveryNotice = (actionKey: string, actionLabel: string) => walletActionRecovery === actionKey ? (
    <div className="action-feedback" role="status">
      <p>{walletLoading
          ? 'We lost connection before this action was sent. Reconnecting now. Any earlier completed step is still saved.'
          : walletError
            ? 'Your account needs to reconnect before this action can be sent.'
            : `You’re reconnected. The action wasn’t sent. Tap “${actionLabel}” once to try again.`}</p>
      {walletError && !walletLoading && <button className="btn" type="button" onClick={() => void retryWalletSetup()}>Reconnect account</button>}
    </div>
  ) : null;

  // Listen to hash change if user uses browser history / direct links and fetch on-chain state
  useEffect(() => {
    let cancelled = false;
    const loadCircles = async () => {
      try {
        const circles = await fetchOnChainCircles();
        if (!cancelled) {
          setOnChainCircles(circles);
        }
      } catch (error) {
        console.warn('Could not load testnet circles', error);
      }
    };
    void loadCircles();

    const handleHash = () => {
      const hash = window.location.hash.replace('#', '') as SectionId;
      if (['home', 'circle', 'create', 'activity', 'profile', 'settings', 'help'].includes(hash)) {
        setActiveTab(hash);
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', handleHash);
    };
  }, []);

  const navigateTo = (tab: SectionId) => {
    setActiveTab(tab);
    window.location.hash = tab;
    window.scrollTo(0, 0);
  };

  const displayName = customDisplayName || (authenticated
    ? user?.google?.name || user?.google?.email?.split('@')[0] || user?.email?.address?.split('@')[0] || 'Ngozi'
    : 'Ngozi');

  const displayEmail = authenticated
    ? user?.google?.email || user?.email?.address || 'ngozi@example.com'
    : 'ngozi@example.com';

  const requestedCircleId = Number(new URLSearchParams(window.location.search).get('join'));
  const hasJoinInvite = new URLSearchParams(window.location.search).has('join');
  const invitedCircle = Number.isSafeInteger(requestedCircleId) && requestedCircleId > 0
    ? onChainCircles.find((circle) => circle.id === requestedCircleId)
    : undefined;
  const joinedCircles = walletId
    ? onChainCircles.filter((circle) => circle.members.includes(walletId))
    : [];
  const selectedCircle = joinedCircles.find((circle) => circle.id === selectedCircleId) || joinedCircles[0] || null;

  useEffect(() => {
    if (activeTab !== 'activity' || !walletId) return;
    let cancelled = false;
    setActivityLoading(true);
    setActivityError(false);
    void fetchOnChainCircles()
      .then((circles) => { if (!cancelled) setOnChainCircles(circles); })
      .catch((error) => {
        console.warn('Could not refresh activity', error);
        if (!cancelled) setActivityError(true);
      })
      .finally(() => { if (!cancelled) setActivityLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, walletId]);

  const activityItems: ActivityItem[] = walletId ? joinedCircles.flatMap((circle) => {
    if (circle.status !== 'Active') return [];
    const currentRoundPayments = circle.round_payments[String(circle.current_round)] ?? [];
    const items: ActivityItem[] = [];

    if (!currentRoundPayments.includes(walletId)) {
      const due = activityDeadline(circle.round_deadline);
      items.push({
        id: `contribution-${circle.id}-${circle.current_round}`,
        circleId: circle.id,
        kind: 'contribution',
        title: `Contribute ${formatAjusd(circle.amount_per_round)} AJUSD`,
        detail: `${circle.name} · Round ${circle.current_round + 1} of ${circle.slots.length}`,
        status: due.label,
        overdue: due.overdue,
        deadline: circle.round_deadline,
      });
    }

    const request = circle.payout_request;
    const fullyPaid = circle.members.length > 0 && currentRoundPayments.length === circle.members.length;
    if (request && request.round === circle.current_round && request.requester !== walletId) {
      const recipient = circle.slots[circle.current_round];
      items.push({
        id: `payout-${circle.id}-${request.round}`,
        circleId: circle.id,
        kind: 'payout',
        title: `Confirm payout${recipient ? ` to ${memberLabel(recipient, walletId)}` : ''}`,
        detail: `${circle.name} · Requested by ${memberLabel(request.requester, walletId)}`,
        status: 'Needs your confirmation',
      });
    } else if (!request && fullyPaid) {
      const recipient = circle.slots[circle.current_round];
      items.push({
        id: `payout-${circle.id}-${circle.current_round}`,
        circleId: circle.id,
        kind: 'payout',
        title: `Release payout${recipient ? ` to ${memberLabel(recipient, walletId)}` : ''}`,
        detail: `${circle.name} · Fully paid; a different member must confirm after you request release`,
        status: 'Ready to release',
      });
    }

    circle.proposals.forEach((proposal) => {
      if (proposal.executed || Object.prototype.hasOwnProperty.call(proposal.votes, walletId)) return;
      items.push({
        id: `vote-${circle.id}-${proposal.id}`,
        circleId: circle.id,
        kind: 'vote',
        title: proposalDescription(proposal, walletId),
        detail: `${circle.name} · ${Object.keys(proposal.votes).length} vote${Object.keys(proposal.votes).length === 1 ? '' : 's'} recorded`,
        status: 'Open vote',
      });
    });

    return items;
  }) : [];
  activityItems.sort((a, b) => {
    const priority = { contribution: 0, payout: 1, vote: 2 };
    return priority[a.kind] - priority[b.kind]
      || Number(b.overdue) - Number(a.overdue)
      || (a.deadline ?? Number.MAX_SAFE_INTEGER) - (b.deadline ?? Number.MAX_SAFE_INTEGER);
  });

  const homeImportantItem = activityItems.find((item) => item.kind === 'payout')
    || activityItems.find((item) => item.kind === 'contribution' && item.overdue)
    || activityItems.find((item) => item.kind === 'vote');
  const homeImportantCircle = homeImportantItem
    ? joinedCircles.find((circle) => circle.id === homeImportantItem.circleId)
    : undefined;
  const homeImportantPot = homeImportantCircle
    ? formatAjusd((BigInt(homeImportantCircle.amount_per_round) * BigInt(homeImportantCircle.members.length)).toString())
    : '';
  const homeImportantRecipient = homeImportantCircle && homeImportantCircle.current_round < homeImportantCircle.slots.length
    ? homeImportantCircle.slots[homeImportantCircle.current_round]
    : null;
  const homeImportantHeadline = homeImportantItem?.kind === 'payout'
    ? homeImportantItem.status === 'Ready to release'
      ? `${homeImportantRecipient ? memberLabel(homeImportantRecipient, walletId || '') : 'The scheduled member'} can collect ${homeImportantPot} AJUSD.`
      : `Payout confirmation needed${homeImportantRecipient ? ` for ${memberLabel(homeImportantRecipient, walletId || '')}` : ''}.`
    : homeImportantItem?.kind === 'contribution'
      ? `Your ${homeImportantItem.title.replace('Contribute ', '')} contribution is overdue.`
      : homeImportantItem?.kind === 'vote'
        ? `Your vote is needed: ${homeImportantItem.title}.`
        : '';
  const homeImportantDetail = homeImportantItem?.kind === 'payout'
    ? homeImportantItem.status === 'Ready to release'
      ? `${homeImportantCircle?.name} is fully paid. A member needs to request the release, then another member confirms it.`
      : `${homeImportantCircle?.name} is fully paid. Another member requested the release; review and confirm it.`
    : homeImportantItem?.kind === 'contribution'
      ? `${homeImportantCircle?.name} · ${homeImportantItem.detail.split(' · ').at(-1)}`
      : homeImportantItem?.kind === 'vote'
        ? homeImportantItem.detail
        : '';

  const recentActivityItems: RecentActivityItem[] = walletId ? joinedCircles.flatMap((circle) => {
    const items: RecentActivityItem[] = [];
    const currentRoundPayments = circle.round_payments[String(circle.current_round)] ?? [];
    currentRoundPayments.forEach((member) => items.push({
      id: `recent-payment-${circle.id}-${circle.current_round}-${member}`,
      circleId: circle.id,
      round: circle.current_round,
      title: `${memberLabel(member, walletId)} paid ${formatAjusd(circle.amount_per_round)} AJUSD`,
      detail: `${circle.name} · Round ${circle.current_round + 1}`,
    }));
    const lastCollector = circle.collected_members.at(-1);
    if (lastCollector) {
      const collectedRound = circle.collected_members.length - 1;
      const payoutPayments = circle.round_payments[String(collectedRound)] ?? [];
      const payoutAmount = payoutPayments.length
        ? formatAjusd((BigInt(circle.amount_per_round) * BigInt(payoutPayments.length)).toString())
        : null;
      items.push({
        id: `recent-payout-${circle.id}-${collectedRound}`,
        circleId: circle.id,
        round: collectedRound,
        title: `${memberLabel(lastCollector, walletId)} collected${payoutAmount ? ` ${payoutAmount} AJUSD` : ' the pot'}`,
        detail: `${circle.name} · Round ${collectedRound + 1}`,
      });
    }
    return items;
  }) : [];
  recentActivityItems.sort((a, b) => b.round - a.round);

  const openActivityCircle = (circleId: number) => {
    setSelectedCircleId(circleId);
    setCircleRefreshKey((key) => key + 1);
    navigateTo('circle');
  };

  useEffect(() => {
    if (!selectedCircle || !walletId) {
      setRoundStatus(null);
      setTokenBalance(null);
      return;
    }
    let cancelled = false;
    setCircleDataLoading(true);
    void Promise.allSettled([
      fetchRoundStatus(selectedCircle.id),
      provider.callFunction<string>({
        contractId: TEST_TOKEN_ID,
        method: 'ft_balance_of',
        args: { account_id: walletId },
      }),
    ]).then(([statusResult, balanceResult]) => {
      if (cancelled) return;
      if (statusResult.status === 'fulfilled') setRoundStatus(statusResult.value);
      else {
        console.warn('Could not load circle round status', statusResult.reason);
        setRoundStatus(null);
      }
      if (balanceResult.status === 'fulfilled') setTokenBalance(balanceResult.value ?? '0');
      else {
        console.warn('Could not load AJUSD balance', balanceResult.reason);
        setTokenBalance(null);
      }
    }).finally(() => {
      if (!cancelled) setCircleDataLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedCircle?.id, walletId, provider, circleRefreshKey]);

  const inviteUrl = (circleId: number) => {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('join', String(circleId));
    return url.toString();
  };

  const handleCopyInvite = async (circleId: number) => {
    const link = inviteUrl(circleId);
    setInviteCopyNotice(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        const temporaryInput = document.createElement('textarea');
        temporaryInput.value = link;
        temporaryInput.setAttribute('readonly', '');
        temporaryInput.style.position = 'fixed';
        temporaryInput.style.opacity = '0';
        document.body.appendChild(temporaryInput);
        temporaryInput.select();
        const copied = document.execCommand('copy');
        temporaryInput.remove();
        if (!copied) throw new Error('Clipboard copy failed');
      }
      setCopiedInviteId(circleId);
      setInviteCopyNotice(null);
      window.setTimeout(() => setCopiedInviteId((current) => current === circleId ? null : current), 2500);
    } catch {
      setInviteCopyNotice('Could not copy the link. Please try again.');
    }
  };

  const refreshSelectedCircle = () => {
    setCircleRefreshKey((key) => key + 1);
    void fetchOnChainCircles().then(setOnChainCircles).catch((error) => {
      console.warn('Could not refresh circle list', error);
    });
  };

  const refreshCircleState = async (circleId: number) => {
    const [circles, status] = await Promise.all([
      fetchOnChainCircles(),
      fetchRoundStatus(circleId),
    ]);
    setOnChainCircles(circles);
    if (status) setRoundStatus(status);
    return { circles, status };
  };

  const waitForPayoutCompletion = async (circleId: number, round: number, recipient: string) => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const { circles, status } = await refreshCircleState(circleId);
      const circle = circles.find((item) => item.id === circleId);
      if (circle?.collected_members.includes(recipient)) return true;
      if (status && status.current_round > round) return true;
    }
    return false;
  };

  const handlePayoutAction = async () => {
    setWalletActionRecovery(null);
    setPayoutNotice(null);
    setPayoutError(null);
    if (!nearAccount || !walletId || !selectedCircle || !roundStatus) {
      setPayoutError(walletError || 'Your account or circle details are still loading. Try again shortly.');
      return;
    }
    if (!roundStatus.is_round_fully_paid || !roundStatus.scheduled_recipient) {
      setPayoutError('The payout becomes available after every active member has contributed.');
      return;
    }

    const request = roundStatus.payout_request;
    const isConfirmation = Boolean(request);
    if (request?.requester === walletId) {
      setPayoutNotice('Your request is recorded. A different member must confirm the payout.');
      return;
    }
    if (!request && !roundStatus.payout_ready) {
      setPayoutError('This payout is already being processed or is not ready. Refresh the circle to check its status.');
      return;
    }

    const round = roundStatus.current_round;
    const recipient = roundStatus.scheduled_recipient;
    setPayoutBusy(isConfirmation ? 'confirm' : 'request');
    try {
      await nearAccount.callFunction({
        contractId: CONTRACT_ID,
        methodName: isConfirmation ? 'confirm_payout' : 'request_payout',
        args: { circle_id: selectedCircle.id },
        deposit: 0n,
        gas: isConfirmation ? 180_000_000_000_000n : 80_000_000_000_000n,
      });

      if (!isConfirmation) {
        setRoundStatus({
          ...roundStatus,
          payout_ready: false,
          payout_request: {
            requester: walletId,
            round,
            created_at: Math.floor(Date.now() / 1000),
          },
        });
        setPayoutNotice(`Request sent. A different member must confirm the payout to ${memberLabel(recipient, walletId)}.`);
      } else {
        setPayoutNotice('Confirmation sent. Waiting for the AJUSD transfer to finish…');
        const completed = await waitForPayoutCompletion(selectedCircle.id, round, recipient);
        setPayoutNotice(completed
          ? `Payout sent to ${memberLabel(recipient, walletId)}. The circle has moved to its next round.`
          : 'Confirmation was submitted, but the transfer has not appeared yet. Refresh the circle before trying again.');
      }
    } catch (error) {
      await refreshCircleState(selectedCircle.id).catch(() => undefined);
      const fallback = isConfirmation
        ? 'Could not confirm the payout. Refresh the circle and try again.'
        : 'Could not request the payout. Refresh the circle and try again.';
      if (!recoverWalletAfterSigningError(error, 'payout')) setPayoutError(friendlyTransactionError(error, fallback));
    } finally {
      setPayoutBusy(null);
    }
  };

  const handleVote = async (proposal: CircleProposal, approve: boolean) => {
    setWalletActionRecovery(null);
    setVoteNotice(null);
    setVoteError(null);
    if (!nearAccount || !walletId || !selectedCircle) {
      setVoteError(walletError || 'Your account is still getting ready. Try again shortly.');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(proposal.votes, walletId)) {
      setVoteNotice('Your vote is already recorded for this proposal.');
      return;
    }

    setVoteBusyId(proposal.id);
    try {
      const passed = await nearAccount.callFunction<boolean>({
        contractId: CONTRACT_ID,
        methodName: 'vote_proposal',
        args: { circle_id: selectedCircle.id, proposal_id: proposal.id, approve },
        deposit: 0n,
        gas: 120_000_000_000_000n,
      });
      setVoteNotice(passed ? 'Your vote passed the proposal.' : 'Your vote has been recorded.');
      setOnChainCircles(await fetchOnChainCircles());
    } catch (error) {
      if (!recoverWalletAfterSigningError(error, `vote-${proposal.id}-${approve ? 'approve' : 'reject'}`)) setVoteError(friendlyTransactionError(error, 'Could not record your vote. Refresh and try again.'));
      await fetchOnChainCircles().then(setOnChainCircles).catch(() => undefined);
    } finally {
      setVoteBusyId(null);
    }
  };

  const handleGetTestTokens = async () => {
    setWalletActionRecovery(null);
    setContributionNotice(null);
    setContributionError(null);
    if (!nearAccount || !walletId || !roundStatus) {
      if (!authenticated) void login();
      else setContributionError(walletError || 'Your account is still getting ready. Try again shortly.');
      return;
    }
    const due = BigInt(roundStatus.amount_per_member);
    const balance = BigInt(tokenBalance || '0');
    const amountNeeded = due > balance ? due - balance : due;
    if (amountNeeded <= 0n) {
      setContributionNotice('You already have enough AJUSD for this contribution.');
      return;
    }
    if (amountNeeded > 10_000_000_000n) {
      setContributionError('The test-token faucet can provide up to 10,000 AJUSD per request. This circle’s contribution is higher.');
      return;
    }

    setContributionBusy('tokens');
    try {
      const storageBalance = await provider.callFunction<{ total: string; available: string } | null>({
        contractId: TEST_TOKEN_ID,
        method: 'storage_balance_of',
        args: { account_id: walletId },
      });
      if (!storageBalance) {
        const bounds = await provider.callFunction<{ min: string }>({
          contractId: TEST_TOKEN_ID,
          method: 'storage_balance_bounds',
          args: {},
        });
        await nearAccount.callFunction({
          contractId: TEST_TOKEN_ID,
          methodName: 'storage_deposit',
          args: { account_id: walletId, registration_only: true },
          deposit: BigInt(bounds.min),
          gas: 80_000_000_000_000n,
        });
      }
      await nearAccount.callFunction({
        contractId: TEST_TOKEN_ID,
        methodName: 'faucet',
        args: { amount: amountNeeded.toString() },
        deposit: 0n,
        gas: 80_000_000_000_000n,
      });
      setContributionNotice(`${formatAjusd(amountNeeded.toString())} AJUSD test tokens added to your balance.`);
      refreshSelectedCircle();
    } catch (error) {
      if (!recoverWalletAfterSigningError(error, 'tokens')) setContributionError(friendlyTransactionError(error, 'Could not add test tokens. Check your testnet balance and try again.'));
    } finally {
      setContributionBusy(null);
    }
  };

  const handlePayContribution = async () => {
    setWalletActionRecovery(null);
    setContributionNotice(null);
    setContributionError(null);
    if (!nearAccount || !walletId || !selectedCircle || !roundStatus) {
      if (!authenticated) void login();
      else setContributionError(walletError || 'Your account or circle details are still loading. Try again shortly.');
      return;
    }
    if (selectedCircle.status !== 'Active') {
      setContributionError('Contributions will be available once all circle places are filled.');
      return;
    }
    if (roundStatus.paid_members.includes(walletId)) {
      setContributionNotice('Your contribution for this round is already recorded.');
      refreshSelectedCircle();
      return;
    }
    const due = BigInt(roundStatus.amount_per_member);
    if (BigInt(tokenBalance || '0') < due) {
      setContributionError('Add test AJUSD to your balance before paying this round.');
      return;
    }

    setContributionBusy('payment');
    try {
      const unused = await nearAccount.callFunction<string | null>({
        contractId: TEST_TOKEN_ID,
        methodName: 'ft_transfer_call',
        args: {
          receiver_id: CONTRACT_ID,
          amount: due.toString(),
          memo: null,
          msg: String(selectedCircle.id),
        },
        deposit: 1n,
        gas: 200_000_000_000_000n,
      });
      if (unused !== null && unused !== undefined && BigInt(unused) > 0n) {
        throw new Error('The circle did not accept this payment, so the tokens were returned. Check that the circle is active and you have not already paid this round.');
      }
      const updatedStatus = await fetchRoundStatus(selectedCircle.id);
      setRoundStatus(updatedStatus);
      if (updatedStatus?.paid_members.includes(walletId)) {
        setContributionNotice(`Your ${formatAjusd(due.toString())} AJUSD contribution is recorded for round ${updatedStatus.current_round + 1}.`);
      } else {
        setContributionNotice('Payment was sent. Refresh the circle in a moment to confirm it has been recorded.');
      }
      refreshSelectedCircle();
      setTokenBalance((BigInt(tokenBalance || '0') - due).toString());
    } catch (error) {
      if (!recoverWalletAfterSigningError(error, 'payment')) setContributionError(friendlyTransactionError(error, 'Payment did not go through. Your balance was not marked as paid.'));
    } finally {
      setContributionBusy(null);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setWalletActionRecovery(null);
    setCreateError(null);
    setCreatedNotice(null);
    setCreatedCircleId(null);
    setInviteCopyNotice(null);
    if (!nearAccount || !walletId) {
      if (!authenticated) {
        setCreatedNotice('Sign in first. Your circle will be submitted after you sign in and tap this button again.');
        void login();
      } else {
        setCreateError(walletError || (walletLoading ? 'Your NEAR account is still being prepared.' : 'Your NEAR account is not ready.'));
      }
      return;
    }

    const cleanName = circleName.trim();
    if (cleanName.length < 3 || cleanName.length > 48) {
      setCreateError('Use a circle name between 3 and 48 characters.');
      return;
    }
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) {
      setCreateError('Enter an amount greater than 0 with up to 6 decimal places.');
      return;
    }
    const slots = Number(memberCount);
    const gracePeriod = Number(graceDays);
    if (!Number.isInteger(slots) || slots < 3 || slots > 12) {
      setCreateError('Choose between 3 and 12 members.');
      return;
    }
    if (!Number.isInteger(gracePeriod) || gracePeriod < 1 || gracePeriod > 7) {
      setCreateError('Choose a grace period between 1 and 7 days.');
      return;
    }

    void handleConfirmCreate();
  };

  const handleConfirmCreate = async () => {
    if (!nearAccount || !walletId) {
      setCreateError(walletError || 'Your NEAR account is not ready.');
      return;
    }
    setCreateError(null);
    setCreatedNotice(null);
    setCreatedCircleId(null);
    setInviteCopyNotice(null);
    const cleanName = circleName.trim();
    const slots = Number(memberCount);
    const gracePeriod = Number(graceDays);
    const [whole, fraction = ''] = amount.split('.');
    const tokenUnits = (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
    const intervalSeconds = frequency === 'Weekly' ? 7 * 24 * 60 * 60 : 30 * 24 * 60 * 60;
    let newCircleId: number;
    setCreatingCircle(true);
    setCreateStage('creating');
    setCreatedNotice('Creating your circle…');
    try {
      newCircleId = await nearAccount.callFunction<number>({
        contractId: CONTRACT_ID,
        methodName: 'create_token_circle',
        args: {
          name: cleanName,
          amount_per_round: tokenUnits,
          interval_seconds: intervalSeconds,
          grace_period_seconds: gracePeriod * 24 * 60 * 60,
          max_members: slots,
          token_id: TEST_TOKEN_ID,
        },
        deposit: 0n,
        gas: 100_000_000_000_000n,
      });
      if (!Number.isSafeInteger(newCircleId) || newCircleId < 1) {
        throw new Error('The transaction returned without a circle ID. Refresh your circles before trying again to avoid creating a duplicate.');
      }
    } catch (error) {
      const recoveringWallet = recoverWalletAfterSigningError(error, 'create');
      if (!recoveringWallet) setCreateError(friendlyTransactionError(error, 'Circle creation failed.'));
      setCreatedNotice(null);
      setCreateStage('idle');
      setCreatingCircle(false);
      return;
    }

    setCreatedCircleId(newCircleId);
    setSelectedCircleId(newCircleId);
    setCreatedNotice(`Circle #${newCircleId} was created on NEAR testnet. Your invite link is ready below; claiming slot 1 is in progress…`);
    setCreateStage('joining');

    try {
      await nearAccount.callFunction({
        contractId: CONTRACT_ID,
        methodName: 'join',
        args: { circle_id: newCircleId, slot: 0 },
        deposit: 0n,
        gas: 60_000_000_000_000n,
      });
      setCreatedNotice(`Circle #${newCircleId} was created and you joined slot 1. Share the invite link below with your members.`);
      setCreateStage('complete');
      navigateTo('circle');
    } catch (error) {
      setCreatedNotice(`Circle #${newCircleId} was created. Your invite link is ready below, but claiming slot 1 failed. Retry the slot claim before creating another circle.`);
      setCreateError(error instanceof Error ? error.message : 'The circle was created, but joining failed.');
    } finally {
      setCreatingCircle(false);
      const circles = await fetchOnChainCircles();
      setOnChainCircles(circles);
    }
  };

  const handleRetryOrganizerJoin = async () => {
    setWalletActionRecovery(null);
    if (!nearAccount || createdCircleId === null) return;
    setCreateError(null);
    setRetryingOrganizerJoin(true);
    setCreateStage('joining');
    setCreatedNotice(`Finishing setup for circle #${createdCircleId}…`);
    try {
      await nearAccount.callFunction({
        contractId: CONTRACT_ID,
        methodName: 'join',
        args: { circle_id: createdCircleId, slot: 0 },
        deposit: 0n,
        gas: 60_000_000_000_000n,
      });
      setCreatedNotice(`You joined circle #${createdCircleId} in slot 1. Share the invite link below with your members.`);
      setCreateStage('complete');
      const circles = await fetchOnChainCircles();
      setOnChainCircles(circles);
      setSelectedCircleId(createdCircleId);
      navigateTo('circle');
    } catch (error) {
      if (!recoverWalletAfterSigningError(error, 'organizer-join')) setCreateError(friendlyTransactionError(error, 'Could not claim slot 1.'));
    } finally {
      setRetryingOrganizerJoin(false);
    }
  };

  const handleJoinCircle = async (circle: OnChainCircle) => {
    setWalletActionRecovery(null);
    setJoinNotice(null);
    setJoinError(null);
    if (!nearAccount || !walletId) {
      if (!authenticated) void login();
      else setJoinError(walletError || (walletLoading ? 'Your NEAR account is still being prepared.' : 'Your NEAR account is not ready.'));
      return;
    }

    const slot = circle.slots.findIndex((member) => member === null);
    if (slot < 0) {
      setJoinError('This circle has no open slots left. Refresh the page to see the latest availability.');
      return;
    }

    setJoiningCircleId(circle.id);
    try {
      await nearAccount.callFunction({
        contractId: CONTRACT_ID,
        methodName: 'join',
        args: { circle_id: circle.id, slot },
        deposit: 0n,
        gas: 60_000_000_000_000n,
      });
      setJoinNotice(`You joined ${circle.name} in slot ${slot + 1}.`);
      setOnChainCircles(await fetchOnChainCircles());
      setSelectedCircleId(circle.id);
      navigateTo('circle');
    } catch (error) {
      if (!recoverWalletAfterSigningError(error, `join-${circle.id}`)) setJoinError(friendlyTransactionError(error, 'Could not join this circle. Refresh and try again.'));
      setOnChainCircles(await fetchOnChainCircles());
    } finally {
      setJoiningCircleId(null);
    }
  };

  return (
    <>
      {/* SVG Symbol Definitions (100% faithful to HTML specification) */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <symbol id="home" viewBox="0 0 24 24">
            <path d="M3 11l9-8 9 8" />
            <path d="M5 10v10h14V10" />
          </symbol>
          <symbol id="users" viewBox="0 0 24 24">
            <circle cx="9" cy="8" r="3.5" />
            <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
            <circle cx="17.5" cy="9" r="2.5" />
            <path d="M18 14.2c2.2.3 3.8 2.1 3.8 4.3" />
          </symbol>
          <symbol id="plus" viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </symbol>
          <symbol id="bell" viewBox="0 0 24 24">
            <path d="M6 16v-5a6 6 0 0112 0v5l1.5 2h-15z" />
            <path d="M10 21h4" />
          </symbol>
          <symbol id="user" viewBox="0 0 24 24">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
          </symbol>
          <symbol id="gear" viewBox="0 0 24 24">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="8" cy="17" r="2" />
          </symbol>
          <symbol id="help" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="M9.5 9.5a2.6 2.6 0 115 .8c0 1.7-2.5 2-2.5 3.7M12 17h.01" />
          </symbol>
          <symbol id="check" viewBox="0 0 24 24">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </symbol>
          <symbol id="clock" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </symbol>
          <symbol id="info" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8h.01" />
          </symbol>
        </defs>
      </svg>

      {/* Desktop Left Sidebar (>= 1024px) */}
      <nav className="side" aria-label="Main">
        <div className="logo">Ajocircle</div>
        <button
          onClick={() => navigateTo('home')}
          aria-current={activeTab === 'home' ? 'page' : undefined}
        >
          <svg className="i"><use href="#home" /></svg>
          Home
        </button>
        <button
          onClick={() => navigateTo('circle')}
          aria-current={activeTab === 'circle' ? 'page' : undefined}
        >
          <svg className="i"><use href="#users" /></svg>
          My circles
        </button>
        <button
          onClick={() => navigateTo('create')}
          aria-current={activeTab === 'create' ? 'page' : undefined}
        >
          <svg className="i"><use href="#plus" /></svg>
          Create circle
        </button>
        <button
          onClick={() => navigateTo('activity')}
          aria-current={activeTab === 'activity' ? 'page' : undefined}
        >
          <svg className="i"><use href="#bell" /></svg>
          Activity
          {activityItems.length > 0 && <span className="badge" aria-label={`${activityItems.length} pending actions`}>{activityItems.length}</span>}
        </button>
        <button
          onClick={() => navigateTo('profile')}
          aria-current={activeTab === 'profile' ? 'page' : undefined}
        >
          <svg className="i"><use href="#user" /></svg>
          Profile
        </button>
        <span className="sp"></span>
        <button
          onClick={() => navigateTo('settings')}
          aria-current={activeTab === 'settings' ? 'page' : undefined}
        >
          <svg className="i"><use href="#gear" /></svg>
          Settings
        </button>
        <button
          onClick={() => navigateTo('help')}
          aria-current={activeTab === 'help' ? 'page' : undefined}
        >
          <svg className="i"><use href="#help" /></svg>
          Help
        </button>
      </nav>

      {/* Main Content Area */}
      <main id="main">
        <div className="appbar">
          <span className="appbar-brand">Ajocircle</span>
          {authenticated ? (
            <button className="btn account-button" type="button" onClick={() => navigateTo('settings')}>
              {displayName}
            </button>
          ) : (
            <button className="btn primary" type="button" onClick={() => void login()}>
              Sign in with Google
            </button>
          )}
        </div>
        {authenticated && walletLoading && !walletActionRecovery && (
          <p className="muted small wallet-status" role="status">Preparing your sign-in wallet for NEAR actions…</p>
        )}
        {authenticated && walletError && !walletActionRecovery && (
          <div className="notice wallet-status" role="alert">
            <p>{walletError}</p>
            <button className="btn" type="button" disabled={walletLoading} onClick={() => void retryWalletSetup()}>
              {walletLoading ? 'Reconnecting…' : 'Try wallet again'}
            </button>
          </div>
        )}
        {/* HOME SECTION */}
        <section id="home" className={activeTab === 'home' ? 'on' : ''}>
          <div className="head">
            <p className="muted">Good evening</p>
            <h1>{displayName}</h1>
          </div>
          {selectedCircle && roundStatus ? (
            <div className="hero">
              <p className="muted small">{roundStatus.paid_members.includes(walletId) ? 'Contribution received' : 'Contribution this round'}</p>
              <p className="big money">{formatAjusd(roundStatus.amount_per_member)} AJUSD</p>
              <p className="muted">{selectedCircle.name} · Round {roundStatus.current_round + 1} of {roundStatus.total_rounds}</p>
              <button className="btn primary" type="button" onClick={() => navigateTo('circle')}>View circle</button>
            </div>
          ) : (
            <div className="hero">
              <p className="muted small">Your savings circles</p>
              <p className="big">Start with your people</p>
              <p className="muted">Create a circle or open an invitation link to join one.</p>
              <button className="btn primary" type="button" onClick={() => navigateTo('create')}>Create a circle</button>
            </div>
          )}
          {homeImportantItem && homeImportantCircle && (
            <div className="home-important" role="status">
              <svg className="i" aria-hidden="true"><use href="#info" /></svg>
              <div className="home-important-copy">
                <p><strong>{homeImportantHeadline}</strong></p>
                <p>{homeImportantDetail}</p>
              </div>
              <button className="btn" type="button" onClick={() => openActivityCircle(homeImportantCircle.id)}>Review</button>
            </div>
          )}
          {hasJoinInvite && (
            <div>
              <h2>Circle invitation</h2>
              <p className="muted small">This invite opens a testnet circle. Test tokens have no cash value.</p>
              {joinNotice && <div className="notice" role="status"><p>{joinNotice}</p></div>}
              {joinError && <div className="notice" role="alert"><p>{joinError}</p></div>}
              <div className="panel invite-panel">
                {invitedCircle ? (
                  <>
                    <p className="muted small">You’ve been invited to join</p>
                    <h2>{invitedCircle.name}</h2>
                    <p className="muted small">
                      {invitedCircle.members.length} of {invitedCircle.max_members} members ·{' '}
                      {invitedCircle.slots.filter((member) => member === null).length} places left ·{' '}
                      {(Number(invitedCircle.amount_per_round) / 1_000_000).toLocaleString()} AJUSD each round
                    </p>
                    {invitedCircle.status === 'Open' ? (
                      <button
                        className="btn primary"
                        type="button"
                        disabled={joiningCircleId !== null || walletActionDisabled || Boolean(walletId && invitedCircle.members.includes(walletId))}
                        onClick={() => void handleJoinCircle(invitedCircle)}
                      >
                        {joiningCircleId === invitedCircle.id
                          ? 'Joining…'
                          : walletId && invitedCircle.members.includes(walletId)
                            ? 'You’ve already joined'
                            : walletActionRecovery === `join-${invitedCircle.id}` && !walletLoading && !walletError
                              ? 'Try joining again'
                              : 'Join this circle'}
                      </button>
                    ) : (
                      <p className="muted small">This circle is no longer open to new members.</p>
                    )}
                    {walletRecoveryNotice(`join-${invitedCircle.id}`, 'Try joining again')}
                  </>
                ) : (
                  <p className="muted">Looking up this circle… If it doesn’t appear, the link may be invalid or the circle may have been removed.</p>
                )}
              </div>
            </div>
          )}
          <div>
            <h2>Your circles</h2>
            <div className="list">
              {joinedCircles.length ? joinedCircles.map((circle) => (
                <button
                  className="row circle-list-button"
                  key={circle.id}
                  type="button"
                  onClick={() => { setSelectedCircleId(circle.id); navigateTo('circle'); }}
                >
                  <span className="av">{circle.name.slice(0, 2).toUpperCase()}</span>
                  <span className="grow">
                    <b>{circle.name}</b>
                    <br />
                    <span className="muted small">{formatAjusd(circle.amount_per_round)} AJUSD per round · {circle.members.length}/{circle.max_members} members</span>
                  </span>
                  <span className={`chip ${circle.status === 'Open' ? 'wait' : ''}`}>{circle.status}</span>
                </button>
              )) : (
                <p className="row muted">Circles you join will appear here.</p>
              )}
            </div>
          </div>
          <div className="home-recent">
            <div className="home-recent-heading">
              <h2>Recent activity</h2>
              {recentActivityItems.length > 0 && <button className="text-link" type="button" onClick={() => navigateTo('activity')}>See all</button>}
            </div>
            {recentActivityItems.length > 0 ? (
              <div className="list">
                {recentActivityItems.slice(0, 5).map((item) => (
                  <button className="row circle-list-button" type="button" key={item.id} onClick={() => openActivityCircle(item.circleId)}>
                    <span className="grow">
                      <b>{item.title}</b>
                      <br />
                      <span className="muted small">{item.detail}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="panel home-recent-empty">
                <p className="muted small">Recent contribution and payout updates will appear here.</p>
              </div>
            )}
          </div>
        </section>

        {/* CIRCLE SECTION */}
        <section id="circle" className={activeTab === 'circle' ? 'on' : ''}>
          {selectedCircle ? (
            <>
              <div className="circle-page-head">
                <div className="head">
                  <p className="muted small">Your circle</p>
                  <h1>{selectedCircle.name}</h1>
                  <p className="muted">{formatAjusd(selectedCircle.amount_per_round)} AJUSD per person · {selectedCircle.members.length} of {selectedCircle.max_members} members</p>
                </div>
                {selectedCircle.status === 'Open' && (
                  <div className="circle-invite-action">
                    <button className="btn" type="button" aria-live="polite" onClick={() => void handleCopyInvite(selectedCircle.id)}>
                      {copiedInviteId === selectedCircle.id ? 'Link copied' : 'Copy invite link'}
                    </button>
                    {inviteCopyNotice && <span className="muted small" role="status">{inviteCopyNotice}</span>}
                  </div>
                )}
              </div>

              <div className="panel circle-round-panel">
                <div className="circle-round-heading">
                  <div>
                    <p className="muted small">{selectedCircle.status === 'Active' && roundStatus ? `Round ${roundStatus.current_round + 1} of ${roundStatus.total_rounds}` : 'Circle status'}</p>
                    <h2>{selectedCircle.status === 'Active' ? 'This round' : selectedCircle.status}</h2>
                  </div>
                  <button className="btn" type="button" onClick={refreshSelectedCircle} disabled={circleDataLoading}>
                    {circleDataLoading ? 'Updating?' : 'Refresh'}
                  </button>
                </div>
                {selectedCircle.status === 'Active' && roundStatus ? (
                  <div className="rotation-summary">
                    <div className="rotation-ring" role="img" aria-label={`Round ${roundStatus.current_round + 1} of ${roundStatus.total_rounds}; member rotation`}>
                      <svg className="rotation-orbit" viewBox="0 0 220 220" aria-hidden="true">
                        <circle cx="110" cy="110" r="82" />
                      </svg>
                      <div className="rotation-center">
                        <span>Round</span>
                        <b>{roundStatus.current_round + 1} of {roundStatus.total_rounds}</b>
                      </div>
                      {selectedCircle.slots.map((member, index) => {
                        const angle = (-90 + (360 * index) / selectedCircle.slots.length) * (Math.PI / 180);
                        const x = Math.cos(angle) * 82;
                        const y = Math.sin(angle) * 82;
                        const current = roundStatus.current_round === index;
                        const collected = Boolean(member && selectedCircle.collected_members.includes(member));
                        const collectionStatus = current ? 'collects this round' : collected ? 'has collected' : 'has not collected yet';
                        return (
                          <span
                            className={`rotation-node ${current ? 'is-current' : collected ? 'is-collected' : ''}`}
                            key={`rotation-${selectedCircle.id}-${index}`}
                            style={{ left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)` }}
                            title={`${member ? memberLabel(member, walletId) : 'Open place'} ${collectionStatus}, slot ${index + 1}`}
                          >
                            {memberInitials(member, walletId, index, displayName)}
                          </span>
                        );
                      })}
                    </div>
                    <div className="rotation-copy">
                      <p className="muted small">In the pot</p>
                      <p className="circle-pot">{formatAjusd(roundStatus.pot_amount)} <span>AJUSD</span></p>
                      {roundStatus.scheduled_recipient && (
                        <p className="muted">
                          {roundStatus.paid_members.length === selectedCircle.members.length
                            ? `All ${selectedCircle.members.length} members have paid. `
                            : `${roundStatus.paid_members.length} of ${selectedCircle.members.length} members have paid. `}
                          {roundStatus.scheduled_recipient === walletId ? 'You collect' : `${memberLabel(roundStatus.scheduled_recipient, walletId)} collects`} this round.
                        </p>
                      )}
                    </div>
                    <div className="rotation-legend" aria-label="Collection progress legend">
                      <span><i className="rotation-legend-mark collected" />Collected</span>
                      <span><i className="rotation-legend-mark current" />Collects this round</span>
                      <span><i className="rotation-legend-mark waiting" />Yet to collect</span>
                    </div>
                  </div>
                ) : selectedCircle.status === 'Open' ? (
                  <p className="muted">Contributions open once every place is filled.</p>
                ) : selectedCircle.status === 'Active' ? (
                  <p className="muted">Loading this round’s payment details…</p>
                ) : (
                  <p className="muted">This circle has finished.</p>
                )}
              </div>

              <div>
                <h2 className="members-heading">Members</h2>
                {selectedCircle.status === 'Open' ? (
                  <div className="panel payment-history-empty">
                    <p className="muted">Round payment statuses will appear when the circle is full and starts.</p>
                  </div>
                ) : (
                  <div className="list member-list">
                    {selectedCircle.slots.map((member, slotIndex) => {
                      const memberIsYou = member === walletId;
                      const currentRoundPaid = Boolean(member && roundStatus?.paid_members.includes(member));
                      const expanded = expandedPaymentMember === slotIndex;
                      const currentRound = roundStatus?.current_round ?? selectedCircle.current_round;
                      const currentStatus = !member
                        ? 'Open place'
                        : selectedCircle.status === 'Active'
                          ? !roundStatus ? 'Loading status' : currentRoundPaid ? 'Paid this round' : 'Not paid this round'
                          : selectedCircle.status === 'Ended' ? 'Circle ended' : 'Waiting to start';
                      return (
                        <div className="member-list-entry" key={`${selectedCircle.id}-${slotIndex}`}>
                          <div className="row member-row">
                            <span className="av">{memberInitials(member, walletId, slotIndex, displayName)}</span>
                            <span className="grow member-row-copy">
                              <b>{member ? (memberIsYou ? `${displayName} (you)` : memberLabel(member, walletId)) : 'Open place'}</b>
                              <span className="muted small">{memberIsYou && selectedCircle.status === 'Active' && currentRoundPaid
                                ? 'Your contribution for this round is already recorded.'
                                : `Slot ${slotIndex + 1}`}</span>
                            </span>
                            {member && selectedCircle.status === 'Active' && memberIsYou && !currentRoundPaid && roundStatus ? (
                              <button
                                className="btn primary member-contribute-button"
                                type="button"
                                disabled={tokenBalance === null || contributionBusy !== null || circleDataLoading || walletActionDisabled}
                                onClick={() => void (BigInt(tokenBalance || '0') < BigInt(roundStatus.amount_per_member) ? handleGetTestTokens() : handlePayContribution())}
                              >
                                {tokenBalance === null ? 'Checking balance…'
                                  : contributionBusy === 'tokens' ? 'Getting test AJUSD…'
                                    : contributionBusy === 'payment' ? 'Recording contribution…'
                                      : walletActionRecovery === 'tokens' || walletActionRecovery === 'payment' ? 'Try again'
                                        : BigInt(tokenBalance) < BigInt(roundStatus.amount_per_member) ? 'Get test AJUSD' : `Contribute ${formatAjusd(roundStatus.amount_per_member)} AJUSD`}
                              </button>
                            ) : (
                              <span className={`chip member-round-status ${currentRoundPaid ? 'paid' : currentStatus === 'Not paid this round' ? 'wait' : ''}`}>
                                {currentStatus}
                              </span>
                            )}
                            {member && (
                              <button
                                className="member-history-toggle"
                                type="button"
                                aria-expanded={expanded}
                                onClick={() => setExpandedPaymentMember(expanded ? null : slotIndex)}
                              >
                                {expanded ? 'Hide rounds' : 'Rounds'}
                              </button>
                            )}
                          </div>
                          {expanded && member && (
                            <div className="member-round-history" aria-label={`Payment history for ${memberLabel(member, walletId)}`}>
                              {Array.from({ length: selectedCircle.max_members }, (_, roundIndex) => {
                                const paymentMembers = selectedCircle.round_payments?.[String(roundIndex)] || [];
                                const paid = paymentMembers.includes(member);
                                const upcoming = selectedCircle.status === 'Active' && roundIndex > currentRound;
                                const roundLabel = upcoming ? 'Upcoming' : paid ? 'Paid' : 'Not paid';
                                return (
                                  <span className={`member-round-pill ${paid ? 'paid' : upcoming ? 'upcoming' : 'unpaid'}`} key={`member-round-${slotIndex}-${roundIndex}`}>
                                    Round {roundIndex + 1}: {roundLabel}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {walletRecoveryNotice('tokens', 'Get test AJUSD')}
                {walletRecoveryNotice('payment', 'Contribute')}
                {contributionNotice && <p className="contribution-feedback" role="status">{contributionNotice}</p>}
                {contributionError && <p className="contribution-feedback error" role="alert">{contributionError}</p>}
              </div>

              <div className="circle-subsection">
                <h2>Votes</h2>
                <div className="panel votes-panel">
                  {selectedCircle.proposals.filter((proposal) => !proposal.executed).length ? (
                    selectedCircle.proposals.filter((proposal) => !proposal.executed).map((proposal) => {
                      const hasVoted = Object.prototype.hasOwnProperty.call(proposal.votes, walletId);
                      const yesVotes = Object.values(proposal.votes).filter(Boolean).length;
                      const noVotes = Object.values(proposal.votes).filter((vote) => !vote).length;
                      return (
                        <article className="vote-item" key={`${selectedCircle.id}-${proposal.id}`}>
                          <div className="vote-copy">
                            <b>{proposalDescription(proposal, walletId)}</b>
                            <span className="muted small">{yesVotes} approve · {noVotes} reject</span>
                          </div>
                          {hasVoted ? (
                            <span className="chip">You voted {proposal.votes[walletId] ? 'to approve' : 'to reject'}</span>
                          ) : (
                            <div className="vote-actions">
                              <button className="btn" type="button" disabled={walletActionDisabled || voteBusyId !== null} onClick={() => void handleVote(proposal, false)}>
                                {walletActionRecovery === `vote-${proposal.id}-reject` && !walletLoading && !walletError ? 'Try rejecting again' : 'Reject'}
                              </button>
                              <button className="btn primary" type="button" disabled={walletActionDisabled || voteBusyId !== null} onClick={() => void handleVote(proposal, true)}>
                                {voteBusyId === proposal.id ? 'Recording…' : walletActionRecovery === `vote-${proposal.id}-approve` && !walletLoading && !walletError ? 'Try approving again' : 'Approve'}
                              </button>
                            </div>
                          )}
                          {walletRecoveryNotice(`vote-${proposal.id}-reject`, 'Try rejecting again')}
                          {walletRecoveryNotice(`vote-${proposal.id}-approve`, 'Try approving again')}
                        </article>
                      );
                    })
                  ) : (
                    <p className="muted">No open votes right now.</p>
                  )}
                  {voteNotice && <p className="action-feedback" role="status">{voteNotice}</p>}
                  {voteError && <p className="action-feedback error" role="alert">{voteError}</p>}
                </div>
              </div>

              {selectedCircle.status === 'Active' && roundStatus && (roundStatus.is_round_fully_paid || payoutNotice || payoutError || walletActionRecovery === 'payout') && (
                <div className="payout-action-panel">
                  {roundStatus.is_round_fully_paid && roundStatus.scheduled_recipient && (
                    <>
                      <p className="muted small">Ready for release</p>
                      <p className="payout-summary">{formatAjusd(roundStatus.pot_amount)} AJUSD to {memberLabel(roundStatus.scheduled_recipient, walletId)}</p>
                      {roundStatus.payout_request ? (
                        roundStatus.payout_request.requester === walletId ? (
                          <p className="muted small">Your request is recorded. Another member must confirm the payout.</p>
                        ) : (
                          <button className="btn primary payout-button" type="button" disabled={payoutBusy !== null || walletActionDisabled} onClick={() => void handlePayoutAction()}>
                            {payoutBusy === 'confirm' ? 'Confirming payout…' : walletActionRecovery === 'payout' && !walletLoading && !walletError ? 'Try confirming payout again' : `Confirm payout to ${memberLabel(roundStatus.scheduled_recipient, walletId)}`}
                          </button>
                        )
                      ) : roundStatus.payout_ready ? (
                        <>
                          <p className="muted small">A different member must confirm before AJUSD transfers.</p>
                          <button className="btn primary payout-button" type="button" disabled={payoutBusy !== null || walletActionDisabled} onClick={() => void handlePayoutAction()}>
                            {payoutBusy === 'request' ? 'Requesting payout…' : walletActionRecovery === 'payout' && !walletLoading && !walletError ? 'Try releasing payout again' : `Release payout to ${memberLabel(roundStatus.scheduled_recipient, walletId)}`}
                          </button>
                        </>
                      ) : (
                        <p className="muted small">Payout processing is underway. Refresh to check its status.</p>
                      )}
                    </>
                  )}
                  {payoutNotice && <p className="action-feedback" role="status">{payoutNotice}</p>}
                  {payoutError && <p className="action-feedback error" role="alert">{payoutError}</p>}
                  {walletRecoveryNotice('payout', roundStatus.payout_request ? 'Try confirming payout again' : 'Try releasing payout again')}
                </div>
              )}
            </>
          ) : (
            <div className="head">
              <h1>Your circles</h1>
              <p className="muted">Join a circle from its invitation link, or create one to get started.</p>
              <button className="btn primary" type="button" onClick={() => navigateTo('create')}>Create a circle</button>
            </div>
          )}
        </section>

        {/* CREATE CIRCLE SECTION */}
        <section id="create" className={activeTab === 'create' ? 'on' : ''}>
          <div className="head">
            <h1>Create a circle</h1>
            <p className="muted">Create a circle with the AJUSD test token. The contract holds contributions; this test token has no cash value.</p>
          </div>
          {createdNotice && (
            <div className="notice" role="status" aria-live="polite">
              <svg className="i"><use href="#info" /></svg>
              <p>{createdNotice}</p>
            </div>
          )}
          {createdCircleId !== null && (
            <div className="panel invite-panel">
              <p className="muted small">Circle #{createdCircleId} is ready for members</p>
              <h2>Invite your people</h2>
              <p className="muted small">Share this link with the members you want in the circle.</p>
              <button className="btn primary" type="button" aria-live="polite" onClick={() => void handleCopyInvite(createdCircleId)}>
                {copiedInviteId === createdCircleId ? 'Link copied' : 'Copy invite link'}
              </button>
              {inviteCopyNotice && <p className="muted small" role="status">{inviteCopyNotice}</p>}
              {createStage === 'joining' && !creatingCircle && (
                  <button className="btn" type="button" disabled={retryingOrganizerJoin || walletActionDisabled} onClick={() => void handleRetryOrganizerJoin()}>
                  {retryingOrganizerJoin ? 'Claiming slot 1…' : walletActionRecovery === 'organizer-join' && !walletLoading && !walletError ? 'Try claiming slot 1 again' : 'Retry claiming slot 1'}
                </button>
              )}
              {walletRecoveryNotice('organizer-join', 'Try claiming slot 1 again')}
            </div>
          )}
          {createError && <div className="notice" role="alert"><p>{createError}</p></div>}
          {authenticated && walletLoading && !walletActionRecovery && <p className="muted small">Preparing your account so you can use circle actions…</p>}
          <form onSubmit={handleCreateSubmit}>
            <div className="field">
              <label htmlFor="n">Circle name</label>
              <input
                id="n"
                type="text"
                placeholder="Sunday Savers"
                autoComplete="off"
                required
                value={circleName}
                onChange={e => setCircleName(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="a">AJUSD (test) per person each round</label>
              <input
                id="a"
                type="number"
                inputMode="numeric"
                min="0.000001"
                step="0.000001"
                placeholder="1"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
              <p className="hint">AJUSD is a test stablecoin on NEAR testnet. It has no real-world value.</p>
            </div>
            <div className="field">
              <label id="fl">How often</label>
              <div className="seg" role="radiogroup" aria-labelledby="fl">
                <label>
                  <input
                    type="radio"
                    name="f"
                    checked={frequency === 'Weekly'}
                    onChange={() => setFrequency('Weekly')}
                  />
                  <span>Weekly</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="f"
                    checked={frequency === 'Monthly'}
                    onChange={() => setFrequency('Monthly')}
                  />
                  <span>Monthly</span>
                </label>
              </div>
            </div>
            <div className="field">
              <label htmlFor="m">Number of members</label>
              <input
                id="m"
                type="number"
                inputMode="numeric"
                min="3"
                max="12"
                placeholder="3"
                value={memberCount}
                onChange={e => setMemberCount(e.target.value)}
              />
              <p className="hint">Between 3 and 12. Each member picks a collection slot when they join.</p>
            </div>
            <div className="field">
              <label htmlFor="grace">Grace period (days)</label>
              <input id="grace" type="number" min="1" max="7" value={graceDays} onChange={e => setGraceDays(e.target.value)} />
              <p className="hint">You’ll join slot 1 after creation. Invite links and DAO setup are not wired yet.</p>
            </div>
            <button className="btn primary" type="submit" disabled={creatingCircle || walletActionDisabled}>
              {creatingCircle
                ? createStage === 'joining' ? 'Claiming slot 1…' : 'Creating circle…'
                : !authenticated ? 'Sign in with Google to continue'
                  : walletActionRecovery === 'create' && !walletLoading && !walletError ? 'Try creating the circle again' : 'Create circle and join slot 1'}
            </button>
            {walletRecoveryNotice('create', 'Try creating the circle again')}
          </form>
        </section>

        {/* ACTIVITY SECTION */}
        <section id="activity" className={activeTab === 'activity' ? 'on' : ''}>
          <div className="head">
            <h1>Activity</h1>
            <p className="muted">A clear list of what needs your attention across your circles.</p>
          </div>
          {authenticated && walletId && (
            <div className="activity-refresh-row">
              <span className="muted small">Your pending actions, from your circles</span>
              <button
                className="btn"
                type="button"
                disabled={activityLoading}
                onClick={() => {
                  setActivityLoading(true);
                  setActivityError(false);
                  void fetchOnChainCircles()
                    .then(setOnChainCircles)
                    .catch((error) => {
                      console.warn('Could not refresh activity', error);
                      setActivityError(true);
                    })
                    .finally(() => setActivityLoading(false));
                }}
              >
                {activityLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          )}
          {activityError && <p className="action-feedback error" role="alert">Could not refresh your activity. Check your connection and try again.</p>}
          {activityLoading && activityItems.length === 0 ? (
            <div className="panel activity-empty" role="status">Checking your circles for updates…</div>
          ) : !authenticated ? (
            <div className="panel activity-empty">
              <h2>Sign in to see your activity</h2>
              <p className="muted">Your contributions, payout confirmations, and votes will appear here.</p>
              <button className="btn primary" type="button" onClick={() => void login()}>Sign in with Google</button>
            </div>
          ) : !walletId ? (
            <div className="panel activity-empty" role="status">
              <h2>Your circles are getting ready</h2>
              <p className="muted">Activity will appear here once your account is ready.</p>
            </div>
          ) : activityItems.length ? (
            <div className="activity-inbox">
              <div className="activity-inbox-heading">
                <div>
                  <h2>Needs your attention</h2>
                  <p className="muted small">{activityItems.length} pending action{activityItems.length === 1 ? '' : 's'}</p>
                </div>
              </div>
              <div className="activity-list">
                {activityItems.map((item) => (
                  <article className="activity-item" key={item.id}>
                    <div className="activity-item-copy">
                      <p className="activity-type">{item.kind === 'contribution' ? 'Contribution' : item.kind === 'payout' ? 'Payout' : 'Circle vote'}</p>
                      <h3>{item.title}</h3>
                      <p className="muted small">{item.detail}</p>
                    </div>
                    <div className="activity-item-action">
                      <span className={`chip ${item.overdue ? 'bad' : item.kind === 'contribution' ? 'late' : ''}`}>{item.status}</span>
                      <button className="btn" type="button" onClick={() => openActivityCircle(item.circleId)}>Open circle</button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ) : joinedCircles.length === 0 ? (
            <div className="panel activity-empty">
              <h2>No circles to show yet</h2>
              <p className="muted">Join a circle to see contributions, payout confirmations, and votes that need you.</p>
              <button className="btn primary" type="button" onClick={() => navigateTo('circle')}>View circles</button>
            </div>
          ) : (
            <div className="panel activity-empty">
              <span className="activity-check" aria-hidden="true"><svg className="i"><use href="#check" /></svg></span>
              <h2>You’re all caught up</h2>
              <p className="muted">No contributions, payout confirmations, or votes need you right now.</p>
              {activityLoading && <p className="muted small" role="status">Refreshing your circle activity…</p>}
            </div>
          )}
        </section>

        {/* PROFILE SECTION */}
        <section id="profile" className={activeTab === 'profile' ? 'on' : ''}>
          <div className="head">
            <h1>{displayName}</h1>
            <p className="muted">Member since October 2026</p>
          </div>
          <div className="panel profile-name-panel">
            <div>
              <h2>Display name</h2>
              <p className="muted small">Choose the name you want people in your circle to see.</p>
            </div>
            <label className="profile-name-label" htmlFor="profile-display-name">Your name</label>
            <input
              id="profile-display-name"
              className="profile-name-input"
              type="text"
              autoComplete="name"
              maxLength={32}
              value={displayNameDraft}
              onChange={(event) => {
                setDisplayNameDraft(event.target.value);
                setDisplayNameSaved(false);
              }}
              placeholder="e.g. Ngozi"
            />
            <div className="profile-name-actions">
              <span className="muted small" role="status" aria-live="polite">{displayNameSaved ? 'Saved' : ''}</span>
              <button
                className="btn primary"
                type="button"
                disabled={!authenticated || displayNameDraft.trim().length < 2 || displayNameDraft.trim().length > 32}
                onClick={saveDisplayName}
              >
                Save name
              </button>
            </div>
          </div>
          <div className="list">
            <dl>
              <div>
                <dt>Cycles completed</dt>
                <dd>2</dd>
              </div>
              <div>
                <dt>Payments on time</dt>
                <dd>14</dd>
              </div>
              <div>
                <dt>Payments late</dt>
                <dd>1</dd>
              </div>
              <div>
                <dt>Defaults</dt>
                <dd>0</dd>
              </div>
            </dl>
          </div>
          <p className="muted small" style={{ marginTop: '16px' }}>
            New accounts show “No history”. Your record only counts inside Ajocircle.
          </p>
        </section>

        {/* SETTINGS SECTION */}
        <section id="settings" className={activeTab === 'settings' ? 'on' : ''}>
          <div className="head">
            <h1>Settings</h1>
          </div>
          <div className="list">
            <div className="row">
              <span className="grow">
                <b>Display name</b>
                <br />
                <span className="muted small">{displayName}</span>
              </span>
            </div>
            <div className="row">
              <span className="grow">
                <b>Signed in with</b>
                <br />
                <span className="muted small">
                  {authenticated ? `Google, ${displayEmail}` : 'Sample Account (Google)'}
                </span>
              </span>
            </div>
            <div className="row">
              <span className="grow">
                <b>Show technical details</b>
                <br />
                <span className="muted small">Account IDs and transaction links</span>
              </span>
              <button
                className="switch"
                role="switch"
                aria-checked={showTechnicalDetails}
                aria-label="Show technical details"
                onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
              ></button>
            </div>
          </div>

          {showTechnicalDetails && (
            <div className="panel" style={{ marginTop: '16px' }}>
              <h2>Technical Details</h2>
              <p className="muted small">NEAR Network: testnet</p>
              <p className="muted small">
                Contract:{' '}
                <a
                  href={`https://testnet.nearblocks.io/address/${CONTRACT_ID}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: 'underline', color: 'var(--accent)' }}
                >
                  {CONTRACT_ID}
                </a>
              </p>
              <p className="muted small">
                Deployed Tx:{' '}
                <a
                  href="https://testnet.nearblocks.io/txns/2CPHyF3XM8H9KzCRVE6Fir7vtmUx6fgxYgx3ofZ5KK5C"
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: 'underline', color: 'var(--accent)' }}
                >
                  2CPHyF3X...Z5KK5C
                </a>
              </p>
              <p className="muted small">Live On-Chain Circles: {onChainCircles.length} Active</p>
              <p className="muted small">Gas Sponsorship: Enabled (0 user fees)</p>
            </div>
          )}

          <div className="notice" style={{ marginTop: '16px' }}>
            <svg className="i"><use href="#info" /></svg>
            <p>This prototype uses test money. No real naira moves.</p>
          </div>

          <div style={{ marginTop: '24px' }}>
            {authenticated ? (
              <button className="btn" onClick={() => logout()}>
                Sign out
              </button>
            ) : (
              <button className="btn primary" onClick={() => login()}>
                Sign in with Google or Email
              </button>
            )}
          </div>
        </section>

        {/* HELP SECTION */}
        <section id="help" className={activeTab === 'help' ? 'on' : ''}>
          <div className="head">
            <h1>Help</h1>
            <p className="muted">How an Ajocircle circle works.</p>
          </div>
          <div className="panel">
            <p>
              Everyone pays the same amount each round. The full pot goes to one member, in the order agreed at the start, until everyone has collected once. A contract holds the money, so nobody can run off with it.
            </p>
          </div>
        </section>
      </main>

      {/* Mobile Bottom Tabs Navigation (< 1024px) */}
      <nav className="tabs" aria-label="Main">
        <button
          onClick={() => navigateTo('home')}
          aria-current={activeTab === 'home' ? 'page' : undefined}
        >
          <svg className="i"><use href="#home" /></svg>
          Home
        </button>
        <button
          onClick={() => navigateTo('circle')}
          aria-current={activeTab === 'circle' ? 'page' : undefined}
        >
          <svg className="i"><use href="#users" /></svg>
          Circles
        </button>
        <button
          className="make"
          aria-label="Create circle"
          onClick={() => navigateTo('create')}
        >
          <span className="dot">
            <svg className="i"><use href="#plus" /></svg>
          </span>
        </button>
        <button
          onClick={() => navigateTo('activity')}
          aria-current={activeTab === 'activity' ? 'page' : undefined}
        >
          <svg className="i"><use href="#bell" /></svg>
          Activity
          {activityItems.length > 0 && <span className="badge mobile-activity-badge" aria-label={`${activityItems.length} pending actions`}>{activityItems.length}</span>}
        </button>
        <button
          onClick={() => navigateTo('profile')}
          aria-current={activeTab === 'profile' ? 'page' : undefined}
        >
          <svg className="i"><use href="#user" /></svg>
          Profile
        </button>
      </nav>
    </>
  );
}
