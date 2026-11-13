use near_sdk::near;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, require, AccountId, NearToken, PanicOnDefault, Promise, PromiseOrValue};
use near_sdk::json_types::U128;
use std::collections::HashMap;

const SPUTNIK_FACTORY: &str = "sputnikv2.testnet";
const SPUTNIK_PROPOSAL_BOND: u128 = 1_000_000_000_000_000_000_000_000;
const SPUTNIK_PROPOSAL_GAS: u64 = 100_000_000_000_000;

#[ext_contract(ext_sputnik_factory)]
trait SputnikFactory {
    fn create(&mut self, name: String, args: String) -> bool;
}

#[ext_contract(ext_sputnik_dao)]
trait SputnikDao {
    fn add_proposal(&mut self, proposal: near_sdk::serde_json::Value) -> u64;
    fn get_policy(&self) -> near_sdk::serde_json::Value;
}

#[ext_contract(ext_fungible_token)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
trait CircleCallbacks {
    fn on_circle_dao_created(
        &mut self,
        circle_id: u64,
        dao_id: AccountId,
    ) -> bool;
    fn on_circle_dao_policy_checked(&mut self, circle_id: u64, dao_id: AccountId) -> bool;
    fn on_removal_proposal_submitted(&mut self, circle_id: u64, member: AccountId) -> bool;
    fn on_role_removal_proposal_submitted(&mut self, circle_id: u64, member: AccountId) -> bool;
    fn on_removal_dao_policy_checked(&mut self, circle_id: u64, member: AccountId) -> bool;
    fn on_token_payout(&mut self, circle_id: u64, round: u32, recipient: AccountId, amount: U128) -> bool;
}

fn dao_storage_key(circle_id: u64) -> Vec<u8> {
    format!("ajocircle:dao:{circle_id}").into_bytes()
}

fn dao_pending_key(circle_id: u64) -> Vec<u8> {
    format!("ajocircle:dao-pending:{circle_id}").into_bytes()
}

fn dao_bond_reserve_key(circle_id: u64) -> Vec<u8> {
    format!("ajocircle:dao-bond-reserve:{circle_id}").into_bytes()
}

fn removal_sync_key(circle_id: u64) -> Vec<u8> {
    format!("ajocircle:removal-sync:{circle_id}").into_bytes()
}

fn circle_token_key(circle_id: u64) -> Vec<u8> {
    format!("ajocircle:circle-token:{circle_id}").into_bytes()
}

fn payout_pending_key(circle_id: u64) -> Vec<u8> {
    format!("ajocircle:payout-pending:{circle_id}").into_bytes()
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
struct PendingTokenPayout {
    round: u32,
    recipient: AccountId,
    amount: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemovalSyncStage {
    SubmittingRemoval,
    RemovalVoting,
    SubmittingRoleRemoval,
    RoleRemovalVoting,
    Synced,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct RemovalSyncView {
    pub member: AccountId,
    pub proposer: AccountId,
    pub removal_proposal_id: Option<u64>,
    pub role_removal_proposal_id: Option<u64>,
    pub stage: RemovalSyncStage,
}

fn read_removal_sync(circle_id: u64) -> Option<RemovalSyncView> {
    env::storage_read(&removal_sync_key(circle_id))
        .and_then(|bytes| near_sdk::serde_json::from_slice(&bytes).ok())
}

fn write_removal_sync(circle_id: u64, sync: &RemovalSyncView) {
    env::storage_write(
        &removal_sync_key(circle_id),
        &near_sdk::serde_json::to_vec(sync).expect("Removal sync state serializes"),
    );
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CircleStatus {
    Open,
    Active,
    Ended,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PayoutRequest {
    pub requester: AccountId,
    pub round: u32,
    pub created_at: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub enum ProposalType {
    RemoveMember { member: AccountId, had_collected: bool },
    ContinueCircle,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub proposer: AccountId,
    pub proposal_type: ProposalType,
    pub votes: HashMap<AccountId, bool>,
    pub passed: bool,
    pub executed: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct MemberProfile {
    pub completed_cycles: u32,
    pub on_time_rounds: u32,
    pub late_rounds: u32,
    pub defaults: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct RoundStatusView {
    pub circle_id: u64,
    pub current_round: u32,
    pub total_rounds: u32,
    pub scheduled_recipient: Option<AccountId>,
    pub amount_per_member: NearToken,
    pub pot_amount: NearToken,
    pub round_start_time: u64,
    pub round_deadline: u64,
    pub grace_period_seconds: u64,
    pub paid_members: Vec<AccountId>,
    pub missing_members: Vec<AccountId>,
    pub is_round_fully_paid: bool,
    pub is_round_late: bool,
    pub payout_ready: bool,
    pub payout_request: Option<PayoutRequest>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Circle {
    pub id: u64,
    pub name: String,
    pub organizer: AccountId,
    pub amount_per_round: NearToken,
    pub interval_seconds: u64,
    pub grace_period_seconds: u64,
    pub max_members: u32,
    pub members: Vec<AccountId>,
    pub slots: Vec<Option<AccountId>>,
    pub status: CircleStatus,
    pub current_round: u32,
    pub round_start_time: u64,
    pub round_deadline: u64,
    pub round_payments: HashMap<u32, Vec<AccountId>>,
    pub collected_members: Vec<AccountId>,
    pub payout_request: Option<PayoutRequest>,
    pub proposals: Vec<Proposal>,
    pub removed_members: Vec<AccountId>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct CircleContract {
    pub next_circle_id: u64,
    pub circles: LookupMap<u64, Circle>,
    pub circle_ids: Vec<u64>,
    pub profiles: LookupMap<AccountId, MemberProfile>,
}

#[near]
impl CircleContract {
    #[init]
    pub fn new() -> Self {
        require!(!env::state_exists(), "Already initialized");
        Self {
            next_circle_id: 1,
            circles: LookupMap::new(b"c"),
            circle_ids: Vec::new(),
            profiles: LookupMap::new(b"p"),
        }
    }

    /// Create a new autonomous savings circle.
    /// The organizer has ZERO custody over funds; funds are secured autonomously by the contract.
    pub fn create_circle(
        &mut self,
        name: String,
        amount_per_round: NearToken,
        interval_seconds: u64,
        grace_period_seconds: u64,
        max_members: u32,
    ) -> u64 {
        require!(max_members >= 2 && max_members <= 20, "Members must be between 2 and 20");
        require!(amount_per_round.as_yoctonear() > 0, "Contribution must be greater than 0");
        require!(interval_seconds >= 60, "Interval must be at least 60 seconds");

        let circle_id = self.next_circle_id;
        self.next_circle_id += 1;

        let organizer = env::predecessor_account_id();
        let circle = Circle {
            id: circle_id,
            name,
            organizer,
            amount_per_round,
            interval_seconds,
            grace_period_seconds,
            max_members,
            members: Vec::new(),
            slots: vec![None; max_members as usize],
            status: CircleStatus::Open,
            current_round: 0,
            round_start_time: 0,
            round_deadline: 0,
            round_payments: HashMap::new(),
            collected_members: Vec::new(),
            payout_request: None,
            proposals: Vec::new(),
            removed_members: Vec::new(),
        };

        self.circles.insert(circle_id, circle);
        self.circle_ids.push(circle_id);

        env::log_str(&format!("Circle created: id={}, name={}", circle_id, self.circles.get(&circle_id).unwrap().name));
        circle_id
    }

    /// Create a circle that accepts contributions in one fixed NEP-141 token.
    /// `amount_per_round` is expressed in that token's smallest units.
    pub fn create_token_circle(
        &mut self,
        name: String,
        amount_per_round: NearToken,
        interval_seconds: u64,
        grace_period_seconds: u64,
        max_members: u32,
        token_id: AccountId,
    ) -> u64 {
        let circle_id = self.create_circle(
            name,
            amount_per_round,
            interval_seconds,
            grace_period_seconds,
            max_members,
        );
        env::storage_write(&circle_token_key(circle_id), token_id.as_bytes());
        circle_id
    }

    /// Create this full circle's Sputnik DAO. The caller pays the factory deposit.
    #[payable]
    pub fn start_circle(&mut self, circle_id: u64) -> Promise {
        let circle = self.circles.get(&circle_id).expect("Circle not found");
        require!(circle.status == CircleStatus::Active, "Circle must be full before DAO creation");
        require!(circle.members.len() == circle.max_members as usize, "Circle is not full");
        require!(env::predecessor_account_id() == circle.organizer, "Only the organizer can start the circle");
        require!(env::storage_read(&dao_storage_key(circle_id)).is_none(), "Circle DAO already exists");
        require!(env::storage_read(&dao_pending_key(circle_id)).is_none(), "Circle DAO creation is already pending");

        let attached = env::attached_deposit();
        require!(attached.as_yoctonear() >= 7 * SPUTNIK_PROPOSAL_BOND, "Attach 6 NEAR for the DAO and 1 NEAR for its reusable proposal reserve");

        let dao_name = format!("ajocircle-{}-{}", circle_id, env::block_height());
        let dao_id: AccountId = format!("{}.sputnikv2.testnet", dao_name).parse().expect("Valid DAO account id");
        let contract_id = env::current_account_id();
        let member_ids: Vec<String> = circle.members.iter().map(ToString::to_string).collect();
        let policy = near_sdk::serde_json::json!({
            "roles": [
                {
                    "name": "circle",
                    "kind": { "Group": [contract_id.as_str()] },
                    "permissions": ["transfer:AddProposal", "call:AddProposal", "remove_member_from_role:AddProposal"],
                    "vote_policy": {}
                },
                {
                    "name": "members",
                    "kind": { "Group": member_ids },
                    "permissions": [
                        "transfer:VoteApprove", "transfer:VoteReject",
                        "call:VoteApprove", "call:VoteReject",
                        "remove_member_from_role:VoteApprove",
                        "*:Finalize"
                    ],
                    "vote_policy": {
                        "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "2" },
                        "call": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
                        "remove_member_from_role": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" }
                    }
                }
            ],
            "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
            "proposal_bond": SPUTNIK_PROPOSAL_BOND.to_string(),
            "proposal_period": "604800000000000",
            "bounty_bond": SPUTNIK_PROPOSAL_BOND.to_string(),
            "bounty_forgiveness_period": "86400000000000"
        });
        let config = near_sdk::serde_json::json!({
            "name": format!("Ajocircle: {}", circle.name),
            "purpose": format!("Governance DAO for Ajocircle circle {}", circle_id),
            "metadata": ""
        });
        use near_sdk::base64::Engine as _;
        let args = near_sdk::base64::engine::general_purpose::STANDARD.encode(near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "config": config,
            "policy": policy
        })).expect("DAO arguments serialize"));

        env::storage_write(&dao_pending_key(circle_id), dao_id.as_bytes());
        env::storage_write(&dao_bond_reserve_key(circle_id), b"1");
        ext_sputnik_factory::ext(SPUTNIK_FACTORY.parse().expect("Factory account id"))
            .with_attached_deposit(attached.saturating_sub(NearToken::from_yoctonear(SPUTNIK_PROPOSAL_BOND)))
            .with_static_gas(near_sdk::Gas::from_tgas(150))
            .create(dao_name, args)
            .then(ext_self::ext(contract_id)
                .with_static_gas(near_sdk::Gas::from_tgas(20))
                .on_circle_dao_created(circle_id, dao_id))
    }

    #[private]
    pub fn on_circle_dao_created(
        &mut self,
        circle_id: u64,
        dao_id: AccountId,
    ) -> bool {
        let pending = env::storage_read(&dao_pending_key(circle_id));
        require!(pending.as_deref() == Some(dao_id.as_bytes()), "DAO creation callback does not match pending request");
        require!(env::promise_results_count() == 1, "Expected one DAO factory result");
        match env::promise_result_checked(0, 128 * 1024) {
            Ok(bytes) if bytes.is_empty() || near_sdk::serde_json::from_slice::<bool>(&bytes).unwrap_or(false) => {
                env::storage_remove(&dao_pending_key(circle_id));
                env::storage_write(&dao_storage_key(circle_id), dao_id.as_bytes());
                env::log_str(&format!("Sputnik DAO {} attached to circle {}", dao_id, circle_id));
                true
            }
            _ => {
                env::log_str(&format!("Sputnik DAO creation failed for circle {}", circle_id));
                false
            }
        }
    }

    /// Retry association when the factory created the DAO but its callback did not complete.
    pub fn recover_circle_dao(&self, circle_id: u64) -> Promise {
        let circle = self.circles.get(&circle_id).expect("Circle not found");
        require!(env::predecessor_account_id() == circle.organizer, "Only the organizer can recover DAO association");
        require!(self.get_circle_dao(circle_id).is_none(), "Circle DAO is already associated");
        let pending = env::storage_read(&dao_pending_key(circle_id)).expect("No pending DAO association");
        let dao_id: AccountId = String::from_utf8(pending).expect("Pending DAO id is valid UTF-8").parse().expect("Pending DAO id is valid");
        let contract_id = env::current_account_id();
        ext_sputnik_dao::ext(dao_id.clone())
            .with_static_gas(near_sdk::Gas::from_tgas(15))
            .get_policy()
            .then(ext_self::ext(contract_id)
                .with_static_gas(near_sdk::Gas::from_tgas(25))
                .on_circle_dao_policy_checked(circle_id, dao_id))
    }

    #[private]
    pub fn on_circle_dao_policy_checked(&mut self, circle_id: u64, dao_id: AccountId) -> bool {
        let pending = env::storage_read(&dao_pending_key(circle_id));
        require!(pending.as_deref() == Some(dao_id.as_bytes()), "DAO recovery callback does not match pending request");
        require!(env::promise_results_count() == 1, "Expected one DAO policy result");
        let Ok(bytes) = env::promise_result_checked(0, 128 * 1024) else { return false; };
        let Ok(policy) = near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&bytes) else { return false; };
        let circle = self.circles.get(&circle_id).expect("Circle not found");
        let contract_id = env::current_account_id().to_string();
        let expected_members: Vec<String> = circle.members.iter().map(ToString::to_string).collect();
        let roles = policy.get("roles").and_then(|value| value.as_array());
        let has_contract_role = roles.is_some_and(|roles| roles.iter().any(|role|
            role.get("name").and_then(|value| value.as_str()) == Some("circle") &&
            role.get("kind").and_then(|value| value.get("Group")).and_then(|value| value.as_array())
                .is_some_and(|group| group.iter().any(|member| member.as_str() == Some(contract_id.as_str())))
        ));
        let has_member_role = roles.is_some_and(|roles| roles.iter().any(|role| {
            if role.get("name").and_then(|value| value.as_str()) != Some("members") { return false; }
            let Some(group) = role.get("kind").and_then(|value| value.get("Group")).and_then(|value| value.as_array()) else { return false; };
            let mut actual: Vec<String> = group.iter().filter_map(|value| value.as_str().map(ToOwned::to_owned)).collect();
            let mut expected = expected_members.clone();
            actual.sort();
            expected.sort();
            actual == expected
        }));
        if has_contract_role && has_member_role {
            env::storage_remove(&dao_pending_key(circle_id));
            env::storage_write(&dao_storage_key(circle_id), dao_id.as_bytes());
            env::log_str(&format!("Recovered and verified Sputnik DAO {} for circle {}", dao_id, circle_id));
            true
        } else {
            env::log_str(&format!("DAO policy did not match circle {} during recovery", circle_id));
            false
        }
    }

    pub fn get_circle_dao(&self, circle_id: u64) -> Option<AccountId> {
        env::storage_read(&dao_storage_key(circle_id))
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|value| value.parse().ok())
    }

    /// Return the NEP-141 token configured for this circle, if any.
    pub fn get_circle_token(&self, circle_id: u64) -> Option<AccountId> {
        self.circles.get(&circle_id)?;
        env::storage_read(&circle_token_key(circle_id))
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|value| value.parse().ok())
    }

    /// Claim an available slot in an Open circle.
    /// When all slots are filled, the circle automatically starts Round 0.
    pub fn join(&mut self, circle_id: u64, slot: u32) {
        let caller = env::predecessor_account_id();
        let circle = self.circles.get_mut(&circle_id).expect("Circle not found");

        require!(circle.status == CircleStatus::Open, "Circle is not open for joining");
        require!((slot as usize) < circle.slots.len(), "Invalid slot index");
        require!(circle.slots[slot as usize].is_none(), "Slot already claimed");
        require!(!circle.members.contains(&caller), "Caller already joined this circle");

        circle.slots[slot as usize] = Some(caller.clone());
        circle.members.push(caller.clone());

        env::log_str(&format!("Member {} joined circle {} at slot {}", caller, circle_id, slot));

        // If circle is now full, start circle automatically
        if circle.members.len() == (circle.max_members as usize) {
            circle.status = CircleStatus::Active;
            circle.current_round = 0;
            let now_sec = env::block_timestamp() / 1_000_000_000;
            circle.round_start_time = now_sec;
            circle.round_deadline = now_sec + circle.interval_seconds;
            env::log_str(&format!("Circle {} is full and now ACTIVE. Round 0 started.", circle_id));
        }
    }

    /// NEP-141 receiver hook. The circle accepts only its configured token,
    /// exact round dues, and one contribution per active member and round.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let Ok(circle_id) = msg.parse::<u64>() else {
            env::log_str("Rejected NEP-141 contribution: msg must be a circle id");
            return PromiseOrValue::Value(amount);
        };
        let Some(token_id) = env::storage_read(&circle_token_key(circle_id)) else {
            env::log_str("Rejected NEP-141 contribution: circle is not token-enabled");
            return PromiseOrValue::Value(amount);
        };
        if token_id.as_slice() != env::predecessor_account_id().as_bytes() {
            env::log_str("Rejected NEP-141 contribution: unapproved token");
            return PromiseOrValue::Value(amount);
        }

        let now_sec = env::block_timestamp() / 1_000_000_000;
        let Some(circle) = self.circles.get_mut(&circle_id) else {
            env::log_str("Rejected NEP-141 contribution: circle not found");
            return PromiseOrValue::Value(amount);
        };
        if circle.status != CircleStatus::Active
            || !circle.members.contains(&sender_id)
            || amount.0 != circle.amount_per_round.as_yoctonear()
        {
            env::log_str("Rejected NEP-141 contribution: inactive circle, non-member, or wrong amount");
            return PromiseOrValue::Value(amount);
        }

        let current_round = circle.current_round;
        let payments = circle.round_payments.entry(current_round).or_default();
        if payments.contains(&sender_id) {
            env::log_str("Rejected NEP-141 contribution: member already paid this round");
            return PromiseOrValue::Value(amount);
        }
        payments.push(sender_id.clone());

        let profile = self.profiles.entry(sender_id.clone()).or_default();
        if now_sec <= circle.round_deadline {
            profile.on_time_rounds += 1;
        } else {
            profile.late_rounds += 1;
        }
        env::log_str(&format!(
            "Member {} contributed to circle {} round {}: {}/{}",
            sender_id, circle_id, current_round, payments.len(), circle.members.len()
        ));
        PromiseOrValue::Value(U128(0))
    }

    /// Deposit round dues. Payable with attached NEAR deposit.
    #[payable]
    pub fn deposit(&mut self, circle_id: u64) {
        let caller = env::predecessor_account_id();
        let attached = env::attached_deposit();
        let now_sec = env::block_timestamp() / 1_000_000_000;

        let circle = self.circles.get_mut(&circle_id).expect("Circle not found");
        require!(env::storage_read(&circle_token_key(circle_id)).is_none(), "Use NEP-141 ft_transfer_call for this circle");
        require!(circle.status == CircleStatus::Active, "Circle is not active");
        require!(circle.members.contains(&caller), "Caller is not an active member");
        require!(attached == circle.amount_per_round, "Attached deposit must exactly equal amount per round");

        let current_round = circle.current_round;
        let payments = circle.round_payments.entry(current_round).or_default();
        require!(!payments.contains(&caller), "Caller has already paid dues for this round");

        payments.push(caller.clone());

        // Update member profile reputation
        let profile = self.profiles.entry(caller.clone()).or_default();
        if now_sec <= circle.round_deadline {
            profile.on_time_rounds += 1;
        } else {
            profile.late_rounds += 1;
        }

        env::log_str(&format!(
            "Member {} deposited for round {} in circle {}. Total paid for round: {}/{}",
            caller, current_round, circle_id, payments.len(), circle.members.len()
        ));
    }

    /// Step 1 of Two-Member Payout Rule:
    /// Any circle member requests the release of the pot once all active members have contributed.
    pub fn request_payout(&mut self, circle_id: u64) {
        let caller = env::predecessor_account_id();
        let circle = self.circles.get_mut(&circle_id).expect("Circle not found");

        require!(circle.status == CircleStatus::Active, "Circle is not active");
        require!(circle.members.contains(&caller), "Caller is not a circle member");

        let current_round = circle.current_round;
        let payments = circle.round_payments.get(&current_round).cloned().unwrap_or_default();
        require!(
            payments.len() == circle.members.len(),
            "Cannot request payout: round is not fully paid by all active members"
        );
        require!(
            circle.payout_request.is_none(),
            "Payout request already pending confirmation"
        );

        let now_sec = env::block_timestamp() / 1_000_000_000;
        circle.payout_request = Some(PayoutRequest {
            requester: caller.clone(),
            round: current_round,
            created_at: now_sec,
        });

        env::log_str(&format!(
            "Payout release requested by member {} for circle {} round {}",
            caller, circle_id, current_round
        ));
    }

    /// Step 2 of Two-Member Payout Rule:
    /// A DIFFERENT circle member must confirm the release.
    /// The contract autonomously transfers the pot directly to the scheduled slot recipient.
    /// NO ONE (neither requester, confirmer, nor organizer) can alter the recipient or amount!
    pub fn confirm_payout(&mut self, circle_id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let circle = self.circles.get_mut(&circle_id).expect("Circle not found");

        require!(circle.status == CircleStatus::Active, "Circle is not active");
        require!(circle.members.contains(&caller), "Caller is not a circle member");

        let req = circle.payout_request.clone().expect("No payout request pending confirmation");
        require!(
            req.requester != caller,
            "Two-Member Rule: Confirmer must be a DIFFERENT member than requester"
        );

        let current_round = circle.current_round;
        require!(req.round == current_round, "Payout request round mismatch");

        let payments = circle.round_payments.get(&current_round).cloned().unwrap_or_default();
        require!(
            payments.len() == circle.members.len(),
            "Cannot confirm payout: round is not fully funded"
        );

        // Calculate full pot: amount_per_round * number of active members.
        let pot_yocto = circle.amount_per_round.as_yoctonear()
            .checked_mul(circle.members.len() as u128)
            .expect("Payout amount overflow");

        // Recipient is strictly fixed by the schedule slot!
        let recipient = circle.slots[current_round as usize]
            .clone()
            .expect("Scheduled recipient not found for current slot");

        if let Some(token_bytes) = env::storage_read(&circle_token_key(circle_id)) {
            require!(env::storage_read(&payout_pending_key(circle_id)).is_none(), "Token payout is already pending");
            let token_id: AccountId = String::from_utf8(token_bytes)
                .expect("Configured token id is valid UTF-8")
                .parse()
                .expect("Configured token id is valid");
            let pending = PendingTokenPayout { round: current_round, recipient: recipient.clone(), amount: U128(pot_yocto) };
            env::storage_write(
                &payout_pending_key(circle_id),
                &near_sdk::serde_json::to_vec(&pending).expect("Pending payout serializes"),
            );
            let contract_id = env::current_account_id();
            return ext_fungible_token::ext(token_id)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(near_sdk::Gas::from_tgas(20))
                .ft_transfer(recipient.clone(), U128(pot_yocto), Some(format!("Ajocircle circle {circle_id} round {current_round} payout")))
                .then(ext_self::ext(contract_id)
                    .with_static_gas(near_sdk::Gas::from_tgas(25))
                    .on_token_payout(circle_id, current_round, recipient, U128(pot_yocto)));
        }

        // Clear payout request
        circle.payout_request = None;
        circle.collected_members.push(recipient.clone());

        // Check if all rounds are now completed
        let total_slots = circle.slots.len() as u32;
        let is_last_round = (current_round + 1) >= total_slots;

        if is_last_round {
            circle.status = CircleStatus::Ended;
            // Record completed cycles for all active members
            for m in &circle.members {
                let profile = self.profiles.entry(m.clone()).or_default();
                profile.completed_cycles += 1;
            }
            env::log_str(&format!("Circle {} has completed all rounds and is now ENDED!", circle_id));
        } else {
            // Advance to next round
            circle.current_round += 1;
            let now_sec = env::block_timestamp() / 1_000_000_000;
            circle.round_start_time = now_sec;
            circle.round_deadline = now_sec + circle.interval_seconds;
            env::log_str(&format!(
                "Circle {} advanced to round {}. Deadline set.",
                circle_id, circle.current_round
            ));
        }

        env::log_str(&format!(
            "AUTONOMOUS PAYOUT: Disbursing pot of {} yoctoNEAR to scheduled recipient {}",
            pot_yocto, recipient
        ));

        // Transfer funds directly to the scheduled recipient
        Promise::new(recipient).transfer(NearToken::from_yoctonear(pot_yocto))
    }

    #[private]
    pub fn on_token_payout(&mut self, circle_id: u64, round: u32, recipient: AccountId, amount: U128) -> bool {
        let Some(bytes) = env::storage_read(&payout_pending_key(circle_id)) else { return false; };
        let Ok(pending) = near_sdk::serde_json::from_slice::<PendingTokenPayout>(&bytes) else { return false; };
        if pending.round != round || pending.recipient != recipient || pending.amount != amount {
            env::log_str("Ignored mismatched NEP-141 payout callback");
            return false;
        }
        env::storage_remove(&payout_pending_key(circle_id));
        if env::promise_results_count() != 1 || env::promise_result_checked(0, 1024).is_err() {
            env::log_str(&format!("NEP-141 payout failed for circle {circle_id} round {round}; approval remains retryable"));
            return false;
        }

        let circle = self.circles.get_mut(&circle_id).expect("Circle not found");
        require!(circle.status == CircleStatus::Active, "Circle is not active");
        require!(circle.current_round == round, "Payout callback round is stale");
        require!(circle.payout_request.as_ref().is_some_and(|request| request.round == round), "Payout request no longer matches callback");
        require!(circle.round_payments.get(&round).is_some_and(|paid| paid.len() == circle.members.len()), "Round is no longer fully funded");
        circle.payout_request = None;
        circle.collected_members.push(recipient);
        if round + 1 >= circle.slots.len() as u32 {
            circle.status = CircleStatus::Ended;
            for member in &circle.members {
                self.profiles.entry(member.clone()).or_default().completed_cycles += 1;
            }
        } else {
            circle.current_round += 1;
            let now_sec = env::block_timestamp() / 1_000_000_000;
            circle.round_start_time = now_sec;
            circle.round_deadline = now_sec + circle.interval_seconds;
        }
        env::log_str(&format!("NEP-141 payout succeeded for circle {circle_id} round {round}"));
        true
    }

    /// Propose removing a member who defaulted (passed round deadline + grace period without paying).
    #[payable]
    pub fn propose_removal(&mut self, circle_id: u64, member_to_remove: AccountId) -> Promise {
        let caller = env::predecessor_account_id();
        let now_sec = env::block_timestamp() / 1_000_000_000;
        let circle = self.circles.get(&circle_id).expect("Circle not found");

        require!(circle.status == CircleStatus::Active, "Circle is not active");
        require!(circle.members.contains(&caller), "Caller is not an active member");
        require!(circle.members.contains(&member_to_remove), "Target is not an active member");
        require!(caller != member_to_remove, "Cannot propose removal of oneself");

        let current_round = circle.current_round;
        let payments = circle.round_payments.get(&current_round).cloned().unwrap_or_default();
        require!(
            !payments.contains(&member_to_remove),
            "Target member has already paid for current round"
        );
        require!(
            now_sec > (circle.round_deadline + circle.grace_period_seconds),
            "Grace period has not elapsed yet"
        );

        require!(env::attached_deposit().as_yoctonear() == SPUTNIK_PROPOSAL_BOND, "Attach the 1 NEAR Sputnik proposal bond");
        require!(env::storage_read(&dao_bond_reserve_key(circle_id)).as_deref() == Some(b"1"), "Circle DAO proposal reserve is not funded");
        require!(read_removal_sync(circle_id).is_none(), "A previous removal is still awaiting DAO synchronization or bond claim");
        let dao_id = self.get_circle_dao(circle_id).expect("Circle DAO has not been created");
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "circle_id": circle_id,
            "member": member_to_remove
        })).expect("Removal arguments serialize");
        let proposal = near_sdk::serde_json::json!({
            "description": format!("Remove defaulting member from circle {}", circle_id),
            "kind": { "FunctionCall": {
                "receiver_id": env::current_account_id(),
                "actions": [{
                    "method_name": "apply_removal",
                    "args": near_sdk::base64::engine::general_purpose::STANDARD.encode(args),
                    "deposit": "0",
                    "gas": SPUTNIK_PROPOSAL_GAS.to_string()
                }]
            }}
        });
        use near_sdk::base64::Engine as _;
        let sync = RemovalSyncView {
            member: member_to_remove.clone(),
            proposer: caller,
            removal_proposal_id: None,
            role_removal_proposal_id: None,
            stage: RemovalSyncStage::SubmittingRemoval,
        };
        write_removal_sync(circle_id, &sync);
        let contract_id = env::current_account_id();
        ext_sputnik_dao::ext(dao_id)
            .with_attached_deposit(env::attached_deposit())
            .with_static_gas(near_sdk::Gas::from_tgas(120))
            .add_proposal(proposal)
            .then(ext_self::ext(contract_id)
                .with_static_gas(near_sdk::Gas::from_tgas(20))
                .on_removal_proposal_submitted(circle_id, member_to_remove))
    }

    /// Called only by the circle's DAO after its members approve the removal.
    pub fn apply_removal(&mut self, circle_id: u64, member: AccountId) -> Promise {
        let caller = env::predecessor_account_id();
        let dao_id = self.get_circle_dao(circle_id).expect("Circle DAO has not been created");
        require!(caller == dao_id, "Only this circle's DAO can apply removal");
        require!(env::storage_read(&dao_bond_reserve_key(circle_id)).as_deref() == Some(b"1"), "Circle DAO proposal reserve is not funded");
        let mut sync = read_removal_sync(circle_id).expect("No pending removal to synchronize");
        require!(sync.member == member, "Removal does not match the pending proposal");
        require!(sync.stage == RemovalSyncStage::RemovalVoting, "Removal proposal is not ready to execute");
        let circle = self.circles.get_mut(&circle_id).expect("Circle not found");
        require!(circle.status == CircleStatus::Active, "Circle is not active");
        require!(circle.members.contains(&member), "Target is not an active member");
        let payments = circle.round_payments.get(&circle.current_round).cloned().unwrap_or_default();
        require!(!payments.contains(&member), "Target member has paid for current round");
        let now_sec = env::block_timestamp() / 1_000_000_000;
        require!(now_sec > circle.round_deadline + circle.grace_period_seconds, "Grace period has not elapsed yet");

        circle.members.retain(|existing| existing != &member);
        circle.removed_members.push(member.clone());
        let profile = self.profiles.entry(member.clone()).or_default();
        profile.defaults += 1;
        env::log_str(&format!("DAO {} removed defaulting member {} from circle {}", dao_id, member, circle_id));

        let role_proposal = near_sdk::serde_json::json!({
            "description": format!("Remove defaulting member from circle {} DAO roster", circle_id),
            "kind": { "RemoveMemberFromRole": { "member_id": member, "role": "members" } }
        });
        sync.stage = RemovalSyncStage::SubmittingRoleRemoval;
        write_removal_sync(circle_id, &sync);
        let contract_id = env::current_account_id();
        ext_sputnik_dao::ext(dao_id)
            .with_attached_deposit(NearToken::from_yoctonear(SPUTNIK_PROPOSAL_BOND))
            .with_static_gas(near_sdk::Gas::from_tgas(45))
            .add_proposal(role_proposal)
            .then(ext_self::ext(contract_id)
                .with_static_gas(near_sdk::Gas::from_tgas(20))
                .on_role_removal_proposal_submitted(circle_id, member))
    }

    #[private]
    pub fn on_removal_proposal_submitted(&mut self, circle_id: u64, member: AccountId) -> bool {
        let Some(mut sync) = read_removal_sync(circle_id) else { return false; };
        require!(sync.member == member, "Removal proposal callback does not match pending member");
        if let Ok(bytes) = env::promise_result_checked(0, 1024) {
            if let Ok(proposal_id) = near_sdk::serde_json::from_slice::<u64>(&bytes) {
                sync.removal_proposal_id = Some(proposal_id);
                sync.stage = RemovalSyncStage::RemovalVoting;
                write_removal_sync(circle_id, &sync);
                return true;
            }
        }
        env::log_str(&format!("Failed to add DAO removal proposal for circle {}", circle_id));
        false
    }

    #[private]
    pub fn on_role_removal_proposal_submitted(&mut self, circle_id: u64, member: AccountId) -> bool {
        let Some(mut sync) = read_removal_sync(circle_id) else { return false; };
        require!(sync.member == member, "DAO role-removal callback does not match pending member");
        if let Ok(bytes) = env::promise_result_checked(0, 1024) {
            if let Ok(proposal_id) = near_sdk::serde_json::from_slice::<u64>(&bytes) {
                sync.role_removal_proposal_id = Some(proposal_id);
                sync.stage = RemovalSyncStage::RoleRemovalVoting;
                write_removal_sync(circle_id, &sync);
                return true;
            }
        }
        env::log_str(&format!("Failed to add DAO roster cleanup proposal for circle {}", circle_id));
        false
    }

    /// Return the pending/finished DAO membership synchronization state for a removal.
    pub fn get_removal_sync(&self, circle_id: u64) -> Option<RemovalSyncView> {
        read_removal_sync(circle_id)
    }

    /// Verify the DAO role was updated after members approve its cleanup proposal.
    pub fn confirm_removal_dao_sync(&self, circle_id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let circle = self.circles.get(&circle_id).expect("Circle not found");
        require!(circle.members.contains(&caller), "Only an active circle member can confirm DAO synchronization");
        let sync = read_removal_sync(circle_id).expect("No removal synchronization to confirm");
        require!(sync.stage == RemovalSyncStage::RoleRemovalVoting, "DAO roster proposal is not awaiting approval");
        let dao_id = self.get_circle_dao(circle_id).expect("Circle DAO has not been created");
        let contract_id = env::current_account_id();
        ext_sputnik_dao::ext(dao_id)
            .with_static_gas(near_sdk::Gas::from_tgas(20))
            .get_policy()
            .then(ext_self::ext(contract_id)
                .with_static_gas(near_sdk::Gas::from_tgas(20))
                .on_removal_dao_policy_checked(circle_id, sync.member))
    }

    #[private]
    pub fn on_removal_dao_policy_checked(&mut self, circle_id: u64, member: AccountId) -> bool {
        let Some(mut sync) = read_removal_sync(circle_id) else { return false; };
        require!(sync.member == member, "DAO sync verification does not match pending member");
        let Ok(bytes) = env::promise_result_checked(0, 128 * 1024) else { return false; };
        let Ok(policy) = near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&bytes) else { return false; };
        let roles = policy.get("roles").and_then(|value| value.as_array());
        let removed_from_members = roles.is_some_and(|roles| roles.iter().any(|role| {
            role.get("name").and_then(|value| value.as_str()) == Some("members") &&
            role.get("kind").and_then(|value| value.get("Group")).and_then(|value| value.as_array())
                .is_some_and(|group| !group.iter().any(|entry| entry.as_str() == Some(member.as_str())))
        }));
        if !removed_from_members {
            env::log_str(&format!("DAO roster still contains removed member {} for circle {}", member, circle_id));
            return false;
        }
        sync.stage = RemovalSyncStage::Synced;
        write_removal_sync(circle_id, &sync);
        env::log_str(&format!("Verified DAO roster sync for removed member {} in circle {}", member, circle_id));
        true
    }

    /// Refund the original member's proposal bond once DAO roster synchronization is verified.
    pub fn claim_removal_bond(&mut self, circle_id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let sync = read_removal_sync(circle_id).expect("No pending removal bond");
        require!(sync.proposer == caller, "Only the removal proposer can claim the bond refund");
        require!(sync.stage == RemovalSyncStage::Synced, "DAO roster synchronization is not complete");
        env::storage_remove(&removal_sync_key(circle_id));
        Promise::new(caller).transfer(NearToken::from_yoctonear(SPUTNIK_PROPOSAL_BOND))
    }

    /// Vote on an open proposal. Strict majority executes proposal immediately.
    pub fn vote_proposal(&mut self, circle_id: u64, proposal_id: u64, approve: bool) -> bool {
        let caller = env::predecessor_account_id();
        let circle = self.circles.get_mut(&circle_id).expect("Circle not found");

        require!(circle.members.contains(&caller), "Caller is not an active member");
        let prop = circle.proposals.get_mut(proposal_id as usize).expect("Proposal not found");
        require!(!prop.executed, "Proposal already executed");
        require!(!prop.votes.contains_key(&caller), "Caller has already voted on this proposal");

        prop.votes.insert(caller.clone(), approve);

        let approvals_count = prop.votes.values().filter(|&&v| v).count();
        let threshold = (circle.members.len() / 2) + 1;

        if approvals_count >= threshold {
            prop.passed = true;
            prop.executed = true;

            match &prop.proposal_type {
                ProposalType::RemoveMember { member, had_collected } => {
                    let member_clone = member.clone();
                    let had_coll = *had_collected;

                    // Remove from active members
                    circle.members.retain(|m| m != &member_clone);
                    circle.removed_members.push(member_clone.clone());

                    // Record default on profile
                    let profile = self.profiles.entry(member_clone.clone()).or_default();
                    profile.defaults += 1;

                    env::log_str(&format!(
                        "Proposal PASSED: Member {} removed from circle {}. Recorded default.",
                        member_clone, circle_id
                    ));

                    // If they had collected, spawn ContinueCircle proposal for group
                    if had_coll {
                        let continue_prop_id = circle.proposals.len() as u64;
                        circle.proposals.push(Proposal {
                            id: continue_prop_id,
                            proposer: caller,
                            proposal_type: ProposalType::ContinueCircle,
                            votes: HashMap::new(),
                            passed: false,
                            executed: false,
                        });
                        env::log_str(&format!(
                            "Spawned ContinueCircle proposal {} for circle {}",
                            continue_prop_id, circle_id
                        ));
                    }
                }
                ProposalType::ContinueCircle => {
                    env::log_str(&format!("Proposal PASSED: Circle {} will continue with remaining members", circle_id));
                }
            }
            return true;
        }

        false
    }

    // --- VIEW METHODS ---

    pub fn get_circle(&self, circle_id: u64) -> Option<Circle> {
        self.circles.get(&circle_id).cloned()
    }

    pub fn get_circles(&self) -> Vec<Circle> {
        self.circle_ids.iter().filter_map(|id| self.circles.get(id).cloned()).collect()
    }

    pub fn get_round_status(&self, circle_id: u64) -> Option<RoundStatusView> {
        let circle = self.circles.get(&circle_id)?;
        let current_round = circle.current_round;
        let total_rounds = circle.slots.len() as u32;

        let scheduled_recipient = if (current_round as usize) < circle.slots.len() {
            circle.slots[current_round as usize].clone()
        } else {
            None
        };

        let paid_members = circle.round_payments.get(&current_round).cloned().unwrap_or_default();
        let missing_members: Vec<AccountId> = circle
            .members
            .iter()
            .filter(|m| !paid_members.contains(m))
            .cloned()
            .collect();

        let is_round_fully_paid = !circle.members.is_empty() && paid_members.len() == circle.members.len();
        let payout_pending = env::storage_read(&payout_pending_key(circle_id)).is_some();
        let payout_not_requested = circle.payout_request.is_none() && !payout_pending;
        let now_sec = env::block_timestamp() / 1_000_000_000;
        let is_round_late = now_sec > circle.round_deadline && !is_round_fully_paid;

        let pot_yocto = circle.amount_per_round.as_yoctonear() * (circle.members.len() as u128);

        Some(RoundStatusView {
            circle_id,
            current_round,
            total_rounds,
            scheduled_recipient,
            amount_per_member: circle.amount_per_round,
            pot_amount: NearToken::from_yoctonear(pot_yocto),
            round_start_time: circle.round_start_time,
            round_deadline: circle.round_deadline,
            grace_period_seconds: circle.grace_period_seconds,
            paid_members,
            missing_members,
            is_round_fully_paid,
            is_round_late,
            payout_ready: is_round_fully_paid && circle.status == CircleStatus::Active && payout_not_requested,
            payout_request: circle.payout_request.clone(),
        })
    }

    pub fn get_profile(&self, account_id: AccountId) -> MemberProfile {
        self.profiles.get(&account_id).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, testing_env_with_promise_results, VMContextBuilder};
    use near_sdk::testing_env;

    fn get_context(predecessor: AccountId, attached: NearToken) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(accounts(0))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .attached_deposit(attached)
            .block_timestamp(1_000_000_000_000_000_000); // 1 sec in ns
        builder
    }

    #[test]
    fn test_full_cycle_and_two_member_payout() {
        let alice = accounts(1);
        let bob = accounts(2);
        let context = get_context(alice.clone(), NearToken::from_near(0));
        testing_env!(context.build());

        let mut contract = CircleContract::new();
        let circle_id = contract.create_circle(
            "Family Wealth Circle".to_string(),
            NearToken::from_near(1),
            3600,
            600,
            2,
        );

        // Alice joins slot 0
        contract.join(circle_id, 0);

        // Bob joins slot 1
        testing_env!(get_context(bob.clone(), NearToken::from_near(0)).build());
        contract.join(circle_id, 1);

        // Circle should now be Active
        let circle = contract.get_circle(circle_id).unwrap();
        assert_eq!(circle.status, CircleStatus::Active);
        assert_eq!(circle.current_round, 0);

        // Alice pays dues for Round 0
        testing_env!(get_context(alice.clone(), NearToken::from_near(1)).build());
        contract.deposit(circle_id);

        // Bob pays dues for Round 0
        testing_env!(get_context(bob.clone(), NearToken::from_near(1)).build());
        contract.deposit(circle_id);

        let round_status = contract.get_round_status(circle_id).unwrap();
        assert!(round_status.is_round_fully_paid);
        assert_eq!(round_status.paid_members.len(), 2);

        // Step 1: Alice requests payout
        testing_env!(get_context(alice.clone(), NearToken::from_near(0)).build());
        contract.request_payout(circle_id);

        // Step 2: Bob confirms payout (different member)
        testing_env!(get_context(bob.clone(), NearToken::from_near(0)).build());
        let _ = contract.confirm_payout(circle_id);

        // Round should advance to 1
        let updated = contract.get_circle(circle_id).unwrap();
        assert_eq!(updated.current_round, 1);
        assert_eq!(updated.collected_members, vec![alice.clone()]);
    }

    #[test]
    fn nep141_contributions_accept_exact_member_payment_and_reject_duplicates() {
        let alice = accounts(1);
        let bob = accounts(2);
        let token = accounts(5);
        testing_env!(get_context(alice.clone(), NearToken::from_near(0)).build());
        let mut contract = CircleContract::new();
        let circle_id = contract.create_token_circle(
            "Token Circle".to_string(),
            NearToken::from_yoctonear(100),
            3600,
            600,
            2,
            token.clone(),
        );
        assert_eq!(contract.get_circle_token(circle_id), Some(token.clone()));
        contract.join(circle_id, 0);
        testing_env!(get_context(bob.clone(), NearToken::from_near(0)).build());
        contract.join(circle_id, 1);

        testing_env!(get_context(token.clone(), NearToken::from_near(0)).build());
        assert!(matches!(contract.ft_on_transfer(alice.clone(), U128(100), circle_id.to_string()), PromiseOrValue::Value(U128(0))));
        assert!(matches!(contract.ft_on_transfer(alice.clone(), U128(100), circle_id.to_string()), PromiseOrValue::Value(U128(100))));
        assert!(matches!(contract.ft_on_transfer(bob.clone(), U128(99), circle_id.to_string()), PromiseOrValue::Value(U128(99))));

        let status = contract.get_round_status(circle_id).unwrap();
        assert_eq!(status.paid_members, vec![alice]);
        assert!(!status.is_round_fully_paid);
        assert_eq!(contract.get_profile(accounts(1)).on_time_rounds, 1);
    }

    #[test]
    fn nep141_contribution_rejects_unconfigured_token() {
        let alice = accounts(1);
        let bob = accounts(2);
        let token = accounts(5);
        testing_env!(get_context(alice.clone(), NearToken::from_near(0)).build());
        let mut contract = CircleContract::new();
        let circle_id = contract.create_token_circle(
            "Token Circle".to_string(),
            NearToken::from_yoctonear(100),
            3600,
            600,
            2,
            token,
        );
        contract.join(circle_id, 0);
        testing_env!(get_context(bob.clone(), NearToken::from_near(0)).build());
        contract.join(circle_id, 1);

        testing_env!(get_context(accounts(3), NearToken::from_near(0)).build());
        assert!(matches!(contract.ft_on_transfer(alice, U128(100), circle_id.to_string()), PromiseOrValue::Value(U128(100))));
        assert!(contract.get_round_status(circle_id).unwrap().paid_members.is_empty());
    }

    #[test]
    fn nep141_payout_advances_only_after_successful_token_transfer() {
        let alice = accounts(1);
        let bob = accounts(2);
        let token = accounts(5);
        testing_env!(get_context(alice.clone(), NearToken::from_near(0)).build());
        let mut contract = CircleContract::new();
        let circle_id = contract.create_token_circle(
            "Token payout circle".to_string(),
            NearToken::from_yoctonear(100),
            3600,
            600,
            2,
            token.clone(),
        );
        contract.join(circle_id, 0);
        testing_env!(get_context(bob.clone(), NearToken::from_near(0)).build());
        contract.join(circle_id, 1);
        testing_env!(get_context(token, NearToken::from_near(0)).build());
        contract.ft_on_transfer(alice.clone(), U128(100), circle_id.to_string());
        contract.ft_on_transfer(bob.clone(), U128(100), circle_id.to_string());
        testing_env!(get_context(alice.clone(), NearToken::from_near(0)).build());
        contract.request_payout(circle_id);
        testing_env!(get_context(bob.clone(), NearToken::from_near(0)).build());
        let _payout_promise = contract.confirm_payout(circle_id);
        let circle = contract.get_circle(circle_id).unwrap();
        assert_eq!(circle.current_round, 0);
        assert!(circle.payout_request.is_some());
        assert!(env::storage_read(&payout_pending_key(circle_id)).is_some());

        testing_env_with_promise_results(
            get_context(accounts(0), NearToken::from_near(0)).build(),
            near_sdk::PromiseResult::Failed,
        );
        assert!(!contract.on_token_payout(circle_id, 0, alice.clone(), U128(200)));
        assert_eq!(contract.get_circle(circle_id).unwrap().current_round, 0);
        assert!(contract.get_circle(circle_id).unwrap().payout_request.is_some());

        testing_env!(get_context(bob, NearToken::from_near(0)).build());
        let _retry_promise = contract.confirm_payout(circle_id);
        testing_env_with_promise_results(
            get_context(accounts(0), NearToken::from_near(0)).build(),
            near_sdk::PromiseResult::Successful(Vec::new()),
        );
        assert!(contract.on_token_payout(circle_id, 0, alice.clone(), U128(200)));
        let circle = contract.get_circle(circle_id).unwrap();
        assert_eq!(circle.current_round, 1);
        assert_eq!(circle.collected_members, vec![alice]);
        assert!(circle.payout_request.is_none());
    }

    #[test]
    #[should_panic(expected = "Two-Member Rule: Confirmer must be a DIFFERENT member than requester")]
    fn test_same_member_cannot_confirm_payout() {
        let alice = accounts(1);
        let bob = accounts(2);
        testing_env!(get_context(alice.clone(), NearToken::from_near(0)).build());

        let mut contract = CircleContract::new();
        let circle_id = contract.create_circle(
            "Test Circle".to_string(),
            NearToken::from_near(1),
            3600,
            600,
            2,
        );

        contract.join(circle_id, 0);
        testing_env!(get_context(bob.clone(), NearToken::from_near(0)).build());
        contract.join(circle_id, 1);

        testing_env!(get_context(alice.clone(), NearToken::from_near(1)).build());
        contract.deposit(circle_id);

        testing_env!(get_context(bob.clone(), NearToken::from_near(1)).build());
        contract.deposit(circle_id);

        // Alice requests
        testing_env!(get_context(alice.clone(), NearToken::from_near(0)).build());
        contract.request_payout(circle_id);

        // Alice tries to confirm herself -> must panic!
        let _ = contract.confirm_payout(circle_id);
    }

    #[test]
    fn dao_can_apply_removal_after_grace_period() {
        let alice = accounts(1);
        let bob = accounts(2);
        let dao = accounts(4);
        testing_env!(get_context(alice.clone(), NearToken::from_near(0)).build());
        let mut contract = CircleContract::new();
        let circle_id = contract.create_circle(
            "DAO removal test".to_string(),
            NearToken::from_near(1),
            60,
            600,
            2,
        );
        contract.join(circle_id, 0);
        testing_env!(get_context(bob.clone(), NearToken::from_near(0)).build());
        contract.join(circle_id, 1);
        env::storage_write(&dao_storage_key(circle_id), dao.as_bytes());
        env::storage_write(&dao_bond_reserve_key(circle_id), b"1");
        write_removal_sync(circle_id, &RemovalSyncView {
            member: bob.clone(),
            proposer: alice.clone(),
            removal_proposal_id: Some(0),
            role_removal_proposal_id: None,
            stage: RemovalSyncStage::RemovalVoting,
        });

        let mut late_context = get_context(dao.clone(), NearToken::from_near(0));
        late_context.block_timestamp(1_000_000_661_000_000_000);
        testing_env!(late_context.build());
        let _promise = contract.apply_removal(circle_id, bob.clone());
        let circle = contract.get_circle(circle_id).unwrap();
        assert!(!circle.members.contains(&bob));
        assert!(circle.removed_members.contains(&bob));
        assert_eq!(contract.get_profile(bob).defaults, 1);
    }

    #[test]
    #[should_panic(expected = "Only this circle's DAO can apply removal")]
    fn non_dao_cannot_apply_removal() {
        let alice = accounts(1);
        let bob = accounts(2);
        let dao = accounts(4);
        testing_env!(get_context(alice.clone(), NearToken::from_near(0)).build());
        let mut contract = CircleContract::new();
        let circle_id = contract.create_circle(
            "DAO access test".to_string(),
            NearToken::from_near(1),
            60,
            600,
            2,
        );
        contract.join(circle_id, 0);
        testing_env!(get_context(bob.clone(), NearToken::from_near(0)).build());
        contract.join(circle_id, 1);
        env::storage_write(&dao_storage_key(circle_id), dao.as_bytes());

        let mut late_context = get_context(alice, NearToken::from_near(0));
        late_context.block_timestamp(1_000_000_661_000_000_000);
        testing_env!(late_context.build());
        contract.apply_removal(circle_id, bob);
    }
}
