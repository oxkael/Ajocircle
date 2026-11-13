import { useState, useEffect } from 'react';
import { useLogin, useLogout, usePrivy } from '@privy-io/react-auth';
import { fetchOnChainCircles, fetchRoundStatus, CONTRACT_ID, type OnChainCircle, type RoundStatus } from './lib/near';
import { TEST_TOKEN_ID } from './lib/near';
import { useNEAR } from './context/useNear';
import './App.css';

type SectionId = 'home' | 'circle' | 'create' | 'activity' | 'profile' | 'settings' | 'help';

function formatAjusd(units: string): string {
  return (Number(units) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function friendlyTransactionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message.includes('Wallet proxy not initialized')) return 'Your sign-in wallet needed to reconnect. We are preparing it again; try this action once setup finishes.';
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

  // Active Section Routing (matches #home, #circle, etc.)
  const [activeTab, setActiveTab] = useState<SectionId>('home');

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
  const walletActionDisabled = authenticated && (walletLoading || !nearAccount || Boolean(walletError));

  const recoverWalletAfterSigningError = (error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('Wallet proxy not initialized')) void retryWalletSetup();
    return friendlyTransactionError(error, fallback);
  };

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

  const displayName = authenticated
    ? user?.google?.name || user?.google?.email?.split('@')[0] || user?.email?.address?.split('@')[0] || 'Ngozi'
    : 'Ngozi';

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
      await navigator.clipboard.writeText(link);
      setCopiedInviteId(circleId);
      setInviteCopyNotice('Invite link copied.');
      window.setTimeout(() => setCopiedInviteId((current) => current === circleId ? null : current), 2500);
    } catch {
      setInviteCopyNotice('Copy isn’t available here. Select and copy the link below.');
    }
  };

  const refreshSelectedCircle = () => {
    setCircleRefreshKey((key) => key + 1);
    void fetchOnChainCircles().then(setOnChainCircles).catch((error) => {
      console.warn('Could not refresh circle list', error);
    });
  };

  const handleGetTestTokens = async () => {
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
      setContributionError(recoverWalletAfterSigningError(error, 'Could not add test tokens. Check your testnet balance and try again.'));
    } finally {
      setContributionBusy(null);
    }
  };

  const handlePayContribution = async () => {
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
      setContributionError(recoverWalletAfterSigningError(error, 'Payment did not go through. Your balance was not marked as paid.'));
    } finally {
      setContributionBusy(null);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      const message = recoverWalletAfterSigningError(error, 'Circle creation failed.');
      setCreateError(message);
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
      setCreateError(recoverWalletAfterSigningError(error, 'Could not claim slot 1.'));
    } finally {
      setRetryingOrganizerJoin(false);
    }
  };

  const handleJoinCircle = async (circle: OnChainCircle) => {
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
      setJoinError(recoverWalletAfterSigningError(error, 'Could not join this circle. Refresh and try again.'));
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
          <span className="badge">3</span>
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
        {authenticated && walletLoading && (
          <p className="muted small wallet-status" role="status">Preparing your sign-in wallet for NEAR actions…</p>
        )}
        {authenticated && walletError && (
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
              <p className="muted">{selectedCircle.name} ? Round {roundStatus.current_round + 1} of {roundStatus.total_rounds}</p>
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
                            : 'Join this circle'}
                      </button>
                    ) : (
                      <p className="muted small">This circle is no longer open to new members.</p>
                    )}
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
                    <span className="muted small">{formatAjusd(circle.amount_per_round)} AJUSD ? {circle.members.length}/{circle.max_members} members</span>
                  </span>
                  <span className={`chip ${circle.status === 'Open' ? 'wait' : ''}`}>{circle.status}</span>
                </button>
              )) : (
                <p className="row muted">Circles you join will appear here.</p>
              )}
            </div>
          </div>
          <p className="muted small">Payments and member activity are shown from each circle?s latest update.</p>
        </section>

        {/* CIRCLE SECTION */}
        <section id="circle" className={activeTab === 'circle' ? 'on' : ''}>
          {selectedCircle ? (
            <>
              <div className="head">
                <p className="muted small">Your circle</p>
                <h1>{selectedCircle.name}</h1>
                <p className="muted">{formatAjusd(selectedCircle.amount_per_round)} AJUSD per person ? {selectedCircle.members.length} of {selectedCircle.max_members} members</p>
              </div>

              <div className="panel invite-panel">
                <p className="muted small">Share with your group</p>
                <h2>Invite members</h2>
                <div className="invite-link-row">
                  <input aria-label="Circle invite link" readOnly value={inviteUrl(selectedCircle.id)} onFocus={(event) => event.currentTarget.select()} />
                  <button className="btn primary" type="button" onClick={() => void handleCopyInvite(selectedCircle.id)}>
                    {copiedInviteId === selectedCircle.id ? 'Copied' : 'Copy link'}
                  </button>
                </div>
                {inviteCopyNotice && <p className="muted small" role="status">{inviteCopyNotice}</p>}
                <p className="hint">Anyone with the link can join while places are open.</p>
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
                  <>
                    <p className="circle-pot">{formatAjusd(roundStatus.pot_amount)} <span>AJUSD in the pot</span></p>
                    {roundStatus.scheduled_recipient && <p className="muted small">Collection turn: {roundStatus.scheduled_recipient === walletId ? 'you' : roundStatus.scheduled_recipient}</p>}
                    <p className="muted small">{roundStatus.paid_members.length} of {selectedCircle.members.length} members have contributed.</p>
                  </>
                ) : selectedCircle.status === 'Open' ? (
                  <p className="muted">Contributions open once every place is filled.</p>
                ) : selectedCircle.status === 'Active' ? (
                  <p className="muted">Loading this round’s payment details…</p>
                ) : (
                  <p className="muted">This circle has finished.</p>
                )}
              </div>

              {selectedCircle.status === 'Active' && roundStatus && (
                <div className="panel contribution-panel">
                  <div className="contribution-topline">
                    <div>
                      <p className="muted small">Your contribution</p>
                      <p className="contribution-amount">{formatAjusd(roundStatus.amount_per_member)} AJUSD</p>
                    </div>
                    {tokenBalance !== null && <span className="chip">Balance {formatAjusd(tokenBalance)} AJUSD</span>}
                  </div>
                  {roundStatus.paid_members.includes(walletId) ? (
                    <p className="contribution-done" role="status">You?ve contributed for this round.</p>
                  ) : BigInt(tokenBalance || '0') < BigInt(roundStatus.amount_per_member) ? (
                    <>
                      <p className="muted small">These are test tokens with no cash value.</p>
                      <p className="muted small">First use may require a small one-time testnet NEAR deposit to set up your AJUSD balance.</p>
                      <button className="btn primary" type="button" disabled={contributionBusy !== null || circleDataLoading || !roundStatus || walletActionDisabled} onClick={() => void handleGetTestTokens()}>
                        {contributionBusy === 'tokens' ? 'Getting test AJUSD?' : `Get ${formatAjusd(roundStatus.amount_per_member)} test AJUSD`}
                      </button>
                    </>
                  ) : (
                    <button className="btn primary" type="button" disabled={contributionBusy !== null || circleDataLoading || walletActionDisabled} onClick={() => void handlePayContribution()}>
                      {contributionBusy === 'payment' ? 'Recording your contribution?' : `Contribute ${formatAjusd(roundStatus.amount_per_member)} AJUSD`}
                    </button>
                  )}
                  {contributionNotice && <p className="contribution-feedback" role="status">{contributionNotice}</p>}
                  {contributionError && <p className="contribution-feedback error" role="alert">{contributionError}</p>}
                </div>
              )}

              <div>
                <h2>Members</h2>
                <div className="list">
                  {selectedCircle.slots.map((member, index) => {
                    const paid = Boolean(member && roundStatus?.paid_members.includes(member));
                    const collecting = roundStatus?.current_round === index && selectedCircle.status === 'Active';
                    return (
                      <div className="row" key={`${selectedCircle.id}-${index}`}>
                        <span className="av">{member ? (member === walletId ? 'You' : member.slice(0, 2).toUpperCase()) : String(index + 1).padStart(2, '0')}</span>
                        <span className="grow">
                          <b>{member ? (member === walletId ? 'You' : member) : 'Open place'}</b>
                          <br />
                          <span className="muted small">Slot {index + 1}{collecting ? ' ? collects this round' : ''}</span>
                        </span>
                        {member && roundStatus && selectedCircle.status === 'Active' && (
                          <span className={`chip ${paid ? '' : 'wait'}`}>{paid ? 'Contributed' : 'Not yet'}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {roundStatus?.is_round_fully_paid && (
                <div className="notice" role="status">
                  <svg className="i"><use href="#info" /></svg>
                  <p>Everyone has contributed. Payout approval is the next step to connect in the app.</p>
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
              <input aria-label="Circle invite link" readOnly value={inviteUrl(createdCircleId)} onFocus={(event) => event.currentTarget.select()} />
              <button className="btn primary" type="button" onClick={() => void handleCopyInvite(createdCircleId)}>
                {copiedInviteId === createdCircleId ? 'Link copied' : 'Copy invite link'}
              </button>
              {inviteCopyNotice && <p className="muted small" role="status">{inviteCopyNotice}</p>}
              {createStage === 'joining' && !creatingCircle && (
                  <button className="btn" type="button" disabled={retryingOrganizerJoin || walletActionDisabled} onClick={() => void handleRetryOrganizerJoin()}>
                  {retryingOrganizerJoin ? 'Claiming slot 1…' : 'Retry claiming slot 1'}
                </button>
              )}
            </div>
          )}
          {createError && <div className="notice" role="alert"><p>{createError}</p></div>}
          {authenticated && walletLoading && <p className="muted small">Preparing your NEAR testnet account…</p>}
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
                  : 'Create circle and join slot 1'}
            </button>
          </form>
        </section>

        {/* ACTIVITY SECTION */}
        <section id="activity" className={activeTab === 'activity' ? 'on' : ''}>
          <div className="head">
            <h1>Activity</h1>
            <p className="muted">Things that need you.</p>
          </div>
          <div className="list">
            <div className="row" onClick={() => navigateTo('circle')} role="button" tabIndex={0}>
              <span className="grow">
                <b>Pay ₦20,000</b>
                <br />
                <span className="muted small">Sunday Savers, due Friday</span>
              </span>
              <span className="chip late">Due soon</span>
            </div>
            <div className="row" onClick={() => navigateTo('circle')} role="button" tabIndex={0}>
              <span className="grow">
                <b>Confirm payout to Tunde</b>
                <br />
                <span className="muted small">Sunday Savers, released by Amaka</span>
              </span>
              <span className="chip">Ready</span>
            </div>
            <div className="row" onClick={() => navigateTo('circle')} role="button" tabIndex={0}>
              <span className="grow">
                <b>Vote: remove Emeka?</b>
                <br />
                <span className="muted small">Market Women Monthly, 2 days late</span>
              </span>
              <span className="chip bad">Open vote</span>
            </div>
          </div>
        </section>

        {/* PROFILE SECTION */}
        <section id="profile" className={activeTab === 'profile' ? 'on' : ''}>
          <div className="head">
            <h1>{displayName} Adeyemi</h1>
            <p className="muted">Member since October 2026</p>
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
                <span className="muted small">{displayName} Adeyemi</span>
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
