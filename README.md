# GameGambit — On-Chain Escrow Program

[![Solana Devnet](https://img.shields.io/badge/Solana-Devnet-9945FF?logo=solana)](https://explorer.solana.com/address/E2Vd3U91kMrgwp8JCXcLSn7bt3NowDmGwoBYsVRhGfMR?cluster=devnet)
[![Anchor](https://img.shields.io/badge/Anchor-0.31.1-512BD4)](https://anchor-lang.com)
[![Rust](https://img.shields.io/badge/Rust-2021-orange)](https://rust-lang.org)

Anchor/Rust smart contract for the [GameGambit](https://thegamegambit.vercel.app) trustless P2P gaming wager platform. Two players stake SOL on a gaming match. Funds lock in a program-derived escrow account. The winner is verified and the pot releases trustlessly — no middleman, no custody risk.

> For the full architecture, database schema, and frontend code see the UI repo:  
> 👉 **https://github.com/GameGambitDev/gamegambit**

---

## Table of Contents

- [Program Details](#program-details)
- [Devnet Transaction Proof](#devnet-transaction-proof)
- [Overview](#overview)
- [Wager Lifecycle](#wager-lifecycle)
- [Instructions](#instructions)
- [Account Structures](#account-structures)
- [PDA Derivation](#pda-derivation)
- [On-Chain Events](#on-chain-events)
- [Error Codes](#error-codes)
- [Security Model](#security-model)
- [NFT Trophy System](#nft-trophy-system)
- [Environment Setup](#environment-setup)
- [Running Tests](#running-tests)
- [Project Structure](#project-structure)

---

## Program Details

| Property | Value |
|----------|-------|
| **Program ID** | `E2Vd3U91kMrgwp8JCXcLSn7bt3NowDmGwoBYsVRhGfMR` |
| **Network** | Solana Devnet |
| **Framework** | Anchor `0.31.1` |
| **Language** | Rust 2021 |
| **Platform Fee** | 10% (1000 bps out of 10,000) |
| **Retract Window** | 15 seconds (devnet testing mode) |
| **Wager Join Expiry** | 7 days |
| **Authority** | `Ec7XfHbeDw1YmHzcGo3WrK73QnqQ3GL9VBczYGPCQJha` |
| **Platform Wallet** | `3hwPwugeuZ33HWJ3SoJkDN2JT3Be9fH62r19ezFiCgYY` |

---

## Devnet Transaction Proof

Real, finalized transactions on Solana Devnet:

| Instruction | Transaction | What Happened |
|---|---|---|
| `create_wager` | [`3rUc3Sb...`](https://explorer.solana.com/tx/3rUc3SbENp5UcnsLYs5AdZkPuknte4dhUYRFusxueFon7LRaSZxJvN3mBrzkQpcZEFHrJcVsHWdfcZrgLDbzG1Qf?cluster=devnet) | Player A staked 0.5 SOL into escrow PDA |
| `join_wager` | [`3tB5F8w...`](https://explorer.solana.com/tx/3tB5F8wZMkvFrfUqTw4WhrAmrohsktaxsHT7Z8iDc3wXjB54RbrDrBFt32boBRvnwek6bBVMRteachqPnMHuxnwf?cluster=devnet) | Player B matched stake — 1 SOL total locked in PDA |
| `resolve_wager` | [`4amRCjE...`](https://explorer.solana.com/tx/4amRCjEFo3NwfExitnbf5F8x9asyxaxYW1tjjG8AHBznHuxER4LjyDXXMeQnTraxYMLoXJGfgprZbDrGvRZwjPBu?cluster=devnet) | Winner got 0.9 SOL, platform took 0.1 SOL, PDA closed |
| `resolve_wager` | [`33Te8Vj...`](https://explorer.solana.com/tx/33Te8VjmqXkKJ9U3MfHRtEyVUC6TTE3H96YvyHZA6drswYw7g1RhbLRtMXskfbRQezvsiTQsP6h4p8YCcJ5v9k1n?cluster=devnet) | Additional resolved wager — 0.9 SOL payout |
| `close_wager` (draw) | [`63Z4uvP...`](https://explorer.solana.com/tx/63Z4uvPFpYdsMScowXQhfSk4uvfVs3hB2zBNrr2f7Jsst3odEUADFnsWXUV1TfGdu1yRWDmZ6USeGVjjYGdG3xhx?cluster=devnet) | Draw — both players refunded in full |
| `close_wager` (cancel) | [`2VyA5SF...`](https://explorer.solana.com/tx/2VyA5SFMqWSKeG68aY73aYQ4gd4zFe6C2W37zAMoXPtaevpdJAyudNfSwXhnBmpVaDvMXZ9B3ScxaoHKvrA3TDyM?cluster=devnet) | Cancelled wager — on-chain refund triggered |

---

## Overview

GameGambit allows two players to:

1. **Create a wager** — Player A locks SOL stake in a WagerAccount PDA, linked to a Lichess game ID
2. **Join** — Player B matches the exact stake amount within 7 days
3. **Play** — The game happens off-chain (on Lichess)
4. **Vote** — Each player independently submits who they think won
5. **Auto-resolve** — If both votes agree, the wager enters a 15-second retract window, then resolves
6. **Dispute** — If votes conflict, the platform authority resolves using Lichess API data
7. **Settle** — Winner receives 90% of the total pot, platform receives 10%

The platform authority never holds custody. All funds sit in a program-owned PDA that can only be moved by valid program instructions.

---

## Wager Lifecycle

```
Created ──► Joined ──► Voting ──► Retractable ──► Resolved
                          │              │
                          │         (retracted)
                          │              ▼
                          │           Voting
                          │
                          └──► Disputed ──► Resolved (authority only)

Any non-Resolved state ──► Closed (close_wager — refunds stakes)
```

| Status | Description |
|--------|-------------|
| `Created` | Player A deposited. Waiting for Player B. Expires in 7 days. |
| `Joined` | Both players deposited. Ready for voting. |
| `Voting` | At least one vote submitted. |
| `Retractable` | Both players voted for same winner. 15-second retract window before auto-resolve. |
| `Disputed` | Players voted for different winners. Authority must resolve. |
| `Resolved` | Winner paid out, platform fee collected, PDA closed. |
| `Closed` | Wager cancelled, stakes refunded to both players. |

---

## Instructions

### `initialize_player`

Creates a `PlayerProfile` PDA for the calling wallet. Safe to call multiple times — uses `init_if_needed`, only initialises once, updates `last_active` on subsequent calls.

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `player_profile` | ✓ | | PDA: `["player", player]` — 128 bytes |
| `player` | ✓ | ✓ | The player's wallet |
| `system_program` | | | |

---

### `ban_player`

Bans or unbans a player profile. Only callable by the hardcoded authority.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `ban_duration` | `i64` | Ban duration in seconds. Pass `0` to unban immediately. |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `player_profile` | ✓ | | PDA of the player to ban/unban |
| `authorizer` | ✓ | ✓ | Must match `AUTHORITY_PUBKEY` |
| `system_program` | | | |

---

### `create_wager`

Creates a new `WagerAccount` PDA and transfers Player A's stake into it via CPI to `SystemProgram::transfer`.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `match_id` | `u64` | Unique match identifier (must be > 0). Used as PDA seed. |
| `stake_lamports` | `u64` | Amount each player stakes (must be > 0) |
| `lichess_game_id` | `String` | Lichess game ID (max 20 characters) |
| `requires_moderator` | `bool` | If true, only authority can resolve |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | PDA: `["wager", player_a, match_id_le]` — 320 bytes |
| `player_a_profile` | | | Must exist and not be banned |
| `player_a` | ✓ | ✓ | Wager creator |
| `system_program` | | | |

---

### `join_wager`

Player B joins an open wager by matching the exact stake amount. Must be called within 7 days of wager creation. Player B cannot be the same wallet as Player A.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `stake_lamports` | `u64` | Must exactly match `wager.stake_lamports` |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | Must be in `Created` status and not expired |
| `player_b_profile` | | | Must exist and not be banned |
| `player_b` | ✓ | ✓ | Cannot be same wallet as Player A |
| `system_program` | | | |

---

### `submit_vote`

Each player submits their vote for who won. Either player can vote first. When both votes are in:
- Same winner → status transitions to `Retractable`, `retract_deadline = now + 15s`
- Different winners → status transitions to `Disputed`

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `voted_winner` | `Pubkey` | Must be either `player_a` or `player_b` |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | Must be in `Joined` or `Voting` status |
| `player` | ✓ | ✓ | Must be player_a or player_b — cannot vote twice |

---

### `retract_vote`

Allows either player to retract their vote while the wager is in `Retractable` status and before the `retract_deadline`. Returns wager to `Voting` status.

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | Must be `Retractable` and within deadline |
| `player` | ✓ | ✓ | Must be player_a or player_b |

---

### `resolve_wager`

Pays out 90% to winner and 10% to platform wallet using direct lamport manipulation. Closes the wager by setting `status = Resolved`.

**Fee Distribution:**
```
Total Pot      = stake_lamports × 2
Platform Fee   = Total Pot × 1000 / 10000  (10%)
Winner Payout  = Total Pot − Platform Fee  (90%)
```

**Resolution permissions by status:**

| Status | Who can resolve | Additional requirement |
|--------|----------------|----------------------|
| `Retractable` | Authority or either player | `retract_deadline` must have passed |
| `Disputed` | Authority only | — |
| `Voting` | Authority only | — |
| `Joined` | Authority only | — |

If `requires_moderator = true`, authority-only regardless of status.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `winner` | `Pubkey` | Must be player_a or player_b |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | |
| `winner` | ✓ | | Must match `winner` argument |
| `authorizer` | ✓ | ✓ | See permissions table above |
| `platform_wallet` | ✓ | | Must match `PLATFORM_WALLET_PUBKEY` |
| `system_program` | | | |

---

### `close_wager`

Cancels a wager and refunds stakes to both players (if not already resolved). Anchor `close = authorizer` returns rent to authorizer. Can be called by Player A, Player B, or the authority at any time.

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | Closed via `close = authorizer` |
| `player_a` | ✓ | | Must match `wager.player_a` |
| `player_b` | ✓ | | Must match `wager.player_b` (or default if none joined) |
| `authorizer` | ✓ | ✓ | Player A, Player B, or authority |
| `system_program` | | | |

---

## Account Structures

### `PlayerProfile`

PDA seeds: `["player", player_pubkey]` | Space: 128 bytes

```rust
pub struct PlayerProfile {
    pub player: Pubkey,        // 32 — owner wallet
    pub is_banned: bool,       // 1  — ban flag
    pub ban_expires_at: i64,   // 8  — unix timestamp (0 = indefinite)
    pub last_active: i64,      // 8  — last initialize_player call
    pub bump: u8,              // 1  — PDA bump seed
}
// Total used: 58 bytes | Allocated: 128 bytes
```

### `WagerAccount`

PDA seeds: `["wager", player_a_pubkey, match_id_le_bytes]` | Space: 320 bytes

```rust
pub struct WagerAccount {
    pub bump: u8,                        // 1
    pub player_a: Pubkey,                // 32
    pub player_b: Pubkey,                // 32 (default until joined)
    pub match_id: u64,                   // 8  — also used as PDA seed
    pub stake_lamports: u64,             // 8  — per-player stake
    pub lichess_game_id: String,         // 24 — max 20 chars
    pub status: WagerStatus,             // 1
    pub requires_moderator: bool,        // 1
    pub vote_player_a: Option<Pubkey>,   // 33
    pub vote_player_b: Option<Pubkey>,   // 33
    pub winner: Option<Pubkey>,          // 33 — set on resolution
    pub vote_timestamp: i64,             // 8  — first vote cast
    pub retract_deadline: i64,           // 8  — retract window end
    pub created_at: i64,                 // 8
    pub expires_at: i64,                 // 8  — join deadline (7 days)
    pub resolved_at: i64,                // 8
}
// Total used: ~215 bytes | Allocated: 320 bytes
```

### `WagerStatus` Enum

```rust
pub enum WagerStatus {
    Created,      // Player A deposited, awaiting Player B
    Joined,       // Both deposited, ready for voting
    Voting,       // At least one vote submitted
    Retractable,  // Both votes agree — retract window active
    Disputed,     // Votes conflict — authority must resolve
    Closed,       // Cancelled, funds refunded
    Resolved,     // Winner paid, PDA closed
}
```

---

## PDA Derivation

```typescript
// Player profile
const [playerProfilePDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("player"), playerPublicKey.toBuffer()],
  programId
);

// Wager account — match_id as little-endian u64
const matchIdBuffer = new Uint8Array(8);
new DataView(matchIdBuffer.buffer).setBigUint64(0, BigInt(matchId), true);

const [wagerPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("wager"), playerAPublicKey.toBuffer(), matchIdBuffer],
  programId
);
```

> The `match_id` used as a PDA seed comes from the Supabase `wagers.match_id` auto-increment column — this creates a deterministic, unique PDA for every wager without a separate on-chain registry.

---

## On-Chain Events

All events are emitted via Anchor's `emit!` macro and can be subscribed to via `program.addEventListener`.

| Event | Emitted By | Fields |
|---|---|---|
| `WagerCreated` | `create_wager` | wager_id, player_a, match_id, stake_lamports |
| `WagerJoined` | `join_wager` | wager_id, player_b, stake_lamports |
| `VoteSubmitted` | `submit_vote` | wager_id, player, voted_winner |
| `VoteRetracted` | `retract_vote` | wager_id, player |
| `WagerResolved` | `resolve_wager` | wager_id, winner, player_a, player_b, total_payout, platform_fee |
| `WagerClosed` | `close_wager` | wager_id, closed_by |
| `PlayerBanned` | `ban_player` | player, is_banned, ban_expires_at |

---

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | `InvalidStatus` | Invalid wager status for this instruction |
| 6001 | `Unauthorized` | Caller is not authorized |
| 6002 | `RetractPeriodNotExpired` | Cannot resolve — retract window still open |
| 6003 | `RetractExpired` | Retract window has already closed |
| 6004 | `InvalidAmount` | Stake is zero or doesn't match wager amount |
| 6005 | `InvalidMatchId` | Match ID must be > 0 |
| 6006 | `LichessGameIdTooLong` | Lichess game ID exceeds 20 characters |
| 6007 | `InvalidVote` | Vote does not name a valid participant |
| 6008 | `AlreadyVoted` | Player has already submitted a vote |
| 6009 | `InvalidWinner` | Winner pubkey is not a participant |
| 6010 | `InvalidPlayer` | Player is not authorized for this wager |
| 6011 | `PlayerBanned` | Player is currently banned |
| 6012 | `WagerExpired` | 7-day join window has passed |
| 6013 | `InvalidPlatformWallet` | Platform wallet doesn't match hardcoded constant |
| 6014 | `ArithmeticOverflow` | Integer overflow in fee calculation |
| 6015 | `InsufficientFunds` | Wager PDA has insufficient lamports |

---

## Security Model

### Authority

A single hardcoded `AUTHORITY_PUBKEY` constant in `lib.rs` governs all privileged operations. This eliminates the spoofable `UncheckedAccount` authority pattern — there is no way to pass an arbitrary account to satisfy the authority check. The authority keypair is required for:

- Banning/unbanning players
- Resolving disputes
- Force-resolving wagers stuck in `Voting` state
- Any wager where `requires_moderator = true`

> **Keep the authority keypair secure.** Loss or compromise allows arbitrary dispute resolution. Multi-sig upgrade is planned for mainnet.

### Platform Wallet

`PLATFORM_WALLET_PUBKEY` is enforced via an Anchor account constraint (`constraint = platform_wallet.key() == PLATFORM_WALLET_PUBKEY`) evaluated before instruction logic runs. The fee destination is fixed at program level and cannot be redirected at call time.

### Fund Safety

All lamport arithmetic uses Rust's checked operations (`checked_mul`, `checked_div`, `checked_sub`) to prevent overflow. A balance assertion (`wager_info.lamports() >= total_pot`) verifies the wager account holds sufficient funds before any transfer. Refunds in `close_wager` are issued per-player — a failed transfer to one player does not block the other. Rent recovery is handled exclusively by Anchor's `close = authorizer` constraint to prevent double-close issues.

### State Validation

`WagerStatus` transitions are validated in program logic before any state mutation. Invalid transitions (e.g. joining a `Voting` wager, resolving a `Created` wager) return `InvalidStatus` at the program level — not at the client level — making them impossible to bypass.

---

## NFT Trophy System

The repo includes a complete NFT trophy system built with Metaplex and Pinata/IPFS:

| Trophy Tier | Trigger | Image |
|---|---|---|
| Bronze | First victory | `trophies/bronze.png` |
| Silver | 5+ consecutive wins | `trophies/silver.png` |
| Gold | 10+ consecutive wins | `trophies/gold.png` |
| Diamond | 20+ consecutive wins | `trophies/diamond.png` |

Trophy URIs are stored in `src/config/trophy-uris.json` after upload. The `src/services/nft-mint.service.ts` handles Metaplex CandyMachine minting and the `src/utils/trophy-selector.ts` determines which tier a player has earned.

---

## Environment Setup

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) `>= 1.18`
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) `0.31.1`
- Node.js `>= 18`

### Install

```bash
git clone https://github.com/Web3ProdigyDev/gamegambit-sol.git
cd gamegambit-sol
npm install
```

### Environment Variables

Create `.env` in project root (gitignored):

```env
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_NETWORK=devnet
ANCHOR_PROGRAM_ID=E2Vd3U91kMrgwp8JCXcLSn7bt3NowDmGwoBYsVRhGfMR

# Optional — required for NFT minting tests
PINATA_JWT=your_pinata_jwt_token
PINATA_API_KEY=your_pinata_api_key
PINATA_SECRET_KEY=your_pinata_secret_key
PINATA_GATEWAY=https://gateway.pinata.cloud/ipfs
```

### Keypair Setup

Test keypairs live in `test-keys/` and are auto-generated on first run. Their pubkeys are printed to console. Fund them on devnet before running tests:

```bash
solana airdrop 2 <PLAYER_A_PUBKEY> --url devnet
solana airdrop 2 <PLAYER_B_PUBKEY> --url devnet
solana airdrop 2 <AUTHORITY_PUBKEY> --url devnet
```

> **Never commit keypair JSON files.** They are gitignored. Keep `authority-wallet.json` and `platform_wallet.json` outside the project directory in production.

### Build

```bash
anchor build
```

Generated artifacts:
- `target/idl/gamegambit.json` — IDL for client-side use
- `target/types/gamegambit.ts` — TypeScript types
- `target/deploy/gamegambit.so` — compiled BPF binary

### Deploy

```bash
anchor deploy --provider.cluster devnet
```

---

## Running Tests

The full test suite runs against Solana Devnet and requires funded wallets.

```bash
# Full wager flow (anchor test runner)
anchor test

# Core wager flow via ts-mocha directly
npm test

# Complete end-to-end flow with NFT minting
npx ts-mocha tests/complete-flow-with-nft.test.ts

# NFT integration only
npm run test:nft

# Pinata/IPFS upload
npm run test:pinata
```

### Test Coverage (`tests/gamegambit.ts`)

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
- Expired wager join attempt (expected failure)

Each test logs pre/post balances and Solana Explorer transaction links for devnet verification.

---

## Project Structure

```
programs/gamegambit/src/
  lib.rs                              # Full program — single file

target/
  idl/gamegambit.json                 # Generated IDL (do not edit manually)
  types/gamegambit.ts                 # Generated TypeScript types
  deploy/gamegambit.so                # Compiled BPF binary
  deploy/gamegambit-keypair.json      # Program keypair (gitignored)

tests/
  gamegambit.ts                       # Core wager flow tests
  complete-flow-with-nft.test.ts      # End-to-end with NFT minting
  nft-integration.test.ts             # NFT integration tests
  pinata.test.ts                      # IPFS upload tests

src/
  config/
    env.config.ts                     # Environment variable loader
    trophy-uris.json                  # Uploaded trophy IPFS URIs
  services/
    nft-mint.service.ts               # NFT minting via Metaplex
    pinata.service.ts                 # IPFS upload via Pinata
    pinata-with-trophies.service.ts   # Combined upload + mint
  utils/
    trophy-selector.ts                # Trophy tier selection logic
    wager-nft.helper.ts               # Wager NFT helper utilities

trophies/
  bronze.png                          # Trophy image assets
  silver.png
  gold.png
  diamond.png

test-keys/                            # Auto-generated test keypairs (gitignored)
  authority.json
  player_a.json
  player_b.json
  moderator.json
  match_id_counter.json

Anchor.toml                           # Anchor config — cluster: devnet
Cargo.toml                            # Rust dependencies — anchor-lang 0.31.1
tsconfig.json
```

---

## Related

- **UI & Full Architecture**: https://github.com/GameGambitDev/gamegambit
- **Live App**: https://thegamegambit.vercel.app
- **Program on Explorer**: [E2Vd3U91...](https://explorer.solana.com/address/E2Vd3U91kMrgwp8JCXcLSn7bt3NowDmGwoBYsVRhGfMR?cluster=devnet)

---

*Part of the GameGambit platform · March 2026*