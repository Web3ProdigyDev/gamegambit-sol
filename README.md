# GameGambit — On-Chain Escrow Program

[![Solana Devnet](https://img.shields.io/badge/Solana-Devnet-9945FF?logo=solana)](https://explorer.solana.com/address/E2Vd3U91kMrgwp8JCXcLSn7bt3NowDmGwoBYsVRhGfMR?cluster=devnet)
[![Anchor](https://img.shields.io/badge/Anchor-0.31.1-512BD4)](https://anchor-lang.com)
[![Rust](https://img.shields.io/badge/Rust-2021-orange)](https://rust-lang.org)

Anchor/Rust smart contract for the [GameGambit](https://thegamegambit.vercel.app) trustless P2P gaming wager platform. Two players stake SOL on a gaming match. Funds lock in a program-derived escrow account. The authority verifies the winner and releases the pot — no middleman, no custody risk.

> **Client repo (frontend + Supabase edge functions):**
> 👉 **https://github.com/GameGambitDev/gamegambit**
>
> For the full product architecture, database schema, API reference, and deployment guide see the client repo above. This repo contains the on-chain program only.

---

## Table of Contents

- [Program Details](#program-details)
- [Devnet Transaction Proof](#devnet-transaction-proof)
- [Architecture Overview](#architecture-overview)
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
| **Wager Join Expiry** | 7 days |
| **WagerAccount size** | 160 bytes allocated (147 used) |
| **Authority** | `Ec7XfHbeDw1YmHzcGo3WrK73QnqQ3GL9VBczYGPCQJha` |
| **Platform Wallet** | `3hwPwugeuZ33HWJ3SoJkDN2JT3Be9fH62r19ezFiCgYY` |

---

## Devnet Transaction Proof

Real, finalized transactions on Solana Devnet:

| Instruction | Transaction | What Happened |
|---|---|---|
| `create_wager` | [`3rUc3Sb...`](https://explorer.solana.com/tx/3rUc3SbENp5UcnsLYs5AdZkPuknte4dhUYRFusxueFon7LRaSZxJvN3mBrzkQpcZEFHrJcVsHWdfcZrgLDbzG1Qf?cluster=devnet) | Player A staked 0.5 SOL into escrow PDA |
| `join_wager` | [`3tB5F8w...`](https://explorer.solana.com/tx/3tB5F8wZMkvFrfUqTw4WhrAmrohsktaxsHT7Z8iDc3wXjB54RbrDrBFt32boBRvnwek6bBVMRteachqPnMHuxnwf?cluster=devnet) | Player B matched stake — 1 SOL total locked in PDA |
| `resolve_wager` | [`4amRCjE...`](https://explorer.solana.com/tx/4amRCjEFo3NwfExitnbf5F8x9asyxaxYW1tjjG8AHBznHuxER4LjyDXXMeQnTraxYMLoXJGfgprZbDrGvRZwjPBu?cluster=devnet) | Winner got 0.9 SOL, platform took 0.1 SOL |
| `resolve_wager` | [`33Te8Vj...`](https://explorer.solana.com/tx/33Te8VjmqXkKJ9U3MfHRtEyVUC6TTE3H96YvyHZA6drswYw7g1RhbLRtMXskfbRQezvsiTQsP6h4p8YCcJ5v9k1n?cluster=devnet) | Additional resolved wager — 0.9 SOL payout |
| `close_wager` (draw) | [`63Z4uvP...`](https://explorer.solana.com/tx/63Z4uvPFpYdsMScowXQhfSk4uvfVs3hB2zBNrr2f7Jsst3odEUADFnsWXUV1TfGdu1yRWDmZ6USeGVjjYGdG3xhx?cluster=devnet) | Draw — both players refunded in full |
| `close_wager` (cancel) | [`2VyA5SF...`](https://explorer.solana.com/tx/2VyA5SFMqWSKeG68aY73aYQ4gd4zFe6C2W37zAMoXPtaevpdJAyudNfSwXhnBmpVaDvMXZ9B3ScxaoHKvrA3TDyM?cluster=devnet) | Cancelled wager — on-chain refund triggered |

---

## Architecture Overview

This repo is the **on-chain layer only**. The client repo handles everything else.

```
┌─────────────────────────────────────────────────────┐
│           gamegambit (client repo)                  │
│  https://github.com/GameGambitDev/gamegambit        │
│                                                     │
│  ┌──────────────┐   ┌──────────────────────────┐   │
│  │  Next.js UI  │   │  Supabase Edge Functions │   │
│  │              │   │  secure-wager            │   │
│  │  useSolana   │   │  resolve-wager           │   │
│  │  Program.ts  │   │  process-concession      │   │
│  │  ReadyRoom   │   │  process-verdict         │   │
│  │  Modal.tsx   │   │  admin-action            │   │
│  └──────┬───────┘   └──────────┬───────────────┘   │
│         │            Supabase DB (wagers table)     │
└─────────┼───────────────────────────────────────────┘
          │ Solana transactions
          ▼
┌─────────────────────────────────────────────────────┐
│       gamegambit-sol (this repo)                    │
│                                                     │
│   WagerAccount PDA      PlayerProfile PDA           │
│   create_wager          initialize_player           │
│   join_wager            ban_player                  │
│   resolve_wager                                     │
│   close_wager                                       │
└─────────────────────────────────────────────────────┘
```

**Design principle — minimal on-chain state.** The program stores only what is strictly necessary for trustless fund custody: player keys, stake amount, wager status, winner, and timestamps. All game metadata (lichess game IDs, vote history, moderator flags, stream URLs) lives exclusively in the Supabase `wagers` table in the client repo — no duplication between chain and DB.

**Voting and moderation are off-chain.** Player votes, dispute assignments, and moderator workflows are handled entirely in Supabase. The on-chain program has a single resolution path: the authority calls `resolve_wager` with a winner. How the authority determines the winner (Lichess API auto-detect, peer vote agreement, moderator decision) is the client layer's concern.

---

## Wager Lifecycle

```
Active ──────────────────────────────────► Settled
  │   (authority calls resolve_wager)
  │
  └──► close_wager (any time before Settled)
         Refunds stakes to both players
```

| Status | Description |
|--------|-------------|
| `Active` | Wager created or joined. Funds in escrow. Awaiting authority resolution. |
| `Settled` | Winner paid out (90%), platform fee collected (10%). |

> The Supabase `wagers` table maintains its own richer status string (`'created'`, `'joined'`, `'voting'`, `'disputed'`, `'retractable'`, `'resolved'`, `'cancelled'`) that drives the UI state machine. These are DB-only strings — completely independent of the on-chain `WagerStatus` enum.

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
| `match_id` | `u64` | Unique match identifier (must be > 0). Used as PDA seed. Sourced from `wagers.match_id` in Supabase. |
| `stake_lamports` | `u64` | Amount each player stakes (must be > 0). |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | PDA: `["wager", player_a, match_id_le]` — 160 bytes |
| `player_a_profile` | | | Must exist and not be banned |
| `player_a` | ✓ | ✓ | Wager creator |
| `system_program` | | | |

---

### `join_wager`

Player B joins an open wager by matching the exact stake amount. Player B cannot be the same wallet as Player A.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `stake_lamports` | `u64` | Must exactly match `wager.stake_lamports`. |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | Must be in `Active` status |
| `player_b_profile` | | | Must exist and not be banned |
| `player_b` | ✓ | ✓ | Cannot be same wallet as Player A |
| `system_program` | | | |

---

### `resolve_wager`

Authority-only. Pays out 90% to the winner and 10% to the platform wallet. Sets `status = Settled`.

**Fee Distribution:**
```
Total Pot     = stake_lamports × 2
Platform Fee  = Total Pot × 1000 / 10000  (10%)
Winner Payout = Total Pot − Platform Fee  (90%)
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `winner` | `Pubkey` | Must be `player_a` or `player_b`. |

**Accounts:**

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `wager` | ✓ | | Must be `Active` |
| `winner` | ✓ | | Must match `winner` argument |
| `authorizer` | ✓ | ✓ | Must match `AUTHORITY_PUBKEY` |
| `platform_wallet` | ✓ | | Must match `PLATFORM_WALLET_PUBKEY` |
| `system_program` | | | |

---

### `close_wager`

Cancels a wager and refunds stakes. If already `Settled`, no refund is issued — funds were already paid out. Can be called by Player A, Player B, or the authority. Anchor `close = authorizer` returns rent to the signer.

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

PDA seeds: `["wager", player_a_pubkey, match_id_le_bytes]` | Space: 160 bytes

```rust
pub struct WagerAccount {
    pub bump: u8,               // 1
    pub player_a: Pubkey,       // 32
    pub player_b: Pubkey,       // 32  (default pubkey until joined)
    pub match_id: u64,          // 8   — also used as PDA seed
    pub stake_lamports: u64,    // 8   — per-player stake
    pub status: WagerStatus,    // 1
    pub winner: Option<Pubkey>, // 33  (1 discriminant + 32)
    pub created_at: i64,        // 8
    pub expires_at: i64,        // 8   — read off-chain by Supabase
    pub resolved_at: i64,       // 8
}
// Total used: 147 bytes | Allocated: 160 bytes
```

> **Fields removed in this refactor** (now DB-only in the [client repo](https://github.com/GameGambitDev/gamegambit) `wagers` table):
> `lichess_game_id`, `requires_moderator`, `vote_player_a`, `vote_player_b`, `vote_timestamp`, `retract_deadline`
> — 107 bytes freed, ~0.00074 SOL saved in rent per wager account.

### `WagerStatus` Enum

```rust
pub enum WagerStatus {
    Active,   // Wager created or joined — awaiting resolution
    Settled,  // Winner paid, platform fee collected
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

> The `match_id` PDA seed comes from the Supabase `wagers.match_id` auto-increment column in the [client repo](https://github.com/GameGambitDev/gamegambit) — creating a deterministic, unique PDA per wager without a separate on-chain registry.

The full PDA derivation helper used by the frontend lives in [`src/hooks/useSolanaProgram.ts`](https://github.com/GameGambitDev/gamegambit/blob/main/src/hooks/useSolanaProgram.ts) in the client repo.

---

## On-Chain Events

All events are emitted via Anchor's `emit!` macro and can be subscribed to via `program.addEventListener`.

| Event | Emitted By | Fields |
|---|---|---|
| `WagerCreated` | `create_wager` | wager_id, player_a, match_id, stake_lamports |
| `WagerJoined` | `join_wager` | wager_id, player_b, stake_lamports |
| `WagerResolved` | `resolve_wager` | wager_id, winner, player_a, player_b, total_payout, platform_fee |
| `WagerClosed` | `close_wager` | wager_id, closed_by |
| `PlayerBanned` | `ban_player` | player, is_banned, ban_expires_at |

---

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | `InvalidStatus` | Invalid wager status for this instruction |
| 6001 | `Unauthorized` | Caller is not authorized |
| 6002 | `InvalidAmount` | Stake is zero or doesn't match wager amount |
| 6003 | `InvalidMatchId` | Match ID must be > 0 |
| 6004 | `InvalidWinner` | Winner pubkey is not a participant |
| 6005 | `InvalidPlayer` | Player is not authorized for this wager |
| 6006 | `PlayerBanned` | Player is currently banned |
| 6007 | `InvalidPlatformWallet` | Platform wallet doesn't match hardcoded constant |
| 6008 | `ArithmeticOverflow` | Integer overflow in fee calculation |
| 6009 | `InsufficientFunds` | Wager PDA has insufficient lamports |

---

## Security Model

### Authority

A single hardcoded `AUTHORITY_PUBKEY` constant in `lib.rs` governs all privileged operations. There is no way to pass an arbitrary account to satisfy the authority check. The authority is required for banning/unbanning players, resolving wagers, and force-closing wagers.

> **Keep the authority keypair secure.** Loss or compromise allows arbitrary dispute resolution. Multi-sig upgrade is planned for mainnet.

### Platform Wallet

`PLATFORM_WALLET_PUBKEY` is enforced via an Anchor account constraint evaluated before instruction logic runs. The fee destination is fixed at program level and cannot be redirected at call time.

### Fund Safety

All lamport arithmetic uses Rust's checked operations (`checked_mul`, `checked_div`, `checked_sub`) to prevent overflow. A balance assertion verifies the wager account holds sufficient funds before any transfer. Refunds in `close_wager` are issued per-player — a failed transfer to one player does not block the other. Rent recovery is handled by Anchor's `close = authorizer` constraint.

### State Validation

`WagerStatus` transitions are validated in program logic before any state mutation. Invalid transitions return `InvalidStatus` at the program level — not at the client level — making them impossible to bypass.

---

## NFT Trophy System

The repo includes a complete NFT trophy system built with Metaplex and Pinata/IPFS:

| Trophy Tier | Trigger | Image |
|---|---|---|
| Bronze | First victory | `trophies/bronze.png` |
| Silver | 5+ consecutive wins | `trophies/silver.png` |
| Gold | 10+ consecutive wins | `trophies/gold.png` |
| Diamond | 20+ consecutive wins | `trophies/diamond.png` |

Trophy URIs are stored in `src/config/trophy-uris.json` after upload. The `src/services/nft-mint.service.ts` handles Metaplex minting and `src/utils/trophy-selector.ts` determines which tier a player has earned.

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

Test keypairs are auto-generated in `test-keys/` on first run and gitignored. Fund them on devnet before running tests:

```bash
solana airdrop 2 <PLAYER_A_PUBKEY> --url devnet
solana airdrop 2 <PLAYER_B_PUBKEY> --url devnet
solana airdrop 2 <AUTHORITY_PUBKEY> --url devnet
```

> **Never commit keypair JSON files.** The authority keypair used in production should be stored outside the project directory and loaded via environment variable only.

### Build

```bash
anchor build
```

After building, copy the generated IDL to the client repo:

```bash
cp target/idl/gamegambit.json ../gamegambit/src/lib/idl/gamegambit.json
```

### Deploy

```bash
anchor deploy --provider.cluster devnet
```

After deploying, update `PROGRAM_ID` in both repos — see the [client repo](https://github.com/GameGambitDev/gamegambit) deployment guide for the full checklist.

---

## Running Tests

```bash
# Full wager flow
anchor test

# Core wager flow via ts-mocha directly
npm test

# End-to-end with NFT minting
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
- Authority resolution with 10% platform fee payout
- Force-close before join — Player A refunded only
- Force-close after join — both players refunded
- Ban and unban flow with wager restriction enforcement
- Unauthorised resolution attempt (expected failure)

Each test logs pre/post balances and Solana Explorer transaction links for devnet verification.

---

## Project Structure

```
programs/gamegambit/src/
  lib.rs                              # Full program — single file

target/
  idl/gamegambit.json                 # Generated IDL (copy to client repo after deploy)
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

test-keys/                            # Auto-generated on first test run (gitignored)

Anchor.toml                           # Anchor config — cluster: devnet
Cargo.toml                            # Rust dependencies — anchor-lang 0.31.1
tsconfig.json
```

---

## Related

| | |
|---|---|
| **Client repo** | https://github.com/GameGambitDev/gamegambit |
| **Live app** | https://thegamegambit.vercel.app |
| **Program on Explorer** | [E2Vd3U91...](https://explorer.solana.com/address/E2Vd3U91kMrgwp8JCXcLSn7bt3NowDmGwoBYsVRhGfMR?cluster=devnet) |

---

*Part of the GameGambit platform · April 2026*