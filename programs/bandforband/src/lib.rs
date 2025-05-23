use anchor_lang::prelude::*;
use anchor_lang::solana_program::clock::Clock;

declare_id!("2tjZvgNNXxGhHm6dzQx65rbVbEb8ZtJRN95gcgeE8bo8");

#[program]
pub mod trading_duel_protocol {
    use super::*;

    // Initialize the protocol
    pub fn initialize(ctx: Context<Initialize>, protocol_fee_bps: u16) -> Result<()> {
        let protocol = &mut ctx.accounts.protocol;
        protocol.authority = ctx.accounts.authority.key();
        protocol.treasury = ctx.accounts.treasury.key();
        protocol.fee_bps = protocol_fee_bps;
        protocol.total_duels = 0;
        protocol.total_volume = 0;
        Ok(())
    }

    // Create a new duel challenge
    pub fn create_duel(
        ctx: Context<CreateDuel>,
        stake_amount: u64,
        duration_seconds: i64,
        allowed_tokens: Vec<Pubkey>,
    ) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        let clock = Clock::get()?;
        
        duel.creator = ctx.accounts.creator.key();
        duel.opponent = Pubkey::default(); // To be filled when accepted
        duel.stake_amount = stake_amount;
        duel.created_at = clock.unix_timestamp;
        duel.start_time = 0;
        duel.end_time = 0;
        duel.duration = duration_seconds;
        duel.status = DuelStatus::Pending;
        duel.creator_stake_deposited = false;
        duel.opponent_stake_deposited = false;
        duel.allowed_tokens = allowed_tokens;
        duel.creator_starting_value = 0;
        duel.opponent_starting_value = 0;
        duel.creator_final_value = 0;
        duel.opponent_final_value = 0;
        duel.winner = DuelWinner::None;
        
        // Increment protocol stats
        let protocol = &mut ctx.accounts.protocol;
        protocol.total_duels += 1;
        
        Ok(())
    }

    // Accept a duel challenge
    pub fn accept_duel(ctx: Context<AcceptDuel>) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        let _clock = Clock::get()?;
        
        require!(duel.status == DuelStatus::Pending, DuelError::InvalidStatus);
        require!(duel.opponent == Pubkey::default(), DuelError::DuelAlreadyAccepted);
        
        duel.opponent = ctx.accounts.opponent.key();
        duel.status = DuelStatus::Accepted;
        
        msg!("Duel accepted. Both parties must deposit stakes to begin.");
        
        Ok(())
    }

    // Deposit stake for the duel
    pub fn deposit_stake(ctx: Context<DepositStake>) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        let clock = Clock::get()?;
        
        require!(duel.status == DuelStatus::Accepted, DuelError::InvalidStatus);
        
        // Determine if depositor is creator or opponent
        let is_creator = ctx.accounts.depositor.key() == duel.creator;
        let is_opponent = ctx.accounts.depositor.key() == duel.opponent;
        
        require!(is_creator || is_opponent, DuelError::NotParticipant);
        
        // Transfer stake to escrow
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.duel_escrow.to_account_info(),
                },
            ),
            duel.stake_amount,
        )?;
        
        // Update deposit status
        if is_creator {
            duel.creator_stake_deposited = true;
        } else {
            duel.opponent_stake_deposited = true;
        }
        
        // If both have deposited, start the duel
        if duel.creator_stake_deposited && duel.opponent_stake_deposited {
            duel.status = DuelStatus::Active;
            duel.start_time = clock.unix_timestamp;
            duel.end_time = clock.unix_timestamp + duel.duration;
            
            // Record starting portfolio values (would be fetched from oracle)
            duel.creator_starting_value = duel.stake_amount;
            duel.opponent_starting_value = duel.stake_amount;
            
            msg!("Duel started! Trading period ends at {}", duel.end_time);
        }
        
        Ok(())
    }

    // Update trading positions (called by oracle)
    pub fn update_positions(
        ctx: Context<UpdatePositions>,
        creator_value: u64,
        opponent_value: u64,
    ) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        let clock = Clock::get()?;
        
        require!(duel.status == DuelStatus::Active, DuelError::InvalidStatus);
        require!(clock.unix_timestamp <= duel.end_time, DuelError::DuelExpired);
        
        // In production, verify oracle signature
        duel.creator_final_value = creator_value;
        duel.opponent_final_value = opponent_value;
        
        emit!(PositionUpdate {
            duel: duel.key(),
            creator_value,
            opponent_value,
            timestamp: clock.unix_timestamp,
        });
        
        Ok(())
    }

    // Settle the duel and distribute winnings
    pub fn settle_duel(ctx: Context<SettleDuel>) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        let protocol = &mut ctx.accounts.protocol;
        let clock = Clock::get()?;
        
        require!(duel.status == DuelStatus::Active, DuelError::InvalidStatus);
        require!(clock.unix_timestamp >= duel.end_time, DuelError::DuelNotExpired);
        
        // Calculate PnL percentages
        let creator_pnl = calculate_pnl(duel.creator_starting_value, duel.creator_final_value);
        let opponent_pnl = calculate_pnl(duel.opponent_starting_value, duel.opponent_final_value);
        
        // Determine winner
        let (winner, winner_account) = if creator_pnl > opponent_pnl {
            (DuelWinner::Creator, ctx.accounts.creator.to_account_info())
        } else if opponent_pnl > creator_pnl {
            (DuelWinner::Opponent, ctx.accounts.opponent.to_account_info())
        } else {
            (DuelWinner::Draw, ctx.accounts.creator.to_account_info()) // Draw handling
        };
        
        // Calculate payouts
        let total_stake = duel.stake_amount * 2;
        let protocol_fee = (total_stake * protocol.fee_bps as u64) / 10000;
        let winner_payout = total_stake - protocol_fee;
        
        // Use proper CPI transfers instead of direct lamport manipulation
        let duel_key = duel.key();
        let escrow_seeds = &[
            b"escrow",
            duel_key.as_ref(),
            &[ctx.bumps.duel_escrow],
        ];
        let signer = &[&escrow_seeds[..]];
        
        // Transfer protocol fee to treasury
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.duel_escrow.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
                signer,
            ),
            protocol_fee,
        )?;
        
        // Transfer winnings
        if winner == DuelWinner::Draw {
            // Return stakes minus half fee each
            let refund = duel.stake_amount - (protocol_fee / 2);
            
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.duel_escrow.to_account_info(),
                        to: ctx.accounts.creator.to_account_info(),
                    },
                    signer,
                ),
                refund,
            )?;
            
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.duel_escrow.to_account_info(),
                        to: ctx.accounts.opponent.to_account_info(),
                    },
                    signer,
                ),
                refund,
            )?;
        } else {
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.duel_escrow.to_account_info(),
                        to: winner_account,
                    },
                    signer,
                ),
                winner_payout,
            )?;
        }
        
        // Update duel status
        duel.status = DuelStatus::Settled;
        duel.winner = winner;
        
        // Update protocol stats
        protocol.total_volume += total_stake;
        
        emit!(DuelSettled {
            duel: duel.key(),
            winner,
            creator_pnl,
            opponent_pnl,
            winner_payout,
            protocol_fee,
        });
        
        Ok(())
    }

    // Cancel a pending duel
    pub fn cancel_duel(ctx: Context<CancelDuel>) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        
        require!(duel.status == DuelStatus::Pending, DuelError::CannotCancel);
        require!(ctx.accounts.creator.key() == duel.creator, DuelError::Unauthorized);
        
        duel.status = DuelStatus::Cancelled;
        
        Ok(())
    }
}

// Account structures
#[account]
pub struct Protocol {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16, // Basis points (100 = 1%)
    pub total_duels: u64,
    pub total_volume: u64,
}

#[account]
pub struct Duel {
    pub creator: Pubkey,
    pub opponent: Pubkey,
    pub stake_amount: u64,
    pub created_at: i64,
    pub start_time: i64,
    pub end_time: i64,
    pub duration: i64,
    pub status: DuelStatus,
    pub winner: DuelWinner,
    pub creator_stake_deposited: bool,
    pub opponent_stake_deposited: bool,
    pub allowed_tokens: Vec<Pubkey>,
    pub creator_starting_value: u64,
    pub opponent_starting_value: u64,
    pub creator_final_value: u64,
    pub opponent_final_value: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum DuelStatus {
    Pending,
    Accepted,
    Active,
    Settled,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum DuelWinner {
    None,
    Creator,
    Opponent,
    Draw,
}

// Context structs
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 2 + 8 + 8,
        seeds = [b"protocol"],
        bump
    )]
    pub protocol: Account<'info, Protocol>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// CHECK: Treasury account for fees
    pub treasury: UncheckedAccount<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateDuel<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 4 + (32 * 10) + 8 + 8 + 8 + 8,
        seeds = [b"duel", protocol.total_duels.to_le_bytes().as_ref()],
        bump
    )]
    pub duel: Account<'info, Duel>,
    
    #[account(mut)]
    pub protocol: Account<'info, Protocol>,
    
    #[account(mut)]
    pub creator: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptDuel<'info> {
    #[account(mut)]
    pub duel: Account<'info, Duel>,
    
    #[account(mut)]
    pub opponent: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositStake<'info> {
    #[account(mut)]
    pub duel: Account<'info, Duel>,
    
    #[account(
        mut,
        seeds = [b"escrow", duel.key().as_ref()],
        bump
    )]
    /// CHECK: Escrow account for holding stakes
    pub duel_escrow: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub depositor: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePositions<'info> {
    #[account(mut)]
    pub duel: Account<'info, Duel>,
    
    #[account(mut)]
    pub oracle: Signer<'info>, // In production, verify this is authorized oracle
}

#[derive(Accounts)]
pub struct SettleDuel<'info> {
    #[account(mut)]
    pub duel: Account<'info, Duel>,
    
    #[account(mut)]
    pub protocol: Account<'info, Protocol>,
    
    #[account(
        mut,
        seeds = [b"escrow", duel.key().as_ref()],
        bump
    )]
    /// CHECK: Escrow account for holding stakes
    pub duel_escrow: UncheckedAccount<'info>,
    
    #[account(mut)]
    /// CHECK: Creator account to receive winnings
    pub creator: UncheckedAccount<'info>,
    
    #[account(mut)]
    /// CHECK: Opponent account to receive winnings
    pub opponent: UncheckedAccount<'info>,
    
    #[account(mut)]
    /// CHECK: Treasury account for fees
    pub treasury: UncheckedAccount<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelDuel<'info> {
    #[account(mut)]
    pub duel: Account<'info, Duel>,
    
    pub creator: Signer<'info>,
}

// Events
#[event]
pub struct PositionUpdate {
    pub duel: Pubkey,
    pub creator_value: u64,
    pub opponent_value: u64,
    pub timestamp: i64,
}

#[event]
pub struct DuelSettled {
    pub duel: Pubkey,
    pub winner: DuelWinner,
    pub creator_pnl: i64,
    pub opponent_pnl: i64,
    pub winner_payout: u64,
    pub protocol_fee: u64,
}

// Error codes
#[error_code]
pub enum DuelError {
    #[msg("Invalid duel status for this operation")]
    InvalidStatus,
    #[msg("Duel has already been accepted")]
    DuelAlreadyAccepted,
    #[msg("Not a participant in this duel")]
    NotParticipant,
    #[msg("Duel has expired")]
    DuelExpired,
    #[msg("Duel has not expired yet")]
    DuelNotExpired,
    #[msg("Cannot cancel duel in current status")]
    CannotCancel,
    #[msg("Unauthorized action")]
    Unauthorized,
}

// Helper functions
fn calculate_pnl(starting_value: u64, final_value: u64) -> i64 {
    if starting_value == 0 {
        return 0;
    }
    
    ((final_value as i64 - starting_value as i64) * 10000) / starting_value as i64
}   