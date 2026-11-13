use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, PromiseOrValue, require};

const FAUCET_LIMIT: u128 = 10_000_000_000; // 10,000 tokens at six decimals.

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestStablecoin {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    owner_id: AccountId,
}

#[near]
impl TestStablecoin {
    #[init]
    pub fn new(owner_id: AccountId, initial_supply: U128) -> Self {
        require!(!env::state_exists(), "Already initialized");
        let mut token = FungibleToken::new(b"a");
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, initial_supply.0);
        Self {
            token,
            metadata: FungibleTokenMetadata {
                spec: FT_METADATA_SPEC.to_string(),
                name: "Ajocircle Test Dollar".to_string(),
                symbol: "AJUSD".to_string(),
                icon: None,
                reference: None,
                reference_hash: None,
                decimals: 6,
            },
            owner_id,
        }
    }

    /// Gives the caller test tokens from the faucet's funded reserve.
    pub fn faucet(&mut self, amount: U128) {
        require!(amount.0 > 0 && amount.0 <= FAUCET_LIMIT, "Faucet limit is 10,000 AJUSD per request");
        let caller = env::predecessor_account_id();
        require!(self.token.accounts.get(&caller).is_some(), "Register with storage_deposit before using faucet");
        self.token.internal_transfer(&self.owner_id, &caller, amount.0, Some("Ajocircle test token faucet".to_string()));
    }
}

#[near]
impl FungibleTokenCore for TestStablecoin {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for TestStablecoin {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.token.ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for TestStablecoin {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, _)) = self.token.internal_storage_unregister(force) {
            env::log_str(&format!("Unregistered token account {account_id}"));
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for TestStablecoin {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    #[test]
    fn registered_account_can_receive_faucet_tokens() {
        let owner = accounts(1);
        let member = accounts(2);
        let mut context = VMContextBuilder::new();
        context
            .current_account_id(accounts(0))
            .signer_account_id(owner.clone())
            .predecessor_account_id(owner.clone())
            .attached_deposit(NearToken::from_near(1));
        testing_env!(context.build());
        let mut token = TestStablecoin::new(owner.clone(), U128(1_000_000_000_000));

        token.storage_deposit(Some(member.clone()), Some(false));
        context.predecessor_account_id(member.clone());
        context.signer_account_id(member.clone());
        context.attached_deposit(NearToken::from_near(0));
        testing_env!(context.build());
        token.faucet(U128(50_000_000));

        assert_eq!(token.ft_balance_of(member), U128(50_000_000));
    }
}
