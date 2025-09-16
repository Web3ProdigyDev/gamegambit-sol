use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer, MintTo, CloseAccount};
use mpl_token_metadata::{
    ID as metadata_program_id,
    instructions::{CreateMetadataAccountV3, CreateMetadataAccountV3InstructionArgs},
    types::{DataV2, Creator},
};

declare_id!("2utNaXCHzRvuX3kNz4DAsQyV7s25G2Q1gHNWFfckTng1");

const MAX_LICHESS_GAME_ID_LENGTH: usize = 20;
const DISPUTE_RESOLVER_PUBKEY: Pubkey = Pubkey::new_from_array([0; 32]); // Replace with actual pubkey
const SEASON_DURATION: i64 = 10368000; // 4 months in seconds

#[program]
pub mod gamegambit {
    use super::*;

    // Initialize platform configuration
    pub fn initialize_platform(ctx: Context<InitializePlatform>) -> Result<()> {
        let platform_config = &mut ctx.accounts.platform_config;
        platform_config.authority = ctx.accounts.authority.key();
        platform_config.current_season = 1;
        platform_config.season_start = Clock::get()?.unix_timestamp;
        platform_config.total_players = 0;
        platform_config.bump = ctx.bumps.platform_config;
        Ok(())
    }

    // Initialize or update player profile - RACE CONDITION FIXED
    pub fn initialize_player(ctx: Context<InitializePlayer>) -> Result<()> {
        let player_profile = &mut ctx.accounts.player_profile;
        let current_time = Clock::get()?.unix_timestamp;
        
        // Check if this is truly a new account by examining the discriminator
        // Anchor automatically sets discriminator on init, so we can use that
        let is_new_account = player_profile.player == Pubkey::default();
        
        if is_new_account {
            // ATOMIC INITIALIZATION - all fields set in single transaction
            // This prevents race conditions since Anchor's init constraint ensures 
            // only one transaction can successfully initialize the account
            
            player_profile.player = ctx.accounts.player.key();
            player_profile.mu = 25.0; // OpenSkill initial rating
            player_profile.sigma = 25.0 / 3.0; // Initial uncertainty
            player_profile.xp = 500; // Include first-day bonus immediately
            player_profile.rank = Rank::BronzeV;
            player_profile.wins = 0;
            player_profile.losses = 0;
            player_profile.current_streak = 0;
            player_profile.max_streak = 0;
            player_profile.total_wagered = 0;
            player_profile.total_tipped = 0;
            player_profile.total_play_time = 0;
            player_profile.matches_played = 0;
            player_profile.season_high_rank = Rank::BronzeV;
            player_profile.created_at = current_time;
            player_profile.last_active = current_time;
            player_profile.prestige_score = 0;
            player_profile.badges_earned = 0;
            player_profile.is_banned = false;
            player_profile.ban_expires_at = 0;
            player_profile.bump = ctx.bumps.player_profile;
            player_profile.daily_matches_played = 0;
            player_profile.last_daily_reset = current_time;
            player_profile.challenges_completed = 0;
            player_profile.current_daily_login_streak = 1; // First day
            player_profile.season_challenges = 0;
            player_profile.weekly_matches = 0;
            player_profile.last_weekly_reset = current_time;
            
            // Atomically increment total players count
            let platform_config = &mut ctx.accounts.platform_config;
            platform_config.total_players = platform_config.total_players
                .checked_add(1)
                .ok_or(ErrorCode::Overflow)?;
                
        } else {
            // EXISTING PLAYER LOGIN - Handle daily bonuses with proper checks
            let last_login_day = player_profile.last_active / 86400;
            let current_day = current_time / 86400;
            
            // Only award daily bonus if it's actually a new day
            if current_day > last_login_day {
                // Prevent overflow on XP
                player_profile.xp = player_profile.xp
                    .checked_add(100)
                    .ok_or(ErrorCode::Overflow)?;
                    
                // Update daily login streak atomically
                player_profile.current_daily_login_streak = player_profile.current_daily_login_streak
                    .checked_add(1)
                    .ok_or(ErrorCode::Overflow)?;
                    
                PlayerProfileHelpers::update_rank(player_profile)?;
            }
        }
        
        // Always update last_active timestamp
        player_profile.last_active = current_time;
        Ok(())
    }

    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        amount: u64,
        lichess_game_id: String,
        match_id: u64,
        requires_moderator: bool,
        game_type: GameType,
    ) -> Result<()> {
        // Validation checks
        if amount == 0 {
            return err!(ErrorCode::InvalidAmount);
        }
        if match_id == 0 {
            return err!(ErrorCode::InvalidMatchId);
        }
        if lichess_game_id.len() > MAX_LICHESS_GAME_ID_LENGTH {
            return err!(ErrorCode::LichessGameIdTooLong);
        }
        
        // Check if players are banned
        if ctx.accounts.player_a_profile.is_banned && 
           ctx.accounts.player_a_profile.ban_expires_at > Clock::get()?.unix_timestamp {
            return err!(ErrorCode::PlayerBanned);
        }
        if ctx.accounts.player_b_profile.is_banned && 
           ctx.accounts.player_b_profile.ban_expires_at > Clock::get()?.unix_timestamp {
            return err!(ErrorCode::PlayerBanned);
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.player_a = ctx.accounts.player_a.key();
        escrow.player_b = ctx.accounts.player_b.key();
        escrow.authority = ctx.accounts.authority.key();
        escrow.amount = amount;
        escrow.lichess_game_id = lichess_game_id;
        escrow.match_id = match_id;
        escrow.status = EscrowStatus::Initialized;
        escrow.requires_moderator = requires_moderator;
        escrow.game_type = game_type;
        escrow.created_at = Clock::get()?.unix_timestamp;
        escrow.resolved_at = 0;
        escrow.bump = ctx.bumps.escrow;
        escrow.token_bump = ctx.bumps.escrow_token_account;

        // Transfer tokens from both players
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player_a_token_account.to_account_info(),
                    to: ctx.accounts.escrow_token_account.to_account_info(),
                    authority: ctx.accounts.player_a.to_account_info(),
                },
            ),
            amount,
        )?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player_b_token_account.to_account_info(),
                    to: ctx.accounts.escrow_token_account.to_account_info(),
                    authority: ctx.accounts.player_b.to_account_info(),
                },
            ),
            amount,
        )?;

        Ok(())
    }

    pub fn resolve_escrow(
        ctx: Context<ResolveEscrow>, 
        winner: Pubkey,
        moderator: Option<Pubkey>,
        match_duration_seconds: u32,
        performance_metrics: PerformanceMetrics,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let current_time = Clock::get()?.unix_timestamp;
        
        // Validation checks
        if escrow.status != EscrowStatus::Initialized {
            return err!(ErrorCode::EscrowNotInitialized);
        }
        
        if winner != escrow.player_a && winner != escrow.player_b {
            return err!(ErrorCode::InvalidWinner);
        }

        // Prevent premature resolution (minimum 2 minutes for most games)
        if current_time < escrow.created_at + 120 {
            return err!(ErrorCode::GameTooEarly);
        }

        if escrow.requires_moderator && moderator.is_none() {
            return err!(ErrorCode::ModeratorRequired);
        }

        let total_amount = escrow.amount.checked_mul(2).ok_or(ErrorCode::Overflow)?;
        
        // Calculate fees based on moderation
        let (platform_fee_percent, moderator_fee_percent) = if moderator.is_some() {
            (10, 2) // 10% platform + 2% moderator = 12% total
        } else {
            (7, 0) // 7% platform only
        };

        let platform_fee = total_amount
            .checked_mul(platform_fee_percent)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(100)
            .ok_or(ErrorCode::Overflow)?;
            
        let moderator_fee = total_amount
            .checked_mul(moderator_fee_percent)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(100)
            .ok_or(ErrorCode::Overflow)?;

        let winner_amount = total_amount
            .checked_sub(platform_fee)
            .ok_or(ErrorCode::Overflow)?
            .checked_sub(moderator_fee)
            .ok_or(ErrorCode::Overflow)?;

        // Update OpenSkill ratings and XP
        PlayerProfileHelpers::update_player_ratings_and_xp(
            &mut ctx.accounts.player_a_profile,
            &mut ctx.accounts.player_b_profile,
            winner == escrow.player_a,
            escrow.amount,
            match_duration_seconds,
            &performance_metrics,
            current_time,
        )?;

        // Transfer funds
        let escrow_account_info = escrow.to_account_info();
        let player_a_key = escrow.player_a;
        let player_b_key = escrow.player_b;
        let match_id_bytes = escrow.match_id.to_le_bytes();
        let seeds = &[
            b"escrow",
            player_a_key.as_ref(),
            player_b_key.as_ref(),
            match_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer platform fee
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_token_account.to_account_info(),
                    to: ctx.accounts.platform_vault.to_account_info(),
                    authority: escrow_account_info.clone(),
                },
                signer_seeds,
            ),
            platform_fee,
        )?;

        // Transfer moderator fee if applicable
        if moderator_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_token_account.to_account_info(),
                        to: ctx.accounts.moderator_vault.to_account_info(),
                        authority: escrow_account_info.clone(),
                    },
                    signer_seeds,
                ),
                moderator_fee,
            )?;
        }

        // Transfer winnings to winner
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_token_account.to_account_info(),
                    to: ctx.accounts.winner_token_account.to_account_info(),
                    authority: escrow_account_info,
                },
                signer_seeds,
            ),
            winner_amount,
        )?;

        escrow.status = EscrowStatus::Completed;
        escrow.resolved_at = current_time;
        Ok(())
    }

    pub fn tip_player(ctx: Context<TipPlayer>, amount: u64) -> Result<()> {
        // Transfer tip
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.tipper_token_account.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.tipper.to_account_info(),
                },
            ),
            amount,
        )?;

        // Update profiles with tipping bonuses
        let tipper_profile = &mut ctx.accounts.tipper_profile;
        let recipient_profile = &mut ctx.accounts.recipient_profile;
        
        tipper_profile.total_tipped += amount;
        
        // Tipper gets XP for tipping (15 XP per 1 SOL, capped at 100 XP/day)
        let tip_xp = (amount / 1_000_000_000).min(7) * 15; // Max 7 SOL worth for daily cap
        tipper_profile.xp += tip_xp as u32;
        
        // Update ranks if needed
        PlayerProfileHelpers::update_rank(tipper_profile)?;
        
        // Check for tipping badges
        BadgeHelpers::check_tipping_badges(tipper_profile, recipient_profile)?;

        Ok(())
    }

    pub fn mint_badge_nft(
        ctx: Context<MintBadgeNFT>, 
        badge_type: BadgeType,
        name: String, 
        symbol: String, 
        uri: String
    ) -> Result<()> {
        // Verify player has earned this badge
        BadgeHelpers::verify_badge_eligibility(&ctx.accounts.player_profile, &badge_type)?;

        // Mint NFT to player
        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.player_token_account.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            1, // NFT amount = 1
        )?;

        // Create metadata
        let creators = vec![
            Creator {
                address: ctx.accounts.authority.key(),
                verified: true,
                share: 100,
            },
        ];

        let cpi_accounts = CreateMetadataAccountV3 {
            metadata: ctx.accounts.metadata.key(),
            mint: ctx.accounts.mint.key(),
            mint_authority: ctx.accounts.authority.key(),
            payer: ctx.accounts.authority.key(),
            update_authority: (ctx.accounts.authority.key(), true),
            system_program: ctx.accounts.system_program.key(),
            rent: Some(ctx.accounts.rent.key()),
        };

        let cpi_args = CreateMetadataAccountV3InstructionArgs {
            data: DataV2 {
                name,
                symbol,
                uri,
                seller_fee_basis_points: 500, // 5% royalty
                creators: Some(creators),
                collection: None,
                uses: None,
            },
            is_mutable: true,
            collection_details: None,
        };

        let instruction = cpi_accounts.instruction(cpi_args);

        let accounts = [
            ctx.accounts.metadata.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
        ];

        anchor_lang::solana_program::program::invoke(&instruction, &accounts)?;

        // Update player profile
        let player_profile = &mut ctx.accounts.player_profile;
        player_profile.badges_earned += 1;
        
        // Update prestige score based on badge rarity
        let prestige_points = match BadgeHelpers::get_badge_rarity(&badge_type) {
            BadgeRarity::Common => 1,
            BadgeRarity::Rare => 3,
            BadgeRarity::Epic => 7,
            BadgeRarity::Legendary => 10,
        };
        player_profile.prestige_score += prestige_points;

        Ok(())
    }

    pub fn mint_season_legacy_nft(
        ctx: Context<MintBadgeNFT>,
        season_number: u64,
        final_rank: Rank,
    ) -> Result<()> {
        let rank_name = match final_rank {
            Rank::BronzeV | Rank::BronzeIV | Rank::BronzeIII | Rank::BronzeII | Rank::BronzeI => "Bronze",
            Rank::SilverV | Rank::SilverIV | Rank::SilverIII | Rank::SilverII | Rank::SilverI => "Silver",
            Rank::GoldV | Rank::GoldIV | Rank::GoldIII | Rank::GoldII | Rank::GoldI => "Gold",
            Rank::PlatinumV | Rank::PlatinumIV | Rank::PlatinumIII | Rank::PlatinumII | Rank::PlatinumI => "Platinum",
            Rank::DiamondV | Rank::DiamondIV | Rank::DiamondIII | Rank::DiamondII | Rank::DiamondI => "Diamond",
            Rank::Master => "Master",
            Rank::Grandmaster => "Grandmaster",
        };
        
        let name = format!("{} Legacy Season {}", rank_name, season_number);
        let symbol = format!("LEGACY{}", season_number);
        let uri = format!("https://gamegambit.com/nft/legacy/{}/{}", season_number, rank_name.to_lowercase());
        
        // Use existing NFT minting logic
        gamegambit::mint_badge_nft(ctx, BadgeType::SeasonLegacy, name, symbol, uri)
    }

    pub fn force_close(ctx: Context<ForceClose>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let current_time = Clock::get()?.unix_timestamp;
        
        if escrow.status == EscrowStatus::Closed {
            return err!(ErrorCode::EscrowAlreadyClosed);
        }

        // Only allow force close after 1 hour minimum
        if current_time < escrow.created_at + 3600 {
            return err!(ErrorCode::ForceCloseTooEarly);
        }

        let escrow_account_info = escrow.to_account_info();
        let player_a_key = escrow.player_a;
        let player_b_key = escrow.player_b;
        let match_id_bytes = escrow.match_id.to_le_bytes();
        let escrow_seeds = &[
            b"escrow",
            player_a_key.as_ref(),
            player_b_key.as_ref(),
            match_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer_seeds = &[&escrow_seeds[..]];

        // Refund both players
        if ctx.accounts.escrow_token_account.amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_token_account.to_account_info(),
                        to: ctx.accounts.player_a_token_account.to_account_info(),
                        authority: escrow_account_info.clone(),
                    },
                    signer_seeds,
                ),
                escrow.amount,
            )?;

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_token_account.to_account_info(),
                        to: ctx.accounts.player_b_token_account.to_account_info(),
                        authority: escrow_account_info.clone(),
                    },
                    signer_seeds,
                ),
                escrow.amount,
            )?;
        }

        // Close token account
        token::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.escrow_token_account.to_account_info(),
                    destination: ctx.accounts.authority.to_account_info(),
                    authority: escrow_account_info,
                },
                signer_seeds,
            )
        )?;

        escrow.status = EscrowStatus::Closed;
        Ok(())
    }

    pub fn ban_player(
        ctx: Context<BanPlayer>, 
        duration_days: u8, 
        reason: BanReason
    ) -> Result<()> {
        let player_profile = &mut ctx.accounts.player_profile;
        let ban_duration = (duration_days as i64) * 86400; // Convert to seconds
        
        player_profile.is_banned = true;
        player_profile.ban_expires_at = Clock::get()?.unix_timestamp + ban_duration;
        
        // Award penalty badge based on ban severity
        match duration_days {
            7 => {
                // First offense - Vigilance Warning
            },
            14 => {
                // Second offense - Honor Hiccup  
            },
            30 => {
                // Major cheat - Codebreaker's Censure
            },
            _ => {},
        }

        Ok(())
    }

    pub fn start_new_season(ctx: Context<StartNewSeason>) -> Result<()> {
        let platform_config = &mut ctx.accounts.platform_config;
        platform_config.current_season += 1;
        platform_config.season_start = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn reset_player_season(ctx: Context<ResetPlayerSeason>) -> Result<()> {
        let player_profile = &mut ctx.accounts.player_profile;
        
        // Reset XP to 65% of current (soft reset)
        player_profile.xp = (player_profile.xp * 65) / 100;
        
        // Update rank based on new XP
        player_profile.rank = PlayerProfileHelpers::xp_to_rank(player_profile.xp);
        
        // Reset season high rank
        player_profile.season_high_rank = player_profile.rank;
        
        Ok(())
    }
}

// Helper Structs - Move helper functions outside the program module
pub struct PlayerProfileHelpers;

impl PlayerProfileHelpers {
    pub fn update_player_ratings_and_xp(
        player_a: &mut Account<PlayerProfile>,
        player_b: &mut Account<PlayerProfile>,
        player_a_won: bool,
        wager_amount: u64,
        match_duration: u32,
        performance: &PerformanceMetrics,
        current_time: i64,
    ) -> Result<()> {
        // OpenSkill rating updates (simplified)
        let rating_change = Self::calculate_openskill_update(
            player_a.mu, player_a.sigma, 
            player_b.mu, player_b.sigma, 
            player_a_won
        );

        if player_a_won {
            player_a.mu += rating_change;
            player_b.mu -= rating_change;
            player_a.wins += 1;
            player_b.losses += 1;
            player_a.current_streak += 1;
            player_b.current_streak = 0;
            if player_a.current_streak > player_a.max_streak {
                player_a.max_streak = player_a.current_streak;
            }
        } else {
            player_a.mu -= rating_change;
            player_b.mu += rating_change;
            player_a.losses += 1;
            player_b.wins += 1;
            player_a.current_streak = 0;
            player_b.current_streak += 1;
            if player_b.current_streak > player_b.max_streak {
                player_b.max_streak = player_b.current_streak;
            }
        }

        // Reduce uncertainty over time
        player_a.sigma = (player_a.sigma * 0.95).max(2.0);
        player_b.sigma = (player_b.sigma * 0.95).max(2.0);

        // XP Calculations
        let base_xp_win = 100u32;
        let base_xp_loss = 50u32;

        // Wager bonus: 30 XP per 1 SOL (cap 150)
        let wager_bonus = ((wager_amount / 1_000_000_000) * 30).min(150) as u32;

        // Performance bonuses
        let performance_bonus = Self::calculate_performance_bonus(performance);

        // Efficiency bonus for quick matches (<3 minutes)
        let efficiency_bonus = if match_duration < 180 { 40 } else { 0 };

        // Activity bonus: +20 XP after 3rd match of the day
        let activity_bonus = if player_a.matches_played % 10 >= 3 { 20 } else { 0 }; // Simplified daily tracking

        // Daily login bonus (check if last active was yesterday)
        let daily_bonus = if current_time - player_a.last_active > 86400 { 100 } else { 0 };

        // Streak bonus
        let streak_bonus_a = if player_a_won { player_a.current_streak * 30 } else { 0 };
        let streak_bonus_b = if !player_a_won { player_b.current_streak * 30 } else { 0 };

        // Underdog bonus (simplified - based on mu difference)
        let underdog_bonus_a = if !player_a_won && player_b.mu > player_a.mu + 4.0 { 50 } else { 0 };
        let underdog_bonus_b = if player_a_won && player_a.mu > player_b.mu + 4.0 { 50 } else { 0 };

        // Challenge bonus
        let challenge_bonus_a = Self::calculate_challenge_bonus(player_a, current_time);
        let challenge_bonus_b = Self::calculate_challenge_bonus(player_b, current_time);

        // Update XP
        if player_a_won {
            player_a.xp += base_xp_win + wager_bonus + performance_bonus + efficiency_bonus + 
                           streak_bonus_a + underdog_bonus_b + activity_bonus + daily_bonus + challenge_bonus_a;
            player_b.xp += base_xp_loss + wager_bonus + underdog_bonus_a + daily_bonus + challenge_bonus_b;
        } else {
            player_a.xp += base_xp_loss + wager_bonus + underdog_bonus_a + daily_bonus + challenge_bonus_a;
            player_b.xp += base_xp_win + wager_bonus + performance_bonus + efficiency_bonus + 
                           streak_bonus_b + underdog_bonus_a + activity_bonus + daily_bonus + challenge_bonus_b;
        }

        // Update other stats
        player_a.matches_played += 1;
        player_b.matches_played += 1;
        player_a.total_wagered += wager_amount;
        player_b.total_wagered += wager_amount;
        player_a.total_play_time += match_duration;
        player_b.total_play_time += match_duration;
        player_a.last_active = current_time;
        player_b.last_active = current_time;

        // Update ranks
        Self::update_rank(player_a)?;
        Self::update_rank(player_b)?;

        Ok(())
    }

    fn calculate_openskill_update(
        mu_a: f64, sigma_a: f64,
        mu_b: f64, sigma_b: f64,
        player_a_won: bool,
    ) -> f64 {
        // Simplified OpenSkill calculation
        let beta = 25.0 / 6.0; // Skill class width
        let tau = 25.0 / 300.0; // Dynamics factor
        
        let c_squared = 2.0 * (beta * beta) + sigma_a * sigma_a + sigma_b * sigma_b;
        let expected_a = 1.0 / (1.0 + (-(mu_a - mu_b) / c_squared.sqrt()).exp());
        
        let actual_a = if player_a_won { 1.0 } else { 0.0 };
        let update_factor = (sigma_a * sigma_a + tau * tau) / c_squared;
        
        (actual_a - expected_a) * update_factor
    }

    fn calculate_performance_bonus(performance: &PerformanceMetrics) -> u32 {
        let mut bonus = 0u32;
        
        // K/D ratio bonus for FPS games
        if performance.kills_deaths_ratio > 2.0 {
            bonus += 30;
        }
        
        // Accuracy bonus
        if performance.accuracy_percent > 70.0 {
            bonus += 25;
        }
        
        // Objective bonus
        if performance.objectives_completed > 0 {
            bonus += 40;
        }
        
        // Score bonus
        if performance.score > 2000 {
            bonus += 20;
        }
        
        bonus
    }

    fn calculate_challenge_bonus(player: &mut PlayerProfile, current_time: i64) -> u32 {
        let mut bonus = 0u32;
        
        // Reset daily counters if new day
        let current_day = current_time / 86400;
        let last_day = player.last_daily_reset / 86400;
        
        if current_day > last_day {
            player.daily_matches_played = 0;
            player.last_daily_reset = current_time;
            player.current_daily_login_streak += 1;
        }
        
        player.daily_matches_played += 1;
        
        // Daily challenges
        match player.daily_matches_played {
            3 => bonus += 200,  // Play 3 matches
            5 => bonus += 500,  // Play 5 matches  
            10 => bonus += 1000, // Play 10 matches
            _ => {}
        }
        
        // Weekly challenges (simplified)
        if player.matches_played % 50 == 0 && player.matches_played > 0 {
            bonus += 2000; // Play 50 total matches milestone
        }
        
        bonus
    }

    pub fn update_rank(player: &mut PlayerProfile) -> Result<()> {
        let new_rank = Self::xp_to_rank(player.xp);
        if new_rank > player.rank {
            player.rank = new_rank;
            if new_rank > player.season_high_rank {
                player.season_high_rank = new_rank;
            }
        }
        Ok(())
    }

    pub fn xp_to_rank(xp: u32) -> Rank {
        match xp {
            0..=299 => Rank::BronzeV,
            300..=699 => Rank::BronzeIV,
            700..=1199 => Rank::BronzeIII,
            1200..=1999 => Rank::BronzeII,
            2000..=2999 => Rank::BronzeI,
            3000..=3999 => Rank::SilverV,
            4000..=4999 => Rank::SilverIV,
            5000..=5999 => Rank::SilverIII,
            6000..=7499 => Rank::SilverII,
            7500..=8999 => Rank::SilverI,
            9000..=10499 => Rank::GoldV,
            10500..=11999 => Rank::GoldIV,
            12000..=13999 => Rank::GoldIII,
            14000..=15999 => Rank::GoldII,
            16000..=17999 => Rank::GoldI,
            18000..=19999 => Rank::PlatinumV,
            20000..=21999 => Rank::PlatinumIV,
            22000..=24999 => Rank::PlatinumIII,
            25000..=27499 => Rank::PlatinumII,
            27500..=29999 => Rank::PlatinumI,
            30000..=32499 => Rank::DiamondV,
            32500..=34999 => Rank::DiamondIV,
            35000..=37499 => Rank::DiamondIII,
            37500..=39999 => Rank::DiamondII,
            40000..=49999 => Rank::DiamondI,
            50000..=99999 => Rank::Master,
            _ => Rank::Grandmaster,
        }
    }
}

pub struct BadgeHelpers;

impl BadgeHelpers {
    pub fn verify_badge_eligibility(player: &PlayerProfile, badge_type: &BadgeType) -> Result<()> {
        match badge_type {
            BadgeType::FirstBlood => {
                if player.wins < 1 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::GambitSpark => {
                if player.wins < 10 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::VictoryVanguard => {
                if player.wins < 50 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::ConquerorsCrest => {
                if player.wins < 100 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::WarlordsWill => {
                if player.wins < 250 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::EmpireEternal => {
                if player.wins < 500 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::MythicMonarch => {
                if player.wins < 1000 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::LegendOfTheArena => {
                if player.wins < 5000 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::PhilanthropistsPride => {
                if player.total_tipped < 2000 * 1_000_000_000 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::EternalEmperor => {
                if player.max_streak < 50 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::InvincibleIcon => {
                if player.max_streak < 10 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::StreakSoldier => {
                if player.max_streak < 5 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::ArenaAddict => {
                if player.total_play_time < 360000 { return err!(ErrorCode::BadgeNotEarned); } // 100 hours
            },
            BadgeType::TimelessTactician => {
                if player.total_play_time < 3600000 { return err!(ErrorCode::BadgeNotEarned); } // 1000 hours
            },
            BadgeType::GenerousGambiteer => {
                if player.total_tipped < 25 * 1_000_000_000 { return err!(ErrorCode::BadgeNotEarned); } // 25 SOL
            },
            BadgeType::BenefactorsBounty => {
                if player.total_tipped < 100 * 1_000_000_000 { return err!(ErrorCode::BadgeNotEarned); } // 100 SOL
            },
            BadgeType::MagnatesMark => {
                if player.total_tipped < 500 * 1_000_000_000 { return err!(ErrorCode::BadgeNotEarned); } // 500 SOL
            },
            BadgeType::BronzeLeague => {
                if player.rank < Rank::BronzeI { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::SilverLeague => {
                if player.rank < Rank::SilverI { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::GoldLeague => {
                if player.rank < Rank::GoldI { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::PlatinumLeague => {
                if player.rank < Rank::PlatinumI { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::DiamondLeague => {
                if player.rank < Rank::DiamondI { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::MasterLeague => {
                if player.rank < Rank::Master { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::GrandmasterLeague => {
                if player.rank < Rank::Grandmaster { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::DailyDuelist => {
                if player.current_daily_login_streak < 5 { return err!(ErrorCode::BadgeNotEarned); }
            },
            BadgeType::WeeklyWarrior => {
                if player.matches_played < 28 { return err!(ErrorCode::BadgeNotEarned); } // 4 weeks of daily play
            },
            BadgeType::RampageRookie => {
                if player.max_streak < 3 { return err!(ErrorCode::BadgeNotEarned); }
            },
            _ => {},
        }
        Ok(())
    }

    pub fn get_badge_rarity(badge_type: &BadgeType) -> BadgeRarity {
        match badge_type {
            // Common badges (40%)
            BadgeType::FirstBlood | BadgeType::GambitSpark | BadgeType::VictoryVanguard |
            BadgeType::BronzeLeague | BadgeType::SilverLeague | BadgeType::TipTryout |
            BadgeType::AllysAid | BadgeType::DailyDuelist | BadgeType::RampageRookie |
            BadgeType::BattleScars | BadgeType::HardenedHeart => BadgeRarity::Common,
            
            // Rare badges (30%)
            BadgeType::ConquerorsCrest | BadgeType::WarlordsWill | BadgeType::GoldLeague |
            BadgeType::PlatinumLeague | BadgeType::GenerousGambiteer | BadgeType::BenefactorsBounty |
            BadgeType::InvincibleIcon | BadgeType::WeeklyWarrior | BadgeType::ArenaAddict |
            BadgeType::ResilientRenegade | BadgeType::DefiantDefender => BadgeRarity::Rare,
            
            // Epic badges (20%)
            BadgeType::EmpireEternal | BadgeType::MythicMonarch | BadgeType::DiamondLeague |
            BadgeType::MasterLeague | BadgeType::MagnatesMark | BadgeType::GodlikeGambiteer |
            BadgeType::BattleBehemoth | BadgeType::PhoenixFlame | BadgeType::ComebackChampion |
            BadgeType::UnyieldingUnderdog | BadgeType::GrindGuru => BadgeRarity::Epic,
            
            // Legendary badges (10%)
            BadgeType::LegendOfTheArena | BadgeType::GrandmasterLeague | BadgeType::PhilanthropistsPride |
            BadgeType::EternalEmperor | BadgeType::TimelessTactician | BadgeType::EternalEndurer |
            BadgeType::ColosseumConqueror | BadgeType::PrecisionPredator => BadgeRarity::Legendary,
            
            _ => BadgeRarity::Common,
        }
    }

    pub fn check_tipping_badges(_tipper: &mut PlayerProfile, _recipient: &mut PlayerProfile) -> Result<()> {
        // Check various tipping milestones and award badges accordingly
        // This would trigger badge minting in a separate transaction
        Ok(())
    }
}

// Account Structs
#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 8 + 8 + 8 + 1,
        seeds = [b"platform_config"],
        bump
    )]
    pub platform_config: Account<'info, PlatformConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializePlayer<'info> {
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + 32 + 8 + 8 + 4 + 1 + 4 + 4 + 4 + 4 + 8 + 8 + 4 + 4 + 1 + 8 + 8 + 4 + 4 + 1 + 8 + 1,
        seeds = [b"player_profile", player.key().as_ref()],
        bump
    )]
    pub player_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub platform_config: Account<'info, PlatformConfig>,
    pub player: Signer<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, lichess_game_id: String, match_id: u64)]
pub struct InitializeEscrow<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 32 + 8 + 4 + MAX_LICHESS_GAME_ID_LENGTH + 8 + 1 + 1 + 1 + 8 + 8 + 1 + 1,
        seeds = [b"escrow", player_a.key().as_ref(), player_b.key().as_ref(), match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow: Account<'info, EscrowState>,
    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = escrow,
        seeds = [b"token", escrow.key().as_ref()],
        bump
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub player_a: Signer<'info>,
    #[account(mut)]
    pub player_b: Signer<'info>,
    #[account(mut)]
    pub player_a_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub player_b_profile: Account<'info, PlayerProfile>,
    #[account(mut, token::mint = mint, token::authority = player_a)]
    pub player_a_token_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = player_b)]
    pub player_b_token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ResolveEscrow<'info> {
    #[account(
        mut,
        seeds = [b"escrow", player_a.key().as_ref(), player_b.key().as_ref(), escrow.match_id.to_le_bytes().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowState>,
    #[account(
        mut,
        seeds = [b"token", escrow.key().as_ref()],
        bump = escrow.token_bump
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub player_a_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub player_b_profile: Account<'info, PlayerProfile>,
    #[account(mut, token::mint = escrow_token_account.mint, token::authority = authority)]
    pub platform_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = escrow_token_account.mint, token::authority = authority)]
    pub moderator_vault: Account<'info, TokenAccount>,
    /// CHECK: Winner is validated to be either player_a or player_b in the logic
    pub winner: AccountInfo<'info>,
    #[account(mut, token::mint = escrow_token_account.mint, token::authority = winner)]
    pub winner_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub player_a: SystemAccount<'info>,
    #[account(mut)]
    pub player_b: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TipPlayer<'info> {
    #[account(mut)]
    pub tipper: Signer<'info>,
    /// CHECK: Recipient validation handled by token account ownership
    pub recipient: AccountInfo<'info>,
    #[account(mut)]
    pub tipper_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub recipient_profile: Account<'info, PlayerProfile>,
    #[account(mut, token::authority = tipper)]
    pub tipper_token_account: Account<'info, TokenAccount>,
    #[account(mut, token::authority = recipient)]
    pub recipient_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MintBadgeNFT<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut)]
    pub player_profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    /// CHECK: This is the metadata account address
    pub metadata: AccountInfo<'info>,
    #[account(mut, token::mint = mint, token::authority = player)]
    pub player_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    /// CHECK: This is the metadata program ID
    #[account(address = metadata_program_id)]
    pub metadata_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ForceClose<'info> {
    #[account(
        mut,
        seeds = [b"escrow", player_a.key().as_ref(), player_b.key().as_ref(), escrow.match_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
        close = authority
    )]
    pub escrow: Account<'info, EscrowState>,
    #[account(
        mut,
        seeds = [b"token", escrow.key().as_ref()],
        bump = escrow.token_bump,
        close = authority
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, token::mint = escrow_token_account.mint, token::authority = player_a)]
    pub player_a_token_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = escrow_token_account.mint, token::authority = player_b)]
    pub player_b_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub player_a: SystemAccount<'info>,
    #[account(mut)]
    pub player_b: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BanPlayer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub player_profile: Account<'info, PlayerProfile>,
}

#[derive(Accounts)]
pub struct StartNewSeason<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub platform_config: Account<'info, PlatformConfig>,
}

#[derive(Accounts)]
pub struct ResetPlayerSeason<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub player_profile: Account<'info, PlayerProfile>,
}

// Data Structs
#[account]
pub struct PlatformConfig {
    pub authority: Pubkey,
    pub current_season: u64,
    pub season_start: i64,
    pub total_players: u64,
    pub bump: u8,
}

#[account]
pub struct EscrowState {
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub authority: Pubkey,
    pub amount: u64,
    pub lichess_game_id: String,
    pub match_id: u64,
    pub status: EscrowStatus,
    pub requires_moderator: bool,
    pub game_type: GameType,
    pub created_at: i64,
    pub resolved_at: i64,
    pub bump: u8,
    pub token_bump: u8,
}

#[account]
pub struct PlayerProfile {
    pub player: Pubkey,
    pub mu: f64,                    // OpenSkill rating
    pub sigma: f64,                 // OpenSkill uncertainty
    pub xp: u32,                   // Experience points for ranking
    pub rank: Rank,                // Current rank
    pub wins: u32,
    pub losses: u32,
    pub current_streak: u32,
    pub max_streak: u32,
    pub total_wagered: u64,        // Total SOL wagered
    pub total_tipped: u64,         // Total SOL tipped to others
    pub total_play_time: u32,      // Total seconds played
    pub matches_played: u32,
    pub season_high_rank: Rank,    // Highest rank this season
    pub created_at: i64,
    pub last_active: i64,
    pub prestige_score: u32,       // Points from NFT badges
    pub badges_earned: u32,        // Total badges collected
    pub is_banned: bool,
    pub ban_expires_at: i64,
    pub bump: u8,
    pub daily_matches_played: u32,     // Reset daily
    pub last_daily_reset: i64,         // Track daily reset
    pub challenges_completed: u32,     // Total challenges completed
    pub current_daily_login_streak: u32, // Daily login streak
    pub season_challenges: u64,        // Bitfield for season challenges
    pub weekly_matches: u32,           // Reset weekly
    pub last_weekly_reset: i64,        // Track weekly reset
}

// Enums
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum EscrowStatus {
    Initialized,
    Completed,
    Closed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum GameType {
    Chess,
    CounterStrike,
    Valorant,
    LeagueOfLegends,
    Fortnite,
    Apex,
    CallOfDuty,
    Fighting,
    RocketLeague,
    Other,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, PartialOrd, Ord, Copy)]
pub enum Rank {
    BronzeV = 0,
    BronzeIV = 1,
    BronzeIII = 2,
    BronzeII = 3,
    BronzeI = 4,
    SilverV = 5,
    SilverIV = 6,
    SilverIII = 7,
    SilverII = 8,
    SilverI = 9,
    GoldV = 10,
    GoldIV = 11,
    GoldIII = 12,
    GoldII = 13,
    GoldI = 14,
    PlatinumV = 15,
    PlatinumIV = 16,
    PlatinumIII = 17,
    PlatinumII = 18,
    PlatinumI = 19,
    DiamondV = 20,
    DiamondIV = 21,
    DiamondIII = 22,
    DiamondII = 23,
    DiamondI = 24,
    Master = 25,
    Grandmaster = 26,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum BadgeType {
    // Rank Badges (7)
    BronzeLeague,
    SilverLeague,
    GoldLeague,
    PlatinumLeague,
    DiamondLeague,
    MasterLeague,
    GrandmasterLeague,
    
    // Gameplay and Wins (20)
    FirstBlood,
    GambitSpark,
    VictoryVanguard,
    ConquerorsCrest,
    WarlordsWill,
    EmpireEternal,
    MythicMonarch,
    LegendOfTheArena,
    SoloSniper,
    TeamTitan,
    AsymmetricAvenger,
    MVPMaestro,
    ObjectiveOracle,
    KillCommander,
    ComboConqueror,
    ResourceRegent,
    ClutchCrusader,
    BlitzBaron,
    UnderdogUnleashed,
    PrecisionPredator,
    
    // Streaks and Consistency (15)
    RampageRookie,
    StreakSoldier,
    InvincibleIcon,
    GodlikeGambiteer,
    EternalEmperor,
    DailyDuelist,
    WeeklyWarrior,
    MonthlyMaster,
    SeasonStalwart,
    ArenaAddict,
    BattleBehemoth,
    TimelessTactician,
    MarathonMaverick,
    GrindGuru,
    RelentlessRival,
    
    // Losses and Resilience (10)
    BattleScars,
    HardenedHeart,
    ResilientRenegade,
    PhoenixFlame,
    ComebackChampion,
    SurvivorsSpirit,
    DefiantDefender,
    UnyieldingUnderdog,
    RedemptionRuler,
    EternalEndurer,
    
    // Tipping and Community (15)
    TipTryout,
    AllysAid,
    GenerousGambiteer,
    BenefactorsBounty,
    MagnatesMark,
    PhilanthropistsPride,
    DailyDonor,
    ConsistentContributor,
    LoyalGiver,
    EternalSupporter,
    KindredKin,
    CommunityCatalyst,
    SpectatorStar,
    ArenaIdol,
    ColosseumConqueror,
    
    // Penalties and Redemption (5)
    VigilanceWarning,
    HonorHiccup,
    CodebreakersCensure,
    ReformedRogue,
    IntegrityGuardian,
    
    // Season Legacy
    SeasonLegacy,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum BadgeRarity {
    Common,
    Rare,
    Epic,
    Legendary,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum BanReason {
    Cheating,
    Toxicity,
    Abandonment,
    Exploit,
    Other,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PerformanceMetrics {
    pub kills_deaths_ratio: f64,
    pub accuracy_percent: f64,
    pub objectives_completed: u32,
    pub damage_dealt: u32,
    pub healing_done: u32,
    pub score: u32,
}

// Error Codes
#[error_code]
pub enum ErrorCode {
    #[msg("Escrow is not initialized")]
    EscrowNotInitialized,
    #[msg("Escrow is already closed")]
    EscrowAlreadyClosed,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Winner must be player_a or player_b")]
    InvalidWinner,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Match ID must be greater than zero")]
    InvalidMatchId,
    #[msg("Lichess game ID is too long")]
    LichessGameIdTooLong,
    #[msg("Token account is not initialized")]
    TokenAccountNotInitialized,
    #[msg("Invalid metadata program")]
    InvalidMetadataProgram,
    #[msg("Game resolution attempted too early")]
    GameTooEarly,
    #[msg("This game requires moderator approval")]
    ModeratorRequired,
    #[msg("Unauthorized dispute resolution")]
    UnauthorizedDispute,
    #[msg("Cannot force close yet - time lock active")]
    ForceCloseTooEarly,
    #[msg("Player is currently banned")]
    PlayerBanned,
    #[msg("Badge has not been earned yet")]
    BadgeNotEarned,
    #[msg("Insufficient XP for rank")]
    InsufficientXP,
    #[msg("Season has ended")]
    SeasonEnded,
    #[msg("Invalid performance metrics")]
    InvalidPerformanceMetrics,
}