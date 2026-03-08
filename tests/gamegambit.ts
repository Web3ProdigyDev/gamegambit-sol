import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Gamegambit } from "../target/types/gamegambit";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

// Must match AUTHORITY_PUBKEY and PLATFORM_WALLET_PUBKEY in lib.rs exactly.
const AUTHORITY_PUBKEY = new PublicKey("Ec7XfHbeDw1YmHzcGo3WrK73QnqQ3GL9VBczYGPCQJha");
const PLATFORM_WALLET = new PublicKey("3hwPwugeuZ33HWJ3SoJkDN2JT3Be9fH62r19ezFiCgYY");

describe("gamegambit", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Gamegambit as Program<Gamegambit>;
  const programId = program.programId;

  const keysDir = path.join(__dirname, "../test-keys");
  const playerAKeypath = path.join(keysDir, "player_a.json");
  const playerBKeypath = path.join(keysDir, "player_b.json");
  const authorityKeypath = path.join(keysDir, "authority.json");
  const counterPath = path.join(keysDir, "match_id_counter.json");

  let playerA: Keypair;
  let playerB: Keypair;
  let authority: Keypair;

  const STAKE_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;
  let matchIdCounter = 0;

  // ── before ──────────────────────────────────────────────────────────────────

  before(async () => {
    if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });

    const loadOrGen = (keypath: string, name: string): Keypair => {
      if (fs.existsSync(keypath)) {
        console.log(`ℹ️  Loaded ${name}: ${path.basename(keypath)}`);
        return Keypair.fromSecretKey(
          Uint8Array.from(JSON.parse(fs.readFileSync(keypath, "utf-8")))
        );
      }
      const kp = Keypair.generate();
      fs.writeFileSync(keypath, JSON.stringify(Array.from(kp.secretKey)));
      console.log(`ℹ️  Generated ${name}: ${kp.publicKey.toBase58()}`);
      console.log(`💡 Fund: solana transfer ${kp.publicKey.toBase58()} 2 --allow-unfunded-recipient --url devnet`);
      return kp;
    };

    playerA = loadOrGen(playerAKeypath, "Player A");
    playerB = loadOrGen(playerBKeypath, "Player B");
    authority = loadOrGen(authorityKeypath, "Authority");

    if (!authority.publicKey.equals(AUTHORITY_PUBKEY)) {
      console.warn(
        `⚠️  WARNING: authority.json pubkey (${authority.publicKey.toBase58()}) ` +
        `does not match AUTHORITY_PUBKEY in lib.rs (${AUTHORITY_PUBKEY.toBase58()}). ` +
        `Copy the correct keypair to test-keys/authority.json.`
      );
    }

    // Always reset counter on each run to avoid "account already in use" errors.
    matchIdCounter = Math.floor(Date.now() / 1000);
    fs.writeFileSync(counterPath, matchIdCounter.toString());
    console.log(`ℹ️  Reset matchIdCounter: ${matchIdCounter}`);

    console.log(`\n💰 Pre-Test Balances:`);
    console.log(`   Player A:  ${await provider.connection.getBalance(playerA.publicKey)} lamports`);
    console.log(`   Player B:  ${await provider.connection.getBalance(playerB.publicKey)} lamports`);
    console.log(`   Authority: ${await provider.connection.getBalance(authority.publicKey)} lamports`);
  });

  // ── after ────────────────────────────────────────────────────────────────────

  after(async () => {
    fs.writeFileSync(counterPath, matchIdCounter.toString());
    console.log(`\n💰 Post-Test Balances:`);
    console.log(`   Player A:  ${await provider.connection.getBalance(playerA.publicKey)} lamports`);
    console.log(`   Player B:  ${await provider.connection.getBalance(playerB.publicKey)} lamports`);
    console.log(`   Authority: ${await provider.connection.getBalance(authority.publicKey)} lamports`);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const deriveWagerPDA = (playerAPub: PublicKey, matchId: number): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("wager"),
        playerAPub.toBuffer(),
        new anchor.BN(matchId).toArrayLike(Buffer, "le", 8),
      ],
      programId
    );

  const derivePlayerPDA = (player: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("player"), player.toBuffer()],
      programId
    );

  const logTx = async (call: any, label: string): Promise<string> => {
    const txId = await call.rpc({ preflightCommitment: "confirmed" });
    console.log(`   📝 ${label}: https://explorer.solana.com/tx/${txId}?cluster=devnet`);
    return txId;
  };

  // Safely close a wager — skips if the account no longer exists.
  // Pass playerA as playerB when player B never joined — the program skips
  // the refund when wager.player_b == Pubkey::default(), and passing playerA
  // satisfies the ConstraintMut requirement on the account.
  const tryClose = async (
    wagerPDA: PublicKey,
    playerAPub: PublicKey,
    playerBPub: PublicKey,
    label: string
  ) => {
    try {
      const info = await provider.connection.getAccountInfo(wagerPDA);
      if (!info) { console.log(`   ℹ️  Skip close (account gone): ${label}`); return; }
      await logTx(
        program.methods.closeWager().accounts({
          wager: wagerPDA,
          playerA: playerAPub,
          playerB: playerBPub,
          authorizer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        }).signers([authority]),
        label
      );
    } catch (err) {
      console.log(`   ⚠️  Close failed: ${err.message}`);
    }
  };

  const nextMatchId = () => ++matchIdCounter;

  // ── Tests ────────────────────────────────────────────────────────────────────

  it("Initializes players successfully", async () => {
    console.log("\n🧪 Initialize Players");
    const [pda_a] = derivePlayerPDA(playerA.publicKey);
    await logTx(
      program.methods.initializePlayer().accounts({
        playerProfile: pda_a,
        player: playerA.publicKey,
        systemProgram: SystemProgram.programId,
      }).signers([playerA]),
      "Init Player A"
    );

    const [pda_b] = derivePlayerPDA(playerB.publicKey);
    await logTx(
      program.methods.initializePlayer().accounts({
        playerProfile: pda_b,
        player: playerB.publicKey,
        systemProgram: SystemProgram.programId,
      }).signers([playerB]),
      "Init Player B"
    );

    const profile = await program.account.playerProfile.fetch(pda_a);
    expect(profile.player.toBase58()).to.equal(playerA.publicKey.toBase58());
    expect(profile.isBanned).to.be.false;
    console.log("   ✅ Players initialised");
  });

  it("Creates a wager successfully", async () => {
    console.log("\n🧪 Create Wager");
    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [pda_a] = derivePlayerPDA(playerA.publicKey);

    try {
      const preBal = await provider.connection.getBalance(playerA.publicKey);
      await logTx(
        program.methods
          .createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "testgame123", false)
          .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
          .signers([playerA]),
        "Create Wager"
      );

      const wager = await program.account.wagerAccount.fetch(wagerPDA);
      const postBal = await provider.connection.getBalance(playerA.publicKey);
      expect(wager.status).to.deep.equal({ created: {} });
      expect(wager.stakeLamports.toNumber()).to.equal(STAKE_LAMPORTS);
      expect(wager.expiresAt.toNumber()).to.be.greaterThan(Math.floor(Date.now() / 1000));
      expect(postBal).to.be.lessThan(preBal);
      console.log(`   ✅ Status=Created  expiresAt=${wager.expiresAt.toNumber()}`);
    } finally {
      // No player B joined — pass playerA as stand-in for playerB.
      await tryClose(wagerPDA, playerA.publicKey, playerA.publicKey, "Cleanup");
    }
  });

  it("Rejects wager creation with invalid params", async () => {
    console.log("\n🧪 Invalid Wager Params");
    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [pda_a] = derivePlayerPDA(playerA.publicKey);

    try {
      await program.methods
        .createWager(new anchor.BN(matchId), new anchor.BN(0), "test", false)
        .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerA]).rpc();
      throw new Error("Should have failed");
    } catch (err) {
      expect(err.message).to.contain("InvalidAmount");
      console.log("   ✅ Zero stake rejected");
    }

    try {
      await program.methods
        .createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "a".repeat(21), false)
        .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerA]).rpc();
      throw new Error("Should have failed");
    } catch (err) {
      expect(err.message).to.contain("LichessGameIdTooLong");
      console.log("   ✅ Long Lichess ID rejected");
    }
  });

  it("Joins a wager successfully", async () => {
    console.log("\n🧪 Join Wager");
    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [pda_a] = derivePlayerPDA(playerA.publicKey);
    const [pda_b] = derivePlayerPDA(playerB.publicKey);

    try {
      await logTx(
        program.methods.createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "testgame", false)
          .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
          .signers([playerA]), "Create");

      const preBal = await provider.connection.getBalance(playerB.publicKey);
      await logTx(
        program.methods.joinWager(new anchor.BN(STAKE_LAMPORTS))
          .accounts({ wager: wagerPDA, playerBProfile: pda_b, playerB: playerB.publicKey, systemProgram: SystemProgram.programId })
          .signers([playerB]), "Join");

      const wager = await program.account.wagerAccount.fetch(wagerPDA);
      const postBal = await provider.connection.getBalance(playerB.publicKey);
      expect(wager.status).to.deep.equal({ joined: {} });
      expect(wager.playerB.toBase58()).to.equal(playerB.publicKey.toBase58());
      expect(postBal).to.be.lessThan(preBal);
      console.log("   ✅ Status=Joined");
    } finally {
      await tryClose(wagerPDA, playerA.publicKey, playerB.publicKey, "Cleanup");
    }
  });

  it("Rejects join with mismatched stake", async () => {
    console.log("\n🧪 Mismatched Stake");
    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [pda_a] = derivePlayerPDA(playerA.publicKey);
    const [pda_b] = derivePlayerPDA(playerB.publicKey);

    try {
      await logTx(
        program.methods.createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "test", false)
          .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
          .signers([playerA]), "Create");

      try {
        await program.methods.joinWager(new anchor.BN(STAKE_LAMPORTS * 2))
          .accounts({ wager: wagerPDA, playerBProfile: pda_b, playerB: playerB.publicKey, systemProgram: SystemProgram.programId })
          .signers([playerB]).rpc();
        throw new Error("Should have failed");
      } catch (err) {
        expect(err.message).to.contain("InvalidAmount");
        console.log("   ✅ Mismatched stake rejected");
      }
    } finally {
      // No player B joined — pass playerA as stand-in for playerB.
      await tryClose(wagerPDA, playerA.publicKey, playerA.publicKey, "Cleanup");
    }
  });

  it("Submits agreeing votes → Retractable", async () => {
    console.log("\n🧪 Vote Agreement");
    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [pda_a] = derivePlayerPDA(playerA.publicKey);
    const [pda_b] = derivePlayerPDA(playerB.publicKey);

    try {
      await logTx(program.methods.createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "vote-test", false)
        .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerA]), "Create");
      await logTx(program.methods.joinWager(new anchor.BN(STAKE_LAMPORTS))
        .accounts({ wager: wagerPDA, playerBProfile: pda_b, playerB: playerB.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerB]), "Join");
      await logTx(program.methods.submitVote(playerA.publicKey)
        .accounts({ wager: wagerPDA, player: playerA.publicKey }).signers([playerA]), "Vote A");
      await logTx(program.methods.submitVote(playerA.publicKey)
        .accounts({ wager: wagerPDA, player: playerB.publicKey }).signers([playerB]), "Vote B");

      const wager = await program.account.wagerAccount.fetch(wagerPDA);
      expect(wager.status).to.deep.equal({ retractable: {} });
      expect(wager.retractDeadline.toNumber()).to.be.greaterThan(Math.floor(Date.now() / 1000));
      console.log(`   ✅ Status=Retractable  deadline=${wager.retractDeadline.toNumber()}`);
    } finally {
      await tryClose(wagerPDA, playerA.publicKey, playerB.publicKey, "Cleanup");
    }
  });

  it("Retracts a vote successfully", async () => {
    console.log("\n🧪 Vote Retraction");
    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [pda_a] = derivePlayerPDA(playerA.publicKey);
    const [pda_b] = derivePlayerPDA(playerB.publicKey);

    try {
      await logTx(program.methods.createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "retract", false)
        .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerA]), "Create");
      await logTx(program.methods.joinWager(new anchor.BN(STAKE_LAMPORTS))
        .accounts({ wager: wagerPDA, playerBProfile: pda_b, playerB: playerB.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerB]), "Join");
      await logTx(program.methods.submitVote(playerA.publicKey)
        .accounts({ wager: wagerPDA, player: playerA.publicKey }).signers([playerA]), "Vote A");
      await logTx(program.methods.submitVote(playerA.publicKey)
        .accounts({ wager: wagerPDA, player: playerB.publicKey }).signers([playerB]), "Vote B (agree)");
      await logTx(program.methods.retractVote()
        .accounts({ wager: wagerPDA, player: playerA.publicKey }).signers([playerA]), "Retract A");

      const wager = await program.account.wagerAccount.fetch(wagerPDA);
      expect(wager.votePlayerA).to.be.null;
      expect(wager.status).to.deep.equal({ voting: {} });
      console.log("   ✅ Vote retracted  Status=Voting");
    } finally {
      await tryClose(wagerPDA, playerA.publicKey, playerB.publicKey, "Cleanup");
    }
  });

  it("Resolves via agreement after retract window (10% platform fee)", async () => {
    console.log("\n🧪 Resolve via Agreement");
    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [pda_a] = derivePlayerPDA(playerA.publicKey);
    const [pda_b] = derivePlayerPDA(playerB.publicKey);

    try {
      await logTx(program.methods.createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "resolve", false)
        .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerA]), "Create");
      await logTx(program.methods.joinWager(new anchor.BN(STAKE_LAMPORTS))
        .accounts({ wager: wagerPDA, playerBProfile: pda_b, playerB: playerB.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerB]), "Join");
      await logTx(program.methods.submitVote(playerA.publicKey)
        .accounts({ wager: wagerPDA, player: playerA.publicKey }).signers([playerA]), "Vote A");
      await logTx(program.methods.submitVote(playerA.publicKey)
        .accounts({ wager: wagerPDA, player: playerB.publicKey }).signers([playerB]), "Vote B");

      const wager = await program.account.wagerAccount.fetch(wagerPDA);
      expect(wager.status).to.deep.equal({ retractable: {} });

      const deadline = wager.retractDeadline.toNumber();
      const now = Math.floor(Date.now() / 1000);
      if (now <= deadline) {
        const wait = (deadline - now + 2) * 1000;
        console.log(`   ⏳ Waiting ${wait}ms for retract window...`);
        await new Promise((r) => setTimeout(r, wait));
      }

      const preBal_a = await provider.connection.getBalance(playerA.publicKey);
      const preBal_plat = await provider.connection.getBalance(PLATFORM_WALLET);

      await logTx(
        program.methods.resolveWager(playerA.publicKey).accounts({
          wager: wagerPDA,
          winner: playerA.publicKey,
          authorizer: playerA.publicKey,
          platformWallet: PLATFORM_WALLET,
          systemProgram: SystemProgram.programId,
        }).signers([playerA]),
        "Resolve (Player A)"
      );

      const postBal_a = await provider.connection.getBalance(playerA.publicKey);
      const postBal_plat = await provider.connection.getBalance(PLATFORM_WALLET);
      expect(postBal_a).to.be.greaterThan(preBal_a);
      expect(postBal_plat - preBal_plat).to.be.approximately(STAKE_LAMPORTS * 2 * 0.1, 0.001 * LAMPORTS_PER_SOL);
      console.log("   ✅ Winner received 90%  Platform received 10%");
    } finally {
      await tryClose(wagerPDA, playerA.publicKey, playerB.publicKey, "Cleanup");
    }
  });

  it("Authority resolves in Voting state (10% platform fee)", async () => {
    console.log("\n🧪 Authority Force-Resolve (Voting State)");
    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [pda_a] = derivePlayerPDA(playerA.publicKey);
    const [pda_b] = derivePlayerPDA(playerB.publicKey);

    try {
      await logTx(program.methods.createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "force", false)
        .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerA]), "Create");
      await logTx(program.methods.joinWager(new anchor.BN(STAKE_LAMPORTS))
        .accounts({ wager: wagerPDA, playerBProfile: pda_b, playerB: playerB.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerB]), "Join");

      // Submit one vote to move status from Joined → Voting.
      // Authority can force-resolve from Voting state.
      await logTx(program.methods.submitVote(playerA.publicKey)
        .accounts({ wager: wagerPDA, player: playerA.publicKey }).signers([playerA]),
        "Vote A (triggers Voting status)");

      const preBal_a = await provider.connection.getBalance(playerA.publicKey);
      const preBal_plat = await provider.connection.getBalance(PLATFORM_WALLET);

      await logTx(
        program.methods.resolveWager(playerA.publicKey).accounts({
          wager: wagerPDA,
          winner: playerA.publicKey,
          authorizer: authority.publicKey,
          platformWallet: PLATFORM_WALLET,
          systemProgram: SystemProgram.programId,
        }).signers([authority]),
        "Force-Resolve"
      );

      const postBal_a = await provider.connection.getBalance(playerA.publicKey);
      const postBal_plat = await provider.connection.getBalance(PLATFORM_WALLET);
      expect(postBal_a).to.be.greaterThan(preBal_a);
      expect(postBal_plat - preBal_plat).to.be.approximately(STAKE_LAMPORTS * 2 * 0.1, 0.001 * LAMPORTS_PER_SOL);
      console.log("   ✅ Authority force-resolved  Winner=A  Platform=10%");
    } finally {
      await tryClose(wagerPDA, playerA.publicKey, playerB.publicKey, "Cleanup");
    }
  });

  it("Resolves disputed wager via authority", async () => {
    console.log("\n🧪 Dispute Resolution");
    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [pda_a] = derivePlayerPDA(playerA.publicKey);
    const [pda_b] = derivePlayerPDA(playerB.publicKey);

    try {
      await logTx(program.methods.createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "dispute", true)
        .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerA]), "Create (requires_moderator=true)");
      await logTx(program.methods.joinWager(new anchor.BN(STAKE_LAMPORTS))
        .accounts({ wager: wagerPDA, playerBProfile: pda_b, playerB: playerB.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerB]), "Join");
      await logTx(program.methods.submitVote(playerA.publicKey)
        .accounts({ wager: wagerPDA, player: playerA.publicKey }).signers([playerA]), "Vote A (self)");
      await logTx(program.methods.submitVote(playerB.publicKey)
        .accounts({ wager: wagerPDA, player: playerB.publicKey }).signers([playerB]), "Vote B (self)");

      const wagerMid = await program.account.wagerAccount.fetch(wagerPDA);
      expect(wagerMid.status).to.deep.equal({ disputed: {} });

      const preBal_b = await provider.connection.getBalance(playerB.publicKey);
      const preBal_plat = await provider.connection.getBalance(PLATFORM_WALLET);

      await logTx(
        program.methods.resolveWager(playerB.publicKey).accounts({
          wager: wagerPDA,
          winner: playerB.publicKey,
          authorizer: authority.publicKey,
          platformWallet: PLATFORM_WALLET,
          systemProgram: SystemProgram.programId,
        }).signers([authority]),
        "Resolve Dispute (authority, B wins)"
      );

      const postBal_b = await provider.connection.getBalance(playerB.publicKey);
      const postBal_plat = await provider.connection.getBalance(PLATFORM_WALLET);
      expect(postBal_b).to.be.greaterThan(preBal_b);
      expect(postBal_plat).to.be.greaterThan(preBal_plat);
      console.log("   ✅ Dispute resolved  Winner=B  Platform=10%");
    } finally {
      await tryClose(wagerPDA, playerA.publicKey, playerB.publicKey, "Cleanup");
    }
  });

  it("Rejects resolution by non-authority in disputed wager", async () => {
    console.log("\n🧪 Unauthorised Dispute Resolution");
    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [pda_a] = derivePlayerPDA(playerA.publicKey);
    const [pda_b] = derivePlayerPDA(playerB.publicKey);

    try {
      await logTx(program.methods.createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "unauth", true)
        .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerA]), "Create");
      await logTx(program.methods.joinWager(new anchor.BN(STAKE_LAMPORTS))
        .accounts({ wager: wagerPDA, playerBProfile: pda_b, playerB: playerB.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerB]), "Join");
      await logTx(program.methods.submitVote(playerA.publicKey)
        .accounts({ wager: wagerPDA, player: playerA.publicKey }).signers([playerA]), "Vote A");
      await logTx(program.methods.submitVote(playerB.publicKey)
        .accounts({ wager: wagerPDA, player: playerB.publicKey }).signers([playerB]), "Vote B");

      try {
        await program.methods.resolveWager(playerA.publicKey).accounts({
          wager: wagerPDA,
          winner: playerA.publicKey,
          authorizer: playerA.publicKey,
          platformWallet: PLATFORM_WALLET,
          systemProgram: SystemProgram.programId,
        }).signers([playerA]).rpc();
        throw new Error("Should have failed");
      } catch (err) {
        expect(err.message).to.contain("Unauthorized");
        console.log("   ✅ Non-authority rejected");
      }
    } finally {
      await tryClose(wagerPDA, playerA.publicKey, playerB.publicKey, "Cleanup");
    }
  });

  it("Bans player, blocks wager creation, then unbans", async () => {
    console.log("\n🧪 Ban / Unban Flow");
    const [pda_a] = derivePlayerPDA(playerA.publicKey);

    await logTx(
      program.methods.banPlayer(new anchor.BN(3600)).accounts({
        playerProfile: pda_a,
        authorizer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      }).signers([authority]),
      "Ban Player A (1h)"
    );

    let profile = await program.account.playerProfile.fetch(pda_a);
    expect(profile.isBanned).to.be.true;
    expect(profile.banExpiresAt.toNumber()).to.be.greaterThan(Math.floor(Date.now() / 1000));

    const matchId = nextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    try {
      await program.methods
        .createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "banned", false)
        .accounts({ wager: wagerPDA, playerAProfile: pda_a, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
        .signers([playerA]).rpc();
      throw new Error("Should have failed");
    } catch (err) {
      expect(err.message).to.contain("PlayerBanned");
      console.log("   ✅ Banned player blocked from creating wager");
    }

    await logTx(
      program.methods.banPlayer(new anchor.BN(0)).accounts({
        playerProfile: pda_a,
        authorizer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      }).signers([authority]),
      "Unban Player A"
    );

    profile = await program.account.playerProfile.fetch(pda_a);
    expect(profile.isBanned).to.be.false;
    expect(profile.banExpiresAt.toNumber()).to.equal(0);
    console.log("   ✅ Player unbanned");
  });
});

console.log("\n✅ ALL TESTS COMPLETED");