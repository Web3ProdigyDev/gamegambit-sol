use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("6r4TN44wRd6vjmZG5ffTRTo5JKC8Ajhuj95AENTymesq");

const MAX_LICHESS_GAME_ID_LENGTH: usize = 20;

#[program]
pub mod gamegambit {
    use super::*;

    // Minimal initialize player (just for ban check)
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

    // Create wager (creator stakes)
    pub fn create_wager(
        ctx: Context<CreateWager>,
        match_id: u64,
        stake_lamports: u64,
        lichess_game_id: String,
        requires_moderator: bool,
    ) -> Result<()> {
        require!(stake_lamports > 0, ErrorCode::InvalidAmount);
        require!(match_id > 0, ErrorCode::InvalidMatchId);
        require!(
            lichess_game_id.len() <= MAX_LICHESS_GAME_ID_LENGTH,
            ErrorCode::LichessGameIdTooLong
        );

        // Check ban
        let now = Clock::get()?.unix_timestamp;
        require!(
            !ctx.accounts.player_a_profile.is_banned
                || ctx.accounts.player_a_profile.ban_expires_at <= now,
            ErrorCode::PlayerBanned
        );

        let wager_key = ctx.accounts.wager.key();
        let player_a_key = ctx.accounts.player_a.key();

        // Transfer stake from player A to PDA
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
        wager.lichess_game_id = lichess_game_id;
        wager.status = WagerStatus::Created;
        wager.requires_moderator = requires_moderator;
        wager.vote_player_a = None;
        wager.vote_player_b = None;
        wager.winner = None;
        wager.vote_timestamp = 0;
        wager.retract_deadline = 0;
        wager.created_at = now;

        emit!(WagerCreated {
            wager_id: wager_key,
            player_a: wager.player_a,
            match_id,
            stake_lamports,
        });

        Ok(())
    }

    // Join wager (opponent stakes)
    pub fn join_wager(ctx: Context<JoinWager>, stake_lamports: u64) -> Result<()> {
        let wager_key = ctx.accounts.wager.key();
        let player_b_key = ctx.accounts.player_b.key();
        let wager_info = ctx.accounts.wager.to_account_info();
        let wager = &mut ctx.accounts.wager;
        let now = Clock::get()?.unix_timestamp;

        require!(
            wager.status == WagerStatus::Created,
            ErrorCode::InvalidStatus
        );
        require!(
            stake_lamports == wager.stake_lamports,
            ErrorCode::InvalidAmount
        );
        require!(
            !ctx.accounts.player_b_profile.is_banned
                || ctx.accounts.player_b_profile.ban_expires_at <= now,
            ErrorCode::PlayerBanned
        );

        // Transfer stake from player B to PDA
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
        wager.status = WagerStatus::Joined;

        emit!(WagerJoined {
            wager_id: wager_key,
            player_b: wager.player_b,
            stake_lamports,
        });

        Ok(())
    }

    // Submit vote
    pub fn submit_vote(ctx: Context<SubmitVote>, voted_winner: Pubkey) -> Result<()> {
        let wager = &mut ctx.accounts.wager;
        let now = Clock::get()?.unix_timestamp;

        require!(
            wager.status == WagerStatus::Joined || wager.status == WagerStatus::Voting,
            ErrorCode::InvalidStatus
        );

        if wager.status == WagerStatus::Joined {
            wager.status = WagerStatus::Voting;
            wager.vote_timestamp = now;
        }

        let player_key = ctx.accounts.player.key();
        let is_player_a = player_key == wager.player_a;
        let is_player_b = player_key == wager.player_b;
        require!(is_player_a || is_player_b, ErrorCode::Unauthorized);

        require!(
            voted_winner == wager.player_a || voted_winner == wager.player_b,
            ErrorCode::InvalidVote
        );

        if is_player_a {
            require!(wager.vote_player_a.is_none(), ErrorCode::AlreadyVoted);
            wager.vote_player_a = Some(voted_winner);
        } else {
            require!(wager.vote_player_b.is_none(), ErrorCode::AlreadyVoted);
            wager.vote_player_b = Some(voted_winner);
        }

        // Check agreement
        if let (Some(va), Some(vb)) = (wager.vote_player_a, wager.vote_player_b) {
            if va == vb {
                wager.status = WagerStatus::Retractable;
                wager.retract_deadline = now + 300; // 5 min
            } else if wager.requires_moderator {
                wager.status = WagerStatus::Disputed;
            }
        }

        emit!(VoteSubmitted {
            wager_id: wager.key(),
            player: player_key,
            voted_winner,
        });

        Ok(())
    }

    // Retract vote
    pub fn retract_vote(ctx: Context<RetractVote>) -> Result<()> {
        let wager = &mut ctx.accounts.wager;
        let now = Clock::get()?.unix_timestamp;

        require!(
            wager.status == WagerStatus::Retractable,
            ErrorCode::InvalidStatus
        );
        require!(now <= wager.retract_deadline, ErrorCode::RetractExpired);

        let player_key = ctx.accounts.player.key();
        let is_player_a = player_key == wager.player_a;
        let is_player_b = player_key == wager.player_b;
        require!(is_player_a || is_player_b, ErrorCode::Unauthorized);

        if is_player_a {
            wager.vote_player_a = None;
        } else {
            wager.vote_player_b = None;
        }

        if wager.vote_player_a.is_none() && wager.vote_player_b.is_none() {
            wager.status = WagerStatus::Voting;
        }

        emit!(VoteRetracted {
            wager_id: wager.key(),
            player: player_key,
        });

        Ok(())
    }

    // Resolve (API, agreement, or mod)
    pub fn resolve_wager(ctx: Context<ResolveWager>, winner: Pubkey) -> Result<()> {
        let wager_info = ctx.accounts.wager.to_account_info();
        let winner_info = ctx.accounts.winner.to_account_info();
        let authorizer_info = ctx.accounts.authorizer.to_account_info();
        let wager = &mut ctx.accounts.wager;
        let now = Clock::get()?.unix_timestamp;

        match wager.status {
            WagerStatus::Retractable => {
                require!(now > wager.retract_deadline, ErrorCode::VoteWindowExpired);
            }
            WagerStatus::Disputed => {
                require!(
                    ctx.accounts.authorizer.key() != wager.player_a
                        && ctx.accounts.authorizer.key() != wager.player_b,
                    ErrorCode::Unauthorized
                );
            }
            WagerStatus::Joined | WagerStatus::Voting => {
                // API resolution (authorizer can be backend)
            }
            _ => return err!(ErrorCode::InvalidStatus),
        }

        require!(
            winner == wager.player_a || winner == wager.player_b,
            ErrorCode::InvalidWinner
        );

        wager.winner = Some(winner);
        wager.status = WagerStatus::Resolved;
        wager.resolved_at = now;

        // Payout full pot to winner
        let total_lamports = wager.stake_lamports * 2;
        **wager_info.try_borrow_mut_lamports()? -= total_lamports;
        **winner_info.try_borrow_mut_lamports()? += total_lamports;

        // Close PDA (reclaim rent to authorizer)
        let remaining = wager_info.lamports();
        if remaining > 0 {
            **wager_info.try_borrow_mut_lamports()? -= remaining;
            **authorizer_info.try_borrow_mut_lamports()? += remaining;
        }

        emit!(WagerResolved {
            wager_id: wager.key(),
            winner,
            total_payout: total_lamports,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePlayer<'info> {
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + 32 + 1 + 8 + 1,
        seeds = [b"player", player.key().as_ref()],
        bump
    )]
    pub player_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateWager<'info> {
    #[account(
        init,
        payer = player_a,
        space = 8 + 1 + 32 + 32 + 8 + 8 + 20 + 1 + 1 + 33 + 33 + 33 + 8 + 8 + 8 + 1,
        seeds = [b"wager", player_a.key().as_ref(), match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub wager: Account<'info, WagerAccount>,
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
    pub player_b_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub player_b: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitVote<'info> {
    #[account(
        mut,
        seeds = [b"wager", wager.player_a.as_ref(), wager.match_id.to_le_bytes().as_ref()],
        bump = wager.bump
    )]
    pub wager: Account<'info, WagerAccount>,
    /// CHECK: Player validated in logic
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct RetractVote<'info> {
    #[account(
        mut,
        seeds = [b"wager", wager.player_a.as_ref(), wager.match_id.to_le_bytes().as_ref()],
        bump = wager.bump
    )]
    pub wager: Account<'info, WagerAccount>,
    /// CHECK: Player validated in logic
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveWager<'info> {
    #[account(
        mut,
        seeds = [b"wager", wager.player_a.as_ref(), wager.match_id.to_le_bytes().as_ref()],
        bump = wager.bump,
        close = authorizer
    )]
    pub wager: Account<'info, WagerAccount>,
    /// CHECK: Winner pubkey
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
    /// CHECK: Authorizer (backend/mod)
    #[account(mut)]
    pub authorizer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

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
    pub bump: u8,
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub match_id: u64,
    pub stake_lamports: u64,
    pub lichess_game_id: String,
    pub status: WagerStatus,
    pub requires_moderator: bool,
    pub vote_player_a: Option<Pubkey>,
    pub vote_player_b: Option<Pubkey>,
    pub winner: Option<Pubkey>,
    pub vote_timestamp: i64,
    pub retract_deadline: i64,
    pub created_at: i64,
    pub resolved_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum WagerStatus {
    Created,
    Joined,
    Voting,
    Retractable,
    Disputed,
    Resolved,
}

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
pub struct VoteSubmitted {
    pub wager_id: Pubkey,
    pub player: Pubkey,
    pub voted_winner: Pubkey,
}

#[event]
pub struct VoteRetracted {
    pub wager_id: Pubkey,
    pub player: Pubkey,
}

#[event]
pub struct WagerResolved {
    pub wager_id: Pubkey,
    pub winner: Pubkey,
    pub total_payout: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid wager status")]
    InvalidStatus,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Vote window expired")]
    VoteWindowExpired,
    #[msg("Retract period expired")]
    RetractExpired,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid match ID")]
    InvalidMatchId,
    #[msg("Lichess game ID too long")]
    LichessGameIdTooLong,
    #[msg("Invalid vote")]
    InvalidVote,
    #[msg("Already voted")]
    AlreadyVoted,
    #[msg("Invalid winner")]
    InvalidWinner,
    #[msg("Player is banned")]
    PlayerBanned,
}
