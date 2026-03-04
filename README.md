# Game Gambit

An on-chain peer-to-peer chess wager program built on Solana using the Anchor framework. Players stake SOL against each other tied to a Lichess game ID. Outcomes are resolved by player consensus or, in disputed cases, by the platform authority. A 10% platform fee is taken from the winning pot on resolution.

---

## Table of Contents

- [Overview](#overview)
- [Program Details](#program-details)
- [Wager Lifecycle](#wager-lifecycle)
- [Instructions](#instructions)
- [Account Structures](#account-structures)
- [PDA Derivation](#pda-derivation)
- [Error Codes](#error-codes)
- [Environment Setup](#environment-setup)
- [Running Tests](#running-tests)
- [Security Model](#security-model)
- [Project Structure](#project-structure)

---

## Overview

Game Gambit allows two players to:

1. Create a wager linked to a Lichess game ID and deposit a SOL stake
2. Have the opponent join and match the stake
3. Independently vote on who won the game
4. Auto-resolve if both votes agree (after a 48-hour retract window)
5. Escalate to authority-moderated resolution if votes conflict

The winner receives 90% of the total pot. The platform receives a 10% fee.

---

## Program Details

| Property | Value |
|----------|-------|
| Program ID | `E2Vd3U91kMrgwp8JCXcLSn7bt3NowDmGwoBYsVRhGfMR` |
| Network | Devnet |
| Framework | Anchor `0.31.1` |
| Language | Rust |
| Platform Fee | 10% (1000 bps) |
| Retract Window | 48 hours |
| Wager Join Expiry | 7 days |

---

## Wager Lifecycle

```
Created ──► Joined ──► Voting ──► Retractable ──► Resolved
                          │              │
                          │         (retracted)
                          │              │
                          │           Voting
                          │
                          └──► Disputed ──► Resolved (authority only)

Any non-Resolved state ──► Closed (via close_wager)
```

| Status | Description |
|--------|-------------|
| `Created` | Player A has deposited. Waiting for Player B to join (expires in 7 days). |
| `Joined` | Both players have deposited. Ready for voting. |
| `Voting` | At least one vote has been submitted. |
| `Retractable` | Both players voted for the same winner. 48-hour window to retract before resolution. |
| `Disputed` | Players voted for different winners. Authority must resolve. |
| `Resolved` | Winner paid out, platform fee collected. |
| `Closed` | Wager cancelled and stakes refunded (if not already resolved). |

---

## Instructions

### `initialize_player`

Creates a `PlayerProfile` PDA for the calling wallet. Safe to call multiple times — only initialises once, updates `last_active` on subsequent calls.

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `player_profile` | ✓ | | PDA: `["player", player]` |
| `player` | ✓ | ✓ | The player's wallet |
| `system_program` | | | |

---

### `ban_player`

Bans or unbans a player. Only callable by the authority.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `ban_duration` | `i64` | Duration in seconds. Pass `0` to unban. |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `player_profile` | ✓ | | PDA of the player to ban |
| `authorizer` | ✓ | ✓ | Must match `AUTHORITY_PUBKEY` |
| `system_program` | | | |

---

### `create_wager`

Creates a new wager PDA and transfers the stake from Player A into it.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `match_id` | `u64` | Unique match identifier (must be > 0) |
| `stake_lamports` | `u64` | Amount each player stakes (must be > 0) |
| `lichess_game_id` | `String` | Lichess game ID (max 20 characters) |
| `requires_moderator` | `bool` | If true, only authority can resolve |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | PDA: `["wager", player_a, match_id]` |
| `player_a_profile` | | | Must not be banned |
| `player_a` | ✓ | ✓ | Wager creator |
| `system_program` | | | |

---

### `join_wager`

Player B joins an open wager by matching the exact stake amount. Must be called within 7 days of wager creation.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `stake_lamports` | `u64` | Must exactly match wager's `stake_lamports` |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | Must be in `Created` status |
| `player_b_profile` | | | Must not be banned |
| `player_b` | ✓ | ✓ | Cannot be same wallet as Player A |
| `system_program` | | | |

---

### `submit_vote`

Each player submits their vote for who won. Either player can vote first. When both votes are in, the wager transitions to `Retractable` (agreement) or `Disputed` (conflict).

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `voted_winner` | `Pubkey` | Must be either `player_a` or `player_b` |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | Must be in `Joined` or `Voting` status |
| `player` | ✓ | ✓ | Must be player_a or player_b |

---

### `retract_vote`

Allows either player to retract their vote during the 48-hour retract window after both votes agree. Returns the wager to `Voting` status.

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | Must be in `Retractable` status within deadline |
| `player` | ✓ | ✓ | Must be player_a or player_b |

---

### `resolve_wager`

Pays out the winner (90%) and platform (10%). Resolution rules depend on wager status:

| Status | Who can resolve | Additional requirement |
|--------|----------------|----------------------|
| `Retractable` | Authority or either player | Retract window must have expired |
| `Disputed` | Authority only | — |
| `Voting` | Authority only | — |

If `requires_moderator` is `true`, only the authority can resolve regardless of status.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `winner` | `Pubkey` | Must be player_a or player_b |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | |
| `winner` | ✓ | | Must match the `winner` argument |
| `authorizer` | ✓ | ✓ | |
| `platform_wallet` | ✓ | | Must match `PLATFORM_WALLET_PUBKEY` |
| `system_program` | | | |

---

### `close_wager`

Cancels a wager and refunds stakes to both players (if not already resolved). Can be called by either player or the authority at any time.

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | Closed via Anchor `close = authorizer` |
| `player_a` | ✓ | | Must match `wager.player_a` |
| `player_b` | ✓ | | Must match `wager.player_b` (or default if none joined) |
| `authorizer` | ✓ | ✓ | Player A, Player B, or authority |
| `system_program` | | | |

---

## Account Structures

### `PlayerProfile`

PDA: `["player", player_pubkey]`

| Field | Type | Description |
|-------|------|-------------|
| `player` | `Pubkey` | Owner wallet |
| `is_banned` | `bool` | Whether the player is banned |
| `ban_expires_at` | `i64` | Unix timestamp when ban expires (0 = indefinite until manually lifted) |
| `last_active` | `i64` | Unix timestamp of last `initialize_player` call |
| `bump` | `u8` | PDA bump seed |

### `WagerAccount`

PDA: `["wager", player_a_pubkey, match_id_le_bytes]`

| Field | Type | Description |
|-------|------|-------------|
| `bump` | `u8` | PDA bump seed |
| `player_a` | `Pubkey` | Wager creator |
| `player_b` | `Pubkey` | Opponent (default until joined) |
| `match_id` | `u64` | Unique match identifier |
| `stake_lamports` | `u64` | Per-player stake amount |
| `lichess_game_id` | `String` | Linked Lichess game (max 20 chars) |
| `status` | `WagerStatus` | Current lifecycle status |
| `requires_moderator` | `bool` | Whether authority-only resolution is enforced |
| `vote_player_a` | `Option<Pubkey>` | Player A's vote |
| `vote_player_b` | `Option<Pubkey>` | Player B's vote |
| `winner` | `Option<Pubkey>` | Set on resolution |
| `vote_timestamp` | `i64` | When the first vote was cast |
| `retract_deadline` | `i64` | Deadline to retract after both votes agree |
| `created_at` | `i64` | Wager creation timestamp |
| `expires_at` | `i64` | Deadline for Player B to join (7 days from creation) |
| `resolved_at` | `i64` | Resolution timestamp |

---

## PDA Derivation

```typescript
// Player profile
const [playerProfilePDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("player"), playerPublicKey.toBuffer()],
  programId
);

// Wager
const [wagerPDA] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("wager"),
    playerAPublicKey.toBuffer(),
    new anchor.BN(matchId).toArrayLike(Buffer, "le", 8),
  ],
  programId
);
```

---

## Error Codes

| Code | Message |
|------|---------|
| `InvalidStatus` | Invalid wager status |
| `Unauthorized` | Unauthorized access |
| `RetractPeriodNotExpired` | Retract period has not expired yet |
| `RetractExpired` | Retract period expired |
| `InvalidAmount` | Invalid amount |
| `InvalidMatchId` | Invalid match ID |
| `LichessGameIdTooLong` | Lichess game ID too long |
| `InvalidVote` | Invalid vote |
| `AlreadyVoted` | Already voted |
| `InvalidWinner` | Invalid winner |
| `InvalidPlayer` | Invalid player |
| `PlayerBanned` | Player is banned |
| `WagerExpired` | Wager has expired |
| `InvalidPlatformWallet` | Invalid platform wallet |
| `ArithmeticOverflow` | Arithmetic overflow |
| `InsufficientFunds` | Insufficient funds in wager account |

---

## Environment Setup

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) `>= 1.18`
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) `0.31.1`
- Node.js `>= 18`

### Install

```bash
git clone <repo-url>
cd gamegambit-sol
npm install
```

### Environment Variables

Create a `.env` file in the project root (gitignored):

```env
PINATA_JWT=your_pinata_jwt_token
PINATA_API_KEY=your_pinata_api_key
PINATA_SECRET_KEY=your_pinata_secret_key
PINATA_GATEWAY=https://gateway.pinata.cloud/ipfs
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_NETWORK=devnet
ANCHOR_PROGRAM_ID=E2Vd3U91kMrgwp8JCXcLSn7bt3NowDmGwoBYsVRhGfMR
```

### Keypair Setup

The test suite reads keypairs from the `test-keys/` directory. On first run they are auto-generated and their pubkeys are printed. Fund them before running tests:

```bash
solana airdrop 2 <PLAYER_A_PUBKEY> --url devnet
solana airdrop 2 <PLAYER_B_PUBKEY> --url devnet
solana airdrop 2 <AUTHORITY_PUBKEY> --url devnet
```

> **Never commit keypair JSON files.** They are gitignored. Keep authority and platform wallet keypairs outside the project directory in production.

### Build

```bash
anchor build
```

### Deploy

```bash
anchor deploy --provider.cluster devnet
```

---

## Running Tests

The full test suite runs against devnet and requires funded wallets.

```bash
# Full wager flow
anchor test

# Core wager flow via ts-mocha directly
npm test

# Pinata/IPFS integration
npm run test:pinata

# NFT integration
npm run test:nft
```

Test coverage in `tests/gamegambit.ts`:

- Player initialisation
- Wager creation — valid and invalid parameters
- Joining a wager — valid and mismatched stake
- Vote submission and agreement → `Retractable`
- Vote retraction → back to `Voting`
- Resolution via player agreement with 10% platform fee payout
- Authority force-resolution from `Voting` state
- Dispute resolution by authority
- Unauthorised resolution attempt (expected failure)
- Ban and unban flow with wager restriction enforcement

Each test logs pre/post balances and Solana Explorer transaction links for devnet verification.

---

## Security Model

### Authority

A single hardcoded `AUTHORITY_PUBKEY` constant governs all privileged operations. This eliminates the spoofable `UncheckedAccount` authority pattern — there is no way to pass an arbitrary account to satisfy the authority check. The authority is required to ban players, resolve disputes, force-resolve wagers in `Voting` state, and resolve any wager where `requires_moderator = true`.

Store the authority keypair securely. Compromise of this keypair allows arbitrary dispute resolution.

### Platform Wallet

`PLATFORM_WALLET_PUBKEY` is enforced via an Anchor account constraint at the point of account validation, before instruction logic runs. The fee destination is fixed at the program level and cannot be redirected at call time.

### Fund Safety

All lamport arithmetic uses Rust's checked operations to prevent overflow. A balance assertion verifies the wager account holds sufficient funds before any transfer. Refunds in `close_wager` are issued per-player so a failed transfer to one player does not block the other. Rent recovery is handled exclusively by Anchor's `close = authorizer` constraint to prevent double-close panics.

---

## Project Structure

```
programs/gamegambit/src/
  lib.rs                          # Full program source

tests/
  gamegambit.ts                   # Core wager flow tests
  complete-flow-with-nft.test.ts  # End-to-end with NFT minting
  nft-integration.test.ts         # NFT integration tests
  pinata.test.ts                  # IPFS upload tests

src/
  config/
    env.config.ts                 # Environment variable loader
    trophy-uris.json              # Trophy IPFS URIs
  services/
    nft-mint.service.ts           # NFT minting via Metaplex
    pinata.service.ts             # IPFS upload via Pinata
    pinata-with-trophies.service.ts
  utils/
    trophy-selector.ts            # Trophy tier selection logic
    wager-nft.helper.ts           # Wager NFT helper utilities

test-keys/                        # Auto-generated test keypairs (gitignored)
trophies/                         # Trophy image assets (bronze, silver, gold, diamond)
```