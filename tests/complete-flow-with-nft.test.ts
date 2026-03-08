import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Gamegambit } from "../target/types/gamegambit";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { nftMintService } from "../src/services/nft-mint.service";
import * as fs from "fs";

// Must match AUTHORITY_PUBKEY and PLATFORM_WALLET_PUBKEY in lib.rs exactly.
const PLATFORM_WALLET = new PublicKey("3hwPwugeuZ33HWJ3SoJkDN2JT3Be9fH62r19ezFiCgYY");

describe("Complete Wager Flow with NFT Minting", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Gamegambit as Program<Gamegambit>;

  // Keypairs declared here, loaded inside before() so the suite doesn't
  // crash at module-load time when test-keys/ doesn't exist yet.
  let authority: Keypair;
  let playerA: Keypair;
  let playerB: Keypair;

  before(() => {
    authority = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync("test-keys/authority.json", "utf-8")))
    );
    playerA = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync("test-keys/player_a.json", "utf-8")))
    );
    playerB = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync("test-keys/player_b.json", "utf-8")))
    );
  });

  it("Complete flow: Create wager → Resolve → Mint NFT", async () => {
    const matchId = Date.now();
    const stakeLamports = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
    const lichessGameId = `nft${matchId.toString().slice(-8)}`;

    console.log("\n🎮 Starting complete wager flow with NFT minting...\n");

    // ── Step 1: Initialize players ───────────────────────────────────────────
    console.log("1️⃣ Initializing players...");
    const [playerAProfile] = PublicKey.findProgramAddressSync(
      [Buffer.from("player"), playerA.publicKey.toBuffer()],
      program.programId
    );
    const [playerBProfile] = PublicKey.findProgramAddressSync(
      [Buffer.from("player"), playerB.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .initializePlayer()
      .accounts({ playerProfile: playerAProfile, player: playerA.publicKey, systemProgram: SystemProgram.programId })
      .signers([playerA])
      .rpc();

    await program.methods
      .initializePlayer()
      .accounts({ playerProfile: playerBProfile, player: playerB.publicKey, systemProgram: SystemProgram.programId })
      .signers([playerB])
      .rpc();

    console.log("✅ Players initialized\n");

    // ── Step 2: Create wager ─────────────────────────────────────────────────
    console.log("2️⃣ Creating wager...");
    const [wagerPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("wager"),
        playerA.publicKey.toBuffer(),
        new anchor.BN(matchId).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .createWager(new anchor.BN(matchId), stakeLamports, lichessGameId, false)
      .accounts({
        wager: wagerPda,
        playerAProfile,
        playerA: playerA.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([playerA])
      .rpc();

    console.log("✅ Wager created\n");

    // ── Step 3: Player B joins ───────────────────────────────────────────────
    console.log("3️⃣ Player B joining...");
    await program.methods
      .joinWager(stakeLamports)
      .accounts({
        wager: wagerPda,
        playerBProfile,
        playerB: playerB.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([playerB])
      .rpc();

    console.log("✅ Player B joined\n");

    // ── Step 4: Both vote ────────────────────────────────────────────────────
    console.log("4️⃣ Submitting votes...");
    await program.methods
      .submitVote(playerA.publicKey)
      .accounts({ wager: wagerPda, player: playerA.publicKey })
      .signers([playerA])
      .rpc();

    await program.methods
      .submitVote(playerA.publicKey)
      .accounts({ wager: wagerPda, player: playerB.publicKey })
      .signers([playerB])
      .rpc();

    console.log("✅ Votes submitted (both agree Player A wins)\n");

    // ── Step 5: Wait for retract window ─────────────────────────────────────
    console.log("5️⃣ Waiting for retract period (16 seconds)...");
    await new Promise((resolve) => setTimeout(resolve, 16000));

    // ── Step 6: Resolve ──────────────────────────────────────────────────────
    console.log("6️⃣ Resolving wager...");

    // Player A resolves after the retract window.
    // platformWallet must match PLATFORM_WALLET_PUBKEY constant in lib.rs.
    // The `authority` account no longer exists in ResolveWager context.
    await program.methods
      .resolveWager(playerA.publicKey)
      .accounts({
        wager: wagerPda,
        winner: playerA.publicKey,
        authorizer: playerA.publicKey,
        platformWallet: PLATFORM_WALLET,
        systemProgram: SystemProgram.programId,
      })
      .signers([playerA])
      .rpc();

    console.log("✅ Wager resolved — Player A wins!\n");
    console.log("💰 Payout: Winner got 90%, Platform got 10%\n");

    // ── Step 7: Fetch wager data and mint NFT ────────────────────────────────
    console.log("7️⃣ Minting victory NFT...");
    const wagerAccount = await program.account.wagerAccount.fetch(wagerPda);

    const wagerDetails = {
      wagerId: wagerPda.toString(),
      winner: wagerAccount.winner.toString(),
      loser: wagerAccount.playerB.toString(),
      stakeLamports: wagerAccount.stakeLamports.toNumber(),
      lichessGameId: wagerAccount.lichessGameId,
      matchId: wagerAccount.matchId.toNumber(),
      resolvedAt: new Date(wagerAccount.resolvedAt.toNumber() * 1000).toISOString(),
    };

    const nftResult = await nftMintService.mintVictoryNFT(
      authority,
      wagerAccount.winner,
      wagerDetails
    );

    console.log("\n🎊 SUCCESS! Complete flow finished!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📋 Results:");
    console.log(`   Wager:           ${wagerPda.toString()}`);
    console.log(`   Winner:          ${wagerAccount.winner.toString()}`);
    console.log(`   Stake:           ${wagerAccount.stakeLamports.toNumber() / LAMPORTS_PER_SOL} SOL`);
    console.log(`   Winner Received: ${(wagerAccount.stakeLamports.toNumber() * 2 * 0.9) / LAMPORTS_PER_SOL} SOL (90%)`);
    console.log(`   Platform Fee:    ${(wagerAccount.stakeLamports.toNumber() * 2 * 0.1) / LAMPORTS_PER_SOL} SOL (10%)`);
    console.log(`   NFT Mint:        ${nftResult.mintAddress}`);
    console.log(`   Metadata:        ${nftResult.metadataUri}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\n🔗 View NFT on Solana Explorer:");
    console.log(`https://explorer.solana.com/address/${nftResult.mintAddress}?cluster=devnet`);
    console.log("\n🔗 View in Phantom Wallet:");
    console.log(`Import wallet: ${playerA.publicKey.toString()}`);
    console.log('Then check the "Collectibles" tab');
  }).timeout(120000);
});