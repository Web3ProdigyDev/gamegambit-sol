use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("E2Vd3U91kMrgwp8JCXcLSn7bt3NowDmGwoBYsVRhGfMR");

// ── Constants ────────────────────────────────────────────────────────────────

// Tiered platform fee (applied to total pot = stake × 2)
// Micro  : < 0.5 SOL  → 10%
// Mid    : 0.5–5 SOL  →  7%
// Whale  : > 5 SOL    →  5%
const MICRO_THRESHOLD_LAMPORTS: u64 = 500_000_000;   // 0.5 SOL
const WHALE_THRESHOLD_LAMPORTS: u64 = 5_000_000_000; // 5.0 SOL

const MICRO_FEE_BPS: u64 = 1000; // 10%
const MID_FEE_BPS: u64   =  700; //  7%
const WHALE_FEE_BPS: u64 =  500; //  5%

const AUTHORITY_PUBKEY: Pubkey = pubkey!("Ec7XfHbeDw1YmHzcGo3WrK73QnqQ3GL9VBczYGPCQJha");
const PLATFORM_WALLET_PUBKEY: Pubkey = pubkey!("3hwPwugeuZ33HWJ3SoJkDN2JT3Be9fH62r19ezFiCgYY");

const WAGER_JOIN_EXPIRY_SECONDS: i64 = 7 * 24 * 60 * 60;

// ── Account space ────────────────────────────────────────────────────────────

// PlayerProfile: 8 (disc) + 32 + 1 + 8 + 8 + 1 = 58 bytes used; 128 allocated.
const PLAYER_PROFILE_SPACE: usize = 128;

// WagerAccount: 8 (disc) + 1 + 32 + 32 + 8 + 8 + 1 + 33 + 8 + 8 + 8
//             = 147 bytes used; 160 allocated.
// Removed (all duplicated in Supabase DB):
//   lichess_game_id (24), requires_moderator (1), vote_player_a (33),
//   vote_player_b (33), vote_timestamp (8), retract_deadline (8) = 107 bytes freed
const WAGER_ACCOUNT_SPACE: usize = 160;

// ── Fee helper ───────────────────────────────────────────────────────────────

/// Returns the platform fee in lamports for a given stake.
/// Tier is determined by stake_lamports (per-player stake, not the pot).
///
/// | Tier  | Stake            | Fee  |
/// |-------|------------------|------|
/// | Micro | < 0.5 SOL        | 10%  |
/// | Mid   | 0.5 SOL – 5 SOL  |  7%  |
/// | Whale | > 5 SOL          |  5%  |
fn calculate_platform_fee(stake_lamports: u64) -> Result<u64> {
    let fee_bps = if stake_lamports < MICRO_THRESHOLD_LAMPORTS {
        MICRO_FEE_BPS
    } else if stake_lamports <= WHALE_THRESHOLD_LAMPORTS {
        MID_FEE_BPS
    } else {
        WHALE_FEE_BPS
    };

    let total_pot = stake_lamports
        .checked_mul(2)
        .ok_or(ErrorCode::ArithmeticOverflow)?;

    total_pot
        .checked_mul(fee_bps)
        .ok_or(ErrorCode::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(ErrorCode::ArithmeticOverflow.into())
}

// ── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod gamegambit {
    use super::*;

    pub fn initialize_player(ctx: Context<InitializePlayer>) -> Result<()> {
        let player_profile = &mut ctx.accounts.player_profile;
        if player_profile.player == Pubkey::default() {
            player_profile.player = ctx.accounts.player.key();
            player_profile.is_banned = false;
            player_profile.ban_expires_at = 0;
            player_profile.bump = ctx.bumps.player_profile;
        }
        player_profile.last_active = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn ban_player(ctx: Context<BanPlayer>, ban_duration: i64) -> Result<()> {
        require!(
            ctx.accounts.authorizer.key() == AUTHORITY_PUBKEY,
            ErrorCode::Unauthorized
        );

        let player_profile = &mut ctx.accounts.player_profile;
        let now = Clock::get()?.unix_timestamp;

        if ban_duration == 0 {
            player_profile.is_banned = false;
            player_profile.ban_expires_at = 0;
        } else {
            player_profile.is_banned = true;
            player_profile.ban_expires_at = now + ban_duration;
        }

        emit!(PlayerBanned {
            player: player_profile.player,
            is_banned: player_profile.is_banned,
            ban_expires_at: player_profile.ban_expires_at,
        });

        Ok(())
    }

    pub fn create_wager(
        ctx: Context<CreateWager>,
        match_id: u64,
        stake_lamports: u64,
    ) -> Result<()> {
        msg!("Creating wager with match_id: {}", match_id);
        require!(stake_lamports > 0, ErrorCode::InvalidAmount);
        require!(match_id > 0, ErrorCode::InvalidMatchId);

        let now = Clock::get()?.unix_timestamp;
        require_not_banned(&ctx.accounts.player_a_profile, now)?;

        let wager_key = ctx.accounts.wager.key();
        let player_a_key = ctx.accounts.player_a.key();

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.player_a.to_account_info(),
                    to: ctx.accounts.wager.to_account_info(),
                },
            ),
            stake_lamports,
        )?;

        let wager = &mut ctx.accounts.wager;
        wager.bump = ctx.bumps.wager;
        wager.player_a = player_a_key;
        wager.player_b = Pubkey::default();
        wager.match_id = match_id;
        wager.stake_lamports = stake_lamports;
        wager.status = WagerStatus::Active;
        wager.winner = None;
        wager.created_at = now;
        wager.expires_at = now + WAGER_JOIN_EXPIRY_SECONDS;
        wager.resolved_at = 0;

        emit!(WagerCreated {
            wager_id: wager_key,
            player_a: wager.player_a,
            match_id,
            stake_lamports,
        });

        Ok(())
    }

    pub fn join_wager(ctx: Context<JoinWager>, stake_lamports: u64) -> Result<()> {
        let wager_key = ctx.accounts.wager.key();
        let wager_info = ctx.accounts.wager.to_account_info();
        let player_b_key = ctx.accounts.player_b.key();
        let now = Clock::get()?.unix_timestamp;

        let wager = &mut ctx.accounts.wager;
        msg!("Joining wager, current status: {:?}", wager.status);

        require!(
            wager.status == WagerStatus::Active,
            ErrorCode::InvalidStatus
        );
        require!(
            stake_lamports == wager.stake_lamports,
            ErrorCode::InvalidAmount
        );
        require_not_banned(&ctx.accounts.player_b_profile, now)?;
        require!(player_b_key != wager.player_a, ErrorCode::InvalidPlayer);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.player_b.to_account_info(),
                    to: wager_info,
                },
            ),
            stake_lamports,
        )?;

        wager.player_b = player_b_key;
        // Wager stays Active — no intermediate on-chain status in new model.

        emit!(WagerJoined {
            wager_id: wager_key,
            player_b: wager.player_b,
            stake_lamports,
        });

        Ok(())
    }

    pub fn resolve_wager(ctx: Context<ResolveWager>, winner: Pubkey) -> Result<()> {
        let wager_info = ctx.accounts.wager.to_account_info();
        let now = Clock::get()?.unix_timestamp;

        let wager = &mut ctx.accounts.wager;
        msg!("Resolving wager, current status: {:?}", wager.status);

        require!(
            ctx.accounts.authorizer.key() == AUTHORITY_PUBKEY,
            ErrorCode::Unauthorized
        );
        require!(
            wager.status == WagerStatus::Active,
            ErrorCode::InvalidStatus
        );
        require!(
            winner == wager.player_a || winner == wager.player_b,
            ErrorCode::InvalidWinner
        );
        require!(
            ctx.accounts.winner.key() == winner,
            ErrorCode::InvalidWinner
        );
        require!(
            ctx.accounts.platform_wallet.key() == PLATFORM_WALLET_PUBKEY,
            ErrorCode::InvalidPlatformWallet
        );

        let total_pot = wager.stake_lamports
            .checked_mul(2)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        // Tiered fee: 10% (<0.5 SOL) | 7% (0.5–5 SOL) | 5% (>5 SOL)
        let platform_fee = calculate_platform_fee(wager.stake_lamports)?;

        let winner_payout = total_pot
            .checked_sub(platform_fee)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        require!(
            wager_info.lamports() >= total_pot,
            ErrorCode::InsufficientFunds
        );

        let winner_info = ctx.accounts.winner.to_account_info();
        let platform_wallet_info = ctx.accounts.platform_wallet.to_account_info();

        **wager_info.try_borrow_mut_lamports()? -= total_pot;
        **winner_info.try_borrow_mut_lamports()? += winner_payout;
        **platform_wallet_info.try_borrow_mut_lamports()? += platform_fee;

        wager.winner = Some(winner);
        wager.status = WagerStatus::Settled;
        wager.resolved_at = now;

        emit!(WagerResolved {
            wager_id: wager.key(),
            winner,
            player_a: wager.player_a,
            player_b: wager.player_b,
            total_payout: winner_payout,
            platform_fee,
        });

        Ok(())
    }

    pub fn close_wager(ctx: Context<CloseWager>) -> Result<()> {
        require!(
            ctx.accounts.player_a.key() == ctx.accounts.wager.player_a,
            ErrorCode::InvalidPlayer
        );
        require!(
            ctx.accounts.wager.player_b == Pubkey::default()
                || ctx.accounts.player_b.key() == ctx.accounts.wager.player_b,
            ErrorCode::InvalidPlayer
        );

        let is_authority = ctx.accounts.authorizer.key() == AUTHORITY_PUBKEY;
        let is_player_a = ctx.accounts.authorizer.key() == ctx.accounts.wager.player_a;
        let is_player_b = ctx.accounts.authorizer.key() == ctx.accounts.wager.player_b;

        require!(
            is_authority || is_player_a || is_player_b,
            ErrorCode::Unauthorized
        );

        let wager_info = ctx.accounts.wager.to_account_info();

        // != (NOT equal) — "if NOT settled, refund stakes"
        if ctx.accounts.wager.status != WagerStatus::Settled {
            let stake = ctx.accounts.wager.stake_lamports;

            if ctx.accounts.wager.player_a != Pubkey::default() {
                require!(
                    wager_info.lamports() >= stake,
                    ErrorCode::InsufficientFunds
                );
                **wager_info.try_borrow_mut_lamports()? -= stake;
                **ctx
                    .accounts
                    .player_a
                    .to_account_info()
                    .try_borrow_mut_lamports()? += stake;
            }

            if ctx.accounts.wager.player_b != Pubkey::default() {
                require!(
                    wager_info.lamports() >= stake,
                    ErrorCode::InsufficientFunds
                );
                **wager_info.try_borrow_mut_lamports()? -= stake;
                **ctx
                    .accounts
                    .player_b
                    .to_account_info()
                    .try_borrow_mut_lamports()? += stake;
            }
        }

        emit!(WagerClosed {
            wager_id: wager_info.key(),
            closed_by: ctx.accounts.authorizer.key(),
        });

        Ok(())
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn require_not_banned(profile: &PlayerProfile, now: i64) -> Result<()> {
    let still_banned = profile.is_banned && profile.ban_expires_at > now;
    require!(!still_banned, ErrorCode::PlayerBanned);
    Ok(())
}

// ── Account contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePlayer<'info> {
    #[account(
        init_if_needed,
        payer = player,
        space = PLAYER_PROFILE_SPACE,
        seeds = [b"player", player.key().as_ref()],
        bump
    )]
    pub player_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BanPlayer<'info> {
    #[account(
        mut,
        seeds = [b"player", player_profile.player.as_ref()],
        bump = player_profile.bump
    )]
    pub player_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub authorizer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateWager<'info> {
    #[account(
        init,
        payer = player_a,
        space = WAGER_ACCOUNT_SPACE,
        seeds = [b"wager", player_a.key().as_ref(), match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub wager: Account<'info, WagerAccount>,
    #[account(
        seeds = [b"player", player_a.key().as_ref()],
        bump = player_a_profile.bump
    )]
    pub player_a_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub player_a: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinWager<'info> {
    #[account(
        mut,
        seeds = [b"wager", wager.player_a.as_ref(), wager.match_id.to_le_bytes().as_ref()],
        bump = wager.bump
    )]
    pub wager: Account<'info, WagerAccount>,
    #[account(
        seeds = [b"player", player_b.key().as_ref()],
        bump = player_b_profile.bump
    )]
    pub player_b_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub player_b: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveWager<'info> {
    #[account(
        mut,
        seeds = [b"wager", wager.player_a.as_ref(), wager.match_id.to_le_bytes().as_ref()],
        bump = wager.bump
    )]
    pub wager: Account<'info, WagerAccount>,
    /// CHECK: Validated against wager.player_a / wager.player_b and the winner argument.
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
    #[account(mut)]
    pub authorizer: Signer<'info>,
    /// CHECK: Validated against PLATFORM_WALLET_PUBKEY constant.
    #[account(
        mut,
        constraint = platform_wallet.key() == PLATFORM_WALLET_PUBKEY @ ErrorCode::InvalidPlatformWallet
    )]
    pub platform_wallet: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseWager<'info> {
    #[account(
        mut,
        seeds = [b"wager", wager.player_a.as_ref(), wager.match_id.to_le_bytes().as_ref()],
        bump = wager.bump,
        close = authorizer
    )]
    pub wager: Account<'info, WagerAccount>,
    /// CHECK: Validated in instruction to equal wager.player_a.
    #[account(mut)]
    pub player_a: UncheckedAccount<'info>,
    /// CHECK: Validated in instruction to equal wager.player_b (or default).
    #[account(mut)]
    pub player_b: UncheckedAccount<'info>,
    #[account(mut)]
    pub authorizer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ── Account structs ──────────────────────────────────────────────────────────

#[account]
pub struct PlayerProfile {
    pub player: Pubkey,
    pub is_banned: bool,
    pub ban_expires_at: i64,
    pub last_active: i64,
    pub bump: u8,
}

#[account]
pub struct WagerAccount {
    pub bump: u8,               // 1
    pub player_a: Pubkey,       // 32
    pub player_b: Pubkey,       // 32
    pub match_id: u64,          // 8
    pub stake_lamports: u64,    // 8
    pub status: WagerStatus,    // 1
    pub winner: Option<Pubkey>, // 33  (1 discriminant + 32)
    pub created_at: i64,        // 8
    pub expires_at: i64,        // 8   (kept — Supabase reads it off-chain)
    pub resolved_at: i64,       // 8
    // payload: 139 + 8 discriminator = 147; allocated 160
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum WagerStatus {
    Active,   // wager created, not yet resolved (covers old Created + Joined)
    Settled,  // wager resolved (was Resolved)
}

// ── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct WagerCreated {
    pub wager_id: Pubkey,
    pub player_a: Pubkey,
    pub match_id: u64,
    pub stake_lamports: u64,
}

#[event]
pub struct WagerJoined {
    pub wager_id: Pubkey,
    pub player_b: Pubkey,
    pub stake_lamports: u64,
}

#[event]
pub struct WagerResolved {
    pub wager_id: Pubkey,
    pub winner: Pubkey,
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub total_payout: u64,
    pub platform_fee: u64,
}

#[event]
pub struct WagerClosed {
    pub wager_id: Pubkey,
    pub closed_by: Pubkey,
}

#[event]
pub struct PlayerBanned {
    pub player: Pubkey,
    pub is_banned: bool,
    pub ban_expires_at: i64,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid wager status")]
    InvalidStatus,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid match ID")]
    InvalidMatchId,
    #[msg("Invalid winner")]
    InvalidWinner,
    #[msg("Invalid player")]
    InvalidPlayer,
    #[msg("Player is banned")]
    PlayerBanned,
    #[msg("Invalid platform wallet")]
    InvalidPlatformWallet,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Insufficient funds in wager account")]
    InsufficientFunds,
}