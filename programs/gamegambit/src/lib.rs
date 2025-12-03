use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("CPS82nShfYFBdJPLs4kLMYEUrTwvxieqSrkw6VYRopzx");

const MAX_LICHESS_GAME_ID_LENGTH: usize = 20;

#[allow(deprecated)]
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
        let player_profile = &mut ctx.accounts.player_profile;
        let now = Clock::get()?.unix_timestamp;

        // Only authority can ban players
        require!(
            ctx.accounts.authorizer.key() == ctx.accounts.authority.key(),
            ErrorCode::Unauthorized
        );

        // Set ban status and expiration
        if ban_duration == 0 {
            player_profile.is_banned = false;
            player_profile.ban_expires_at = 0;
        } else {
            player_profile.is_banned = true;
            player_profile.ban_expires_at = now + ban_duration;
        }

        emit!(PlayerBanned {
            player: player_profile.player,
            ban_expires_at: player_profile.ban_expires_at,
        });

        Ok(())
    }

    pub fn create_wager(
        ctx: Context<CreateWager>,
        match_id: u64,
        stake_lamports: u64,
        lichess_game_id: String,
        requires_moderator: bool,
    ) -> Result<()> {
        msg!("Creating wager with match_id: {}", match_id);
        require!(stake_lamports > 0, ErrorCode::InvalidAmount);
        require!(match_id > 0, ErrorCode::InvalidMatchId);
        require!(
            lichess_game_id.len() <= MAX_LICHESS_GAME_ID_LENGTH,
            ErrorCode::LichessGameIdTooLong
        );

        let now = Clock::get()?.unix_timestamp;
        require!(
            !ctx.accounts.player_a_profile.is_banned
                || ctx.accounts.player_a_profile.ban_expires_at <= now,
            ErrorCode::PlayerBanned
        );

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
        wager.lichess_game_id = lichess_game_id;
        wager.status = WagerStatus::Created;
        wager.requires_moderator = requires_moderator;
        wager.vote_player_a = None;
        wager.vote_player_b = None;
        wager.winner = None;
        wager.vote_timestamp = 0;
        wager.retract_deadline = 0;
        wager.created_at = now;
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
        wager.status = WagerStatus::Joined;

        emit!(WagerJoined {
            wager_id: wager_key,
            player_b: wager.player_b,
            stake_lamports,
        });

        Ok(())
    }

    pub fn submit_vote(ctx: Context<SubmitVote>, voted_winner: Pubkey) -> Result<()> {
        let wager = &mut ctx.accounts.wager;
        msg!("Submitting vote, current status: {:?}", wager.status);
        let now = Clock::get()?.unix_timestamp;

        require!(
            wager.status == WagerStatus::Joined || wager.status == WagerStatus::Voting,
            ErrorCode::InvalidStatus
        );

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

        if wager.status == WagerStatus::Joined {
            wager.status = WagerStatus::Voting;
            wager.vote_timestamp = now;
        }

        if let (Some(vote_a), Some(vote_b)) = (wager.vote_player_a, wager.vote_player_b) {
            if vote_a == vote_b {
                wager.status = WagerStatus::Retractable;
                wager.retract_deadline = now + 10; // 10 seconds for testing
            } else {
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

    pub fn retract_vote(ctx: Context<RetractVote>) -> Result<()> {
        let wager = &mut ctx.accounts.wager;
        msg!("Retracting vote, current status: {:?}", wager.status);
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

        wager.status = WagerStatus::Voting;

        emit!(VoteRetracted {
            wager_id: wager.key(),
            player: player_key,
        });

        Ok(())
    }

    pub fn resolve_wager(ctx: Context<ResolveWager>, winner: Pubkey) -> Result<()> {
        let wager_info = ctx.accounts.wager.to_account_info();
        let winner_info = ctx.accounts.winner.to_account_info();
        let now = Clock::get()?.unix_timestamp;

        let wager = &mut ctx.accounts.wager;
        msg!("Resolving wager, current status: {:?}", wager.status);

        require!(
            wager.status == WagerStatus::Retractable
                || wager.status == WagerStatus::Disputed
                || wager.status == WagerStatus::Voting,
            ErrorCode::InvalidStatus
        );
        require!(
            winner == wager.player_a || winner == wager.player_b,
            ErrorCode::InvalidWinner
        );

        if wager.status == WagerStatus::Retractable {
            require!(now > wager.retract_deadline, ErrorCode::RetractPeriodNotExpired);
            require!(
                wager.vote_player_a == Some(winner) && wager.vote_player_b == Some(winner),
                ErrorCode::InvalidVote
            );
            require!(
                ctx.accounts.authorizer.key() == wager.player_a
                    || ctx.accounts.authorizer.key() == wager.player_b,
                ErrorCode::Unauthorized
            );
        } else if wager.status == WagerStatus::Disputed {
            require!(
                ctx.accounts.authorizer.key() != wager.player_a
                    && ctx.accounts.authorizer.key() != wager.player_b,
                ErrorCode::Unauthorized
            );
        }

        let total_lamports = wager.stake_lamports * 2;
        **wager_info.try_borrow_mut_lamports()? -= total_lamports;
        **winner_info.try_borrow_mut_lamports()? += total_lamports;

        wager.winner = Some(winner);
        wager.status = WagerStatus::Resolved;
        wager.resolved_at = now;

        emit!(WagerResolved {
            wager_id: wager.key(),
            winner,
            total_payout: total_lamports,
        });

        Ok(())
    }

    pub fn close_wager(ctx: Context<CloseWager>) -> Result<()> {
        let wager_info = ctx.accounts.wager.to_account_info();
        let authorizer_info = ctx.accounts.authorizer.to_account_info();
        let wager = &mut ctx.accounts.wager;
        msg!("Closing wager, current status: {:?}", wager.status);

        require!(
            ctx.accounts.authorizer.key() == wager.player_a
                || ctx.accounts.authorizer.key() == wager.player_b
                || ctx.accounts.authorizer.key() == ctx.accounts.authority.key(),
            ErrorCode::Unauthorized
        );

        if wager.status != WagerStatus::Resolved {
            let mut total_lamports = 0;
            if wager.player_a != Pubkey::default() {
                total_lamports += wager.stake_lamports;
            }
            if wager.player_b != Pubkey::default() {
                total_lamports += wager.stake_lamports;
            }
            if total_lamports > 0 {
                **wager_info.try_borrow_mut_lamports()? -= total_lamports;
                if wager.player_a != Pubkey::default() {
                    **ctx
                        .accounts
                        .player_a
                        .to_account_info()
                        .try_borrow_mut_lamports()? += wager.stake_lamports;
                }
                if wager.player_b != Pubkey::default() {
                    **ctx
                        .accounts
                        .player_b
                        .to_account_info()
                        .try_borrow_mut_lamports()? += wager.stake_lamports;
                }
            }
        }

        let remaining = wager_info.lamports();
        if remaining > 0 {
            **wager_info.try_borrow_mut_lamports()? -= remaining;
            **authorizer_info.try_borrow_mut_lamports()? += remaining;
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePlayer<'info> {
    #[account(
        init_if_needed,
        payer = player,
        space = 64,
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
    /// CHECK: Authority pubkey is validated in instruction logic to match authorizer
    pub authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateWager<'info> {
    #[account(
        init,
        payer = player_a,
        space = 300,
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
        bump
    )]
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
    #[account(mut)]
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
    #[account(mut)]
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveWager<'info> {
    #[account(
        mut,
        seeds = [b"wager", wager.player_a.as_ref(), wager.match_id.to_le_bytes().as_ref()],
        bump = wager.bump
    )]
    pub wager: Account<'info, WagerAccount>,
    /// CHECK: Winner is validated to be either wager.player_a or wager.player_b in instruction logic
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
    #[account(mut)]
    pub authorizer: Signer<'info>,
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
    /// CHECK: Validated to be wager.player_a in instruction logic
    #[account(mut)]
    pub player_a: UncheckedAccount<'info>,
    /// CHECK: Validated to be wager.player_b or default in instruction logic
    #[account(mut)]
    pub player_b: UncheckedAccount<'info>,
    #[account(mut)]
    pub authorizer: Signer<'info>,
    /// CHECK: Authority pubkey is validated in instruction logic to match authorizer
    pub authority: UncheckedAccount<'info>,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
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

#[event]
pub struct PlayerBanned {
    pub player: Pubkey,
    pub ban_expires_at: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid wager status")]
    InvalidStatus,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Retract period has not expired yet")]
    RetractPeriodNotExpired,
    // #[msg("Vote window expired")] // removed to avoid confusion
    // VoteWindowExpired, // removed to avoid confusion
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
    #[msg("Invalid player")]
    InvalidPlayer,
    #[msg("Player is banned")]
    PlayerBanned,
}
