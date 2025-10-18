import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Gamegambit } from "../target/types/gamegambit";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

describe("gamegambit", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Gamegambit as Program<Gamegambit>;
  const programId = program.programId;

  const keysDir = path.join(__dirname, "../test-keys");
  const playerAKeypath = path.join(keysDir, "player_a.json");
  const playerBKeypath = path.join(keysDir, "player_b.json");
  const authorityKeypath = path.join(keysDir, "authority.json");
  const moderatorKeypath = path.join(keysDir, "moderator.json");
  const counterPath = path.join(keysDir, "match_id_counter.json");

  let playerA: Keypair;
  let playerB: Keypair;
  let authority: Keypair;
  let moderator: Keypair;

  const STAKE_LAMPORTS = 0.01 * LAMPORTS_PER_SOL; // 10,000,000 lamports
  let matchIdCounter = 0;

  before(async () => {
    if (!fs.existsSync(keysDir)) {
      fs.mkdirSync(keysDir, { recursive: true });
      console.log(`ℹ️  Created test-keys directory: ${keysDir}`);
    }

    const loadOrGen = (keypath: string, name: string): Keypair => {
      if (fs.existsSync(keypath)) {
        console.log(`ℹ️  Loaded existing keypair for ${name}: ${path.basename(keypath)}`);
        return Keypair.fromSecretKey(
          Uint8Array.from(JSON.parse(fs.readFileSync(keypath, "utf-8")))
        );
      } else {
        console.log(`ℹ️  Generating new keypair for ${name}...`);
        const kp = Keypair.generate();
        fs.writeFileSync(keypath, JSON.stringify(Array.from(kp.secretKey)));
        console.log(`ℹ️  Generated and saved: ${path.basename(keypath)} (Pubkey: ${kp.publicKey.toBase58()})`);
        console.log(`💡 Fund this keypair manually: solana transfer ${kp.publicKey.toBase58()} 2 --allow-unfunded-recipient --cluster devnet`);
        return kp;
      }
    };

    playerA = loadOrGen(playerAKeypath, "Player A");
    playerB = loadOrGen(playerBKeypath, "Player B");
    authority = loadOrGen(authorityKeypath, "Authority");
    moderator = loadOrGen(moderatorKeypath, "Moderator");

    if (fs.existsSync(counterPath)) {
      matchIdCounter = parseInt(fs.readFileSync(counterPath, "utf-8"), 10);
      console.log(`ℹ️  Loaded matchIdCounter: ${matchIdCounter}`);
    } else {
      matchIdCounter = Math.floor(Date.now() / 1000);
      fs.writeFileSync(counterPath, matchIdCounter.toString());
      console.log(`ℹ️  Initialized matchIdCounter: ${matchIdCounter}`);
    }

    console.log(`\n💰 Pre-Test Balances (Devnet):`);
    console.log(`Player A: ${await provider.connection.getBalance(playerA.publicKey)} lamports`);
    console.log(`Player B: ${await provider.connection.getBalance(playerB.publicKey)} lamports`);
    console.log(`Authority: ${await provider.connection.getBalance(authority.publicKey)} lamports`);
    console.log(`Moderator: ${await provider.connection.getBalance(moderator.publicKey)} lamports`);
  });

  after(async () => {
    fs.writeFileSync(counterPath, matchIdCounter.toString());
    console.log(`ℹ️  Saved matchIdCounter: ${matchIdCounter}`);

    console.log(`\n💰 Post-Test Balances (Devnet):`);
    console.log(`Player A: ${await provider.connection.getBalance(playerA.publicKey)} lamports`);
    console.log(`Player B: ${await provider.connection.getBalance(playerB.publicKey)} lamports`);
    console.log(`Authority: ${await provider.connection.getBalance(authority.publicKey)} lamports`);
    console.log(`Moderator: ${await provider.connection.getBalance(moderator.publicKey)} lamports`);

    const initialStake = STAKE_LAMPORTS * 2;
    console.log(`\n📊 Test Summary: Deposited ${initialStake} lamports total; expect ~${initialStake} returned to winner minus tx fees.`);
  });

  const deriveWagerPDA = (playerA: PublicKey, matchId: number): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("wager"),
        playerA.toBuffer(),
        new anchor.BN(matchId).toArrayLike(Buffer, "le", 8),
      ],
      programId
    );
  };

  const derivePlayerPDA = (player: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("player"), player.toBuffer()],
      programId
    );
  };

  const executeAndLogTx = async (methodCall: any, description: string): Promise<string> => {
    const txId = await methodCall.rpc({ preflightCommitment: "confirmed" });
    console.log(`📝 ${description} Tx: https://explorer.solana.com/tx/${txId}?cluster=devnet`);
    return txId;
  };

  const tryCloseWager = async (wagerPDA: PublicKey, playerA: PublicKey, playerB: PublicKey, description: string) => {
    if (playerB.equals(PublicKey.default)) {
      console.log(`ℹ️  Skipping player_b transfer in ${description} (not joined)`);
    }
    try {
      await executeAndLogTx(
        program.methods
          .closeWager()
          .accounts({
            wager: wagerPDA,
            playerA,
            playerB: playerB.equals(PublicKey.default) ? playerA : playerB,
            authorizer: authority.publicKey,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority]),
        description
      );
    } catch (err) {
      console.log(`⚠️ Failed to close wager: ${err.message}`);
    }
  };

  it("Initializes players successfully", async () => {
    console.log("🧪 Testing: Initialize Player A");
    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);
    const txId = await executeAndLogTx(
      program.methods
        .initializePlayer()
        .accounts({
          playerProfile: playerAPDA,
          player: playerA.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([playerA]),
      "Initialized Player A"
    );
    console.log(`✅ Player A initialized: ${playerAPDA.toBase58()}`);

    console.log("🧪 Testing: Initialize Player B");
    const [playerBPDA] = derivePlayerPDA(playerB.publicKey);
    await executeAndLogTx(
      program.methods
        .initializePlayer()
        .accounts({
          playerProfile: playerBPDA,
          player: playerB.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([playerB]),
      "Initialized Player B"
    );
    console.log(`✅ Player B initialized: ${playerBPDA.toBase58()}`);
  });

  it("Creates a wager successfully (deposits 0.01 SOL)", async () => {
    console.log("🧪 Testing: Create Wager (Deposit)");
    const matchId = getNextMatchId();
    const lichessId = "testgame123";
    const requiresMod = false;

    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);

    const preBalanceA = await provider.connection.getBalance(playerA.publicKey);
    console.log(`   Pre-deposit balance A: ${preBalanceA} lamports`);

    try {
      await executeAndLogTx(
        program.methods
          .createWager(
            new anchor.BN(matchId),
            new anchor.BN(STAKE_LAMPORTS),
            lichessId,
            requiresMod
          )
          .accounts({
            wager: wagerPDA,
            playerAProfile: playerAPDA,
            playerA: playerA.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerA]),
        "Created Wager (A deposits)"
      );

      const postBalanceA = await provider.connection.getBalance(playerA.publicKey);
      console.log(`   Post-deposit balance A: ${postBalanceA} lamports (deposited ${STAKE_LAMPORTS})`);

      const wagerAccount = await program.account.wagerAccount.fetch(wagerPDA);
      console.log(`✅ Wager created: ${wagerPDA.toBase58()}`);
      console.log(`   - Status: ${JSON.stringify(wagerAccount.status)} (Created)`);
      console.log(`   - Stake: ${wagerAccount.stakeLamports.toString()} lamports (0.01 SOL)`);
      console.log(`   - Lichess ID: ${wagerAccount.lichessGameId}`);
      expect(postBalanceA).to.be.lessThan(preBalanceA);
      expect(wagerAccount.status).to.deep.equal({ created: {} });
    } finally {
      await tryCloseWager(wagerPDA, playerA.publicKey, PublicKey.default, "Closed Wager");
    }
  });

  it("Fails to create wager with invalid params", async () => {
    console.log("🧪 Testing: Invalid Wager Creation (zero stake)");
    const matchId = getNextMatchId();
    const lichessId = "toolong" + "a".repeat(21);
    const requiresMod = false;

    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);

    try {
      await program.methods
        .createWager(
          new anchor.BN(matchId),
          new anchor.BN(0),
          lichessId,
          requiresMod
        )
        .accounts({
          wager: wagerPDA,
          playerAProfile: playerAPDA,
          playerA: playerA.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([playerA])
        .rpc();
      throw new Error("Should have failed");
    } catch (err) {
      console.log(`✅ Expected error: ${err.message}`);
      expect(err.message).to.contain("InvalidAmount") || expect(err.message).to.contain("LichessGameIdTooLong");
    }
  });

  it("Joins a wager successfully (deposits 0.01 SOL)", async () => {
    console.log("🧪 Testing: Join Wager (Deposit)");
    const matchId = getNextMatchId();

    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);
    try {
      await executeAndLogTx(
        program.methods
          .createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "testgame123", false)
          .accounts({
            wager: wagerPDA,
            playerAProfile: playerAPDA,
            playerA: playerA.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerA]),
        "Created Wager (A deposits)"
      );

      const [playerBPDA] = derivePlayerPDA(playerB.publicKey);
      const preBalanceB = await provider.connection.getBalance(playerB.publicKey);
      console.log(`   Pre-deposit balance B: ${preBalanceB} lamports`);

      await executeAndLogTx(
        program.methods
          .joinWager(new anchor.BN(STAKE_LAMPORTS))
          .accounts({
            wager: wagerPDA,
            playerBProfile: playerBPDA,
            playerB: playerB.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerB]),
        "Joined Wager (B deposits)"
      );

      const postBalanceB = await provider.connection.getBalance(playerB.publicKey);
      console.log(`   Post-deposit balance B: ${postBalanceB} lamports (deposited ${STAKE_LAMPORTS})`);

      const wagerAccount = await program.account.wagerAccount.fetch(wagerPDA);
      console.log(`✅ Wager joined: Player B = ${wagerAccount.playerB.toBase58()}`);
      console.log(`   - Status: ${JSON.stringify(wagerAccount.status)} (Joined)`);
      expect(wagerAccount.playerB.toBase58()).to.equal(playerB.publicKey.toBase58());
      expect(wagerAccount.status).to.deep.equal({ joined: {} });
      expect(postBalanceB).to.be.lessThan(preBalanceB);
    } finally {
      await tryCloseWager(wagerPDA, playerA.publicKey, playerB.publicKey, "Closed Wager");
    }
  });

  it("Fails to join with mismatched stake", async () => {
    console.log("🧪 Testing: Join with Invalid Stake");
    const matchId = getNextMatchId();
    const mismatchStake = STAKE_LAMPORTS * 2;

    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);
    try {
      await executeAndLogTx(
        program.methods
          .createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "test", false)
          .accounts({
            wager: wagerPDA,
            playerAProfile: playerAPDA,
            playerA: playerA.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerA]),
        "Created Wager (A deposits)"
      );

      const [playerBPDA] = derivePlayerPDA(playerB.publicKey);

      try {
        await program.methods
          .joinWager(new anchor.BN(mismatchStake))
          .accounts({
            wager: wagerPDA,
            playerBProfile: playerBPDA,
            playerB: playerB.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerB])
          .rpc();
        throw new Error("Should have failed");
      } catch (err) {
        console.log(`✅ Expected error: ${err.message}`);
        expect(err.message).to.contain("InvalidAmount");
      }
    } finally {
      await tryCloseWager(wagerPDA, playerA.publicKey, PublicKey.default, "Closed Wager");
    }
  });

  it("Submits votes and agrees (retractable)", async () => {
    console.log("🧪 Testing: Vote Agreement");
    const matchId = getNextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);

    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);
    try {
      await executeAndLogTx(
        program.methods
          .createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "test", false)
          .accounts({
            wager: wagerPDA,
            playerAProfile: playerAPDA,
            playerA: playerA.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerA]),
        "Created Wager (A deposits)"
      );

      const [playerBPDA] = derivePlayerPDA(playerB.publicKey);
      await executeAndLogTx(
        program.methods
          .joinWager(new anchor.BN(STAKE_LAMPORTS))
          .accounts({
            wager: wagerPDA,
            playerBProfile: playerBPDA,
            playerB: playerB.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerB]),
        "Joined Wager (B deposits)"
      );

      await executeAndLogTx(
        program.methods
          .submitVote(playerA.publicKey)
          .accounts({
            wager: wagerPDA,
            player: playerA.publicKey,
          })
          .signers([playerA]),
        "Player A Vote"
      );

      await executeAndLogTx(
        program.methods
          .submitVote(playerA.publicKey)
          .accounts({
            wager: wagerPDA,
            player: playerB.publicKey,
          })
          .signers([playerB]),
        "Player B Vote (Agreement)"
      );

      const wagerAccount = await program.account.wagerAccount.fetch(wagerPDA);
      console.log(`✅ Votes agreed: Status = ${JSON.stringify(wagerAccount.status)} (Retractable)`);
      expect(wagerAccount.status).to.deep.equal({ retractable: {} });
      expect(wagerAccount.retractDeadline.toNumber()).to.be.greaterThan(Math.floor(Date.now() / 1000));
    } finally {
      await tryCloseWager(wagerPDA, playerA.publicKey, playerB.publicKey, "Closed Wager");
    }
  });

  it("Retracts vote successfully", async () => {
    console.log("🧪 Testing: Vote Retraction");
    const matchId = getNextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);

    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);
    try {
      await executeAndLogTx(
        program.methods
          .createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "test", false)
          .accounts({
            wager: wagerPDA,
            playerAProfile: playerAPDA,
            playerA: playerA.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerA]),
        "Created Wager (A deposits)"
      );

      const [playerBPDA] = derivePlayerPDA(playerB.publicKey);
      await executeAndLogTx(
        program.methods
          .joinWager(new anchor.BN(STAKE_LAMPORTS))
          .accounts({
            wager: wagerPDA,
            playerBProfile: playerBPDA,
            playerB: playerB.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerB]),
        "Joined Wager (B deposits)"
      );

      await executeAndLogTx(
        program.methods
          .submitVote(playerA.publicKey)
          .accounts({ wager: wagerPDA, player: playerA.publicKey })
          .signers([playerA]),
        "Player A Vote"
      );

      await executeAndLogTx(
        program.methods
          .submitVote(playerA.publicKey)
          .accounts({ wager: wagerPDA, player: playerB.publicKey })
          .signers([playerB]),
        "Player B Vote (Agreement)"
      );

      const wagerAccountBefore = await program.account.wagerAccount.fetch(wagerPDA);
      expect(wagerAccountBefore.status).to.deep.equal({ retractable: {} });

      await executeAndLogTx(
        program.methods
          .retractVote()
          .accounts({
            wager: wagerPDA,
            player: playerA.publicKey,
          })
          .signers([playerA]),
        "Vote Retraction"
      );

      const wagerAccount = await program.account.wagerAccount.fetch(wagerPDA);
      console.log(`✅ Vote retracted: Vote A = ${wagerAccount.votePlayerA ? wagerAccount.votePlayerA.toBase58() : "None"}`);
      expect(wagerAccount.votePlayerA).to.be.null;
      expect(wagerAccount.status).to.deep.equal({ voting: {} });
    } finally {
      await tryCloseWager(wagerPDA, playerA.publicKey, playerB.publicKey, "Closed Wager");
    }
  });

  it("Resolves wager via agreement (payout 0.02 SOL to winner)", async () => {
    console.log("🧪 Testing: Resolve via Agreement (Payout)");
    const matchId = getNextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);

    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);
    try {
      await executeAndLogTx(
        program.methods
          .createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "test", false)
          .accounts({
            wager: wagerPDA,
            playerAProfile: playerAPDA,
            playerA: playerA.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerA]),
        "Created Wager (A deposits)"
      );

      const [playerBPDA] = derivePlayerPDA(playerB.publicKey);
      await executeAndLogTx(
        program.methods
          .joinWager(new anchor.BN(STAKE_LAMPORTS))
          .accounts({
            wager: wagerPDA,
            playerBProfile: playerBPDA,
            playerB: playerB.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerB]),
        "Joined Wager (B deposits)"
      );

      await executeAndLogTx(
        program.methods
          .submitVote(playerA.publicKey)
          .accounts({ wager: wagerPDA, player: playerA.publicKey })
          .signers([playerA]),
        "Player A Vote"
      );

      await executeAndLogTx(
        program.methods
          .submitVote(playerA.publicKey)
          .accounts({ wager: wagerPDA, player: playerB.publicKey })
          .signers([playerB]),
        "Player B Vote (Agreement)"
      );

      const wagerAccount = await program.account.wagerAccount.fetch(wagerPDA);
      expect(wagerAccount.status).to.deep.equal({ retractable: {} });

      const retractDeadline = wagerAccount.retractDeadline.toNumber();
      const currentTime = Math.floor(Date.now() / 1000);
      if (currentTime <= retractDeadline) {
        const waitTime = (retractDeadline - currentTime + 1) * 1000;
        console.log(`ℹ️  Waiting ${waitTime}ms for retract deadline to expire`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      const preBalanceA = await provider.connection.getBalance(playerA.publicKey);
      const preBalanceB = await provider.connection.getBalance(playerB.publicKey);
      console.log(`   Pre-payout: A=${preBalanceA}, B=${preBalanceB} lamports`);

      await executeAndLogTx(
        program.methods
          .resolveWager(playerA.publicKey)
          .accounts({
            wager: wagerPDA,
            winner: playerA.publicKey,
            authorizer: playerA.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerA]),
        "Resolved Agreement (Payout to A)"
      );

      const postBalanceA = await provider.connection.getBalance(playerA.publicKey);
      const postBalanceB = await provider.connection.getBalance(playerB.publicKey);
      console.log(`   Post-payout: A=${postBalanceA} (gained ~${STAKE_LAMPORTS * 2}), B=${postBalanceB} (lost stake)`);

      expect(postBalanceA).to.be.greaterThan(preBalanceA);
      expect(postBalanceB).to.be.lessThanOrEqual(preBalanceB);
      console.log(`✅ Wager resolved: Full pot (0.02 SOL) paid to Player A`);
    } finally {
      await tryCloseWager(wagerPDA, playerA.publicKey, playerB.publicKey, "Closed Wager");
    }
  });

  it("Submits conflicting votes and resolves via moderator (payout 0.02 SOL to winner)", async () => {
    console.log("🧪 Testing: Dispute Resolution (Payout)");
    const matchId = getNextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);

    try {
      await executeAndLogTx(
        program.methods
          .createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "dispute", true)
          .accounts({ wager: wagerPDA, playerAProfile: playerAPDA, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
          .signers([playerA]),
        "Created Dispute Wager"
      );

      const [playerBPDA] = derivePlayerPDA(playerB.publicKey);
      await executeAndLogTx(
        program.methods
          .joinWager(new anchor.BN(STAKE_LAMPORTS))
          .accounts({ wager: wagerPDA, playerBProfile: playerBPDA, playerB: playerB.publicKey, systemProgram: SystemProgram.programId })
          .signers([playerB]),
        "Joined Dispute Wager"
      );

      await executeAndLogTx(
        program.methods.submitVote(playerA.publicKey).accounts({ wager: wagerPDA, player: playerA.publicKey }).signers([playerA]),
        "Conflicting Vote A"
      );
      await executeAndLogTx(
        program.methods.submitVote(playerB.publicKey).accounts({ wager: wagerPDA, player: playerB.publicKey }).signers([playerB]),
        "Conflicting Vote B"
      );

      const wagerAccount = await program.account.wagerAccount.fetch(wagerPDA);
      expect(wagerAccount.status).to.deep.equal({ disputed: {} });

      const preBalanceA = await provider.connection.getBalance(playerA.publicKey);
      const preBalanceB = await provider.connection.getBalance(playerB.publicKey);
      console.log(`   Pre-payout: A=${preBalanceA}, B=${preBalanceB} lamports`);

      await executeAndLogTx(
        program.methods
          .resolveWager(playerB.publicKey)
          .accounts({
            wager: wagerPDA,
            winner: playerB.publicKey,
            authorizer: moderator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([moderator]),
        "Resolved Dispute (Payout to B)"
      );

      const postBalanceA = await provider.connection.getBalance(playerA.publicKey);
      const postBalanceB = await provider.connection.getBalance(playerB.publicKey);
      console.log(`   Post-payout: A=${postBalanceA} (lost stake), B=${postBalanceB} (gained ~${STAKE_LAMPORTS * 2})`);

      expect(postBalanceB).to.be.greaterThan(preBalanceB);
      expect(postBalanceA).to.be.lessThanOrEqual(preBalanceA);
      console.log(`✅ Dispute resolved: Full pot (0.02 SOL) paid to Player B by moderator`);
    } finally {
      await tryCloseWager(wagerPDA, playerA.publicKey, playerB.publicKey, "Closed Wager");
    }
  });

  it("Fails resolution as unauthorized (non-mod)", async () => {
    console.log("🧪 Testing: Unauthorized Dispute Resolution");
    const matchId = getNextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);

    try {
      await executeAndLogTx(
        program.methods
          .createWager(new anchor.BN(matchId), new anchor.BN(STAKE_LAMPORTS), "unauth", true)
          .accounts({ wager: wagerPDA, playerAProfile: playerAPDA, playerA: playerA.publicKey, systemProgram: SystemProgram.programId })
          .signers([playerA]),
        "Created Wager (A deposits)"
      );

      const [playerBPDA] = derivePlayerPDA(playerB.publicKey);
      await executeAndLogTx(
        program.methods
          .joinWager(new anchor.BN(STAKE_LAMPORTS))
          .accounts({ wager: wagerPDA, playerBProfile: playerBPDA, playerB: playerB.publicKey, systemProgram: SystemProgram.programId })
          .signers([playerB]),
        "Joined Wager (B deposits)"
      );

      await executeAndLogTx(
        program.methods.submitVote(playerA.publicKey).accounts({ wager: wagerPDA, player: playerA.publicKey }).signers([playerA]),
        "Conflicting Vote A"
      );
      await executeAndLogTx(
        program.methods.submitVote(playerB.publicKey).accounts({ wager: wagerPDA, player: playerB.publicKey }).signers([playerB]),
        "Conflicting Vote B"
      );

      try {
        await program.methods
          .resolveWager(playerA.publicKey)
          .accounts({
            wager: wagerPDA,
            winner: playerA.publicKey,
            authorizer: playerA.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([playerA])
          .rpc();
        throw new Error("Should have failed");
      } catch (err) {
        console.log(`✅ Expected unauthorized error: ${err.message}`);
        expect(err.message).to.contain("Unauthorized");
      }
    } finally {
      await tryCloseWager(wagerPDA, playerA.publicKey, playerB.publicKey, "Closed Wager");
    }
  });

  it("Fails actions on banned player", async () => {
    console.log("🧪 Testing: Banned Player Restrictions");
    const [playerAPDA] = derivePlayerPDA(playerA.publicKey);

    await executeAndLogTx(
      program.methods
        .banPlayer(new anchor.BN(3600))
        .accounts({
          playerProfile: playerAPDA,
          authorizer: authority.publicKey,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority]),
      "Banned Player A"
    );

    const playerAProfile = await program.account.playerProfile.fetch(playerAPDA);
    expect(playerAProfile.isBanned).to.be.true;
    expect(playerAProfile.banExpiresAt.toNumber()).to.be.greaterThan(Math.floor(Date.now() / 1000));

    const matchId = getNextMatchId();
    const [wagerPDA] = deriveWagerPDA(playerA.publicKey, matchId);
    try {
      await program.methods
        .createWager(
          new anchor.BN(matchId),
          new anchor.BN(STAKE_LAMPORTS),
          "testgame123",
          false
        )
        .accounts({
          wager: wagerPDA,
          playerAProfile: playerAPDA,
          playerA: playerA.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([playerA])
        .rpc();
      throw new Error("Should have failed");
    } catch (err) {
      console.log(`✅ Expected error: ${err.message}`);
      expect(err.message).to.contain("PlayerBanned");
    }

    await executeAndLogTx(
      program.methods
        .banPlayer(new anchor.BN(0))
        .accounts({
          playerProfile: playerAPDA,
          authorizer: authority.publicKey,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority]),
      "Unbanned Player A"
    );

    const playerAProfileAfter = await program.account.playerProfile.fetch(playerAPDA);
    expect(playerAProfileAfter.isBanned).to.be.false;
    expect(playerAProfileAfter.banExpiresAt.toNumber()).to.equal(0);
  });

  const getNextMatchId = () => ++matchIdCounter;
});