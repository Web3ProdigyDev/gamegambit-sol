import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Gamegambit } from "../target/types/gamegambit";
import { PublicKey, SystemProgram, Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, mintTo, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// Metadata program ID (Metaplex Token Metadata on Devnet)
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Load keypairs from keys/ folder
const keysPath = path.resolve(__dirname, "../keys/");
const authorityKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(keysPath, "authority.json"), "utf8")))
);
const playerAKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(keysPath, "player_a.json"), "utf8")))
);
const playerBKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(keysPath, "player_b.json"), "utf8")))
);

// Counter to ensure unique match IDs across test runs
let matchIdCounter = Math.floor(Date.now() / 1000); // Use timestamp as a starting point

describe("gamegambit", () => {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(authorityKeypair),
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const program = anchor.workspace.Gamegambit as Program<Gamegambit>;

  let mint: PublicKey;
  let playerAToken: PublicKey;
  let playerBToken: PublicKey;
  let platformVaultToken: PublicKey;
  let escrowPda: PublicKey;
  let escrowTokenPda: PublicKey;

  before(async () => {
    const authority = authorityKeypair.publicKey;

    // Create mint
    if (!provider.wallet.payer) {
      throw new Error("Wallet payer is undefined");
    }
    console.log("Creating mint with payer:", provider.wallet.payer.publicKey.toBase58());
    mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      authorityKeypair.publicKey,
      null,
      9,
      undefined,
      { commitment: "confirmed" }
    );

    // Create associated token accounts
    [playerAToken, playerBToken, platformVaultToken] = await Promise.all([
      getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, mint, playerAKeypair.publicKey),
      getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, mint, playerBKeypair.publicKey),
      getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, mint, authorityKeypair.publicKey),
    ]).then((accounts) => [accounts[0].address, accounts[1].address, accounts[2].address]);

    // Mint tokens to player accounts
    await Promise.all([
      mintTo(provider.connection, provider.wallet.payer, mint, playerAToken, authorityKeypair.publicKey, 1_000_000_000),
      mintTo(provider.connection, provider.wallet.payer, mint, playerBToken, authorityKeypair.publicKey, 1_000_000_000),
    ]);

    // Log token balances for debugging
    const [playerABalance, playerBTokenBalance] = await Promise.all([
      provider.connection.getTokenAccountBalance(playerAToken),
      provider.connection.getTokenAccountBalance(playerBToken),
    ]);
    console.log("Initial Player A token balance:", playerABalance.value.uiAmount);
    console.log("Initial Player B token balance:", playerBTokenBalance.value.uiAmount);
  });

  it("Initializes an escrow", async () => {
    const amount = new anchor.BN(100_000_000); // 0.1 uiAmount per transfer
    const lichessGameId = "lichess123";
    const matchId = new anchor.BN(matchIdCounter++); // Increment counter for unique matchId

    // Derive PDAs
    [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        playerAKeypair.publicKey.toBuffer(),
        playerBKeypair.publicKey.toBuffer(),
        matchId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    [escrowTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token"), escrowPda.toBuffer()],
      program.programId
    );

    // Log derived PDAs for debugging
    console.log("Player A public key:", playerAKeypair.publicKey.toBase58());
    console.log("Player B public key:", playerBKeypair.publicKey.toBase58());
    console.log("Authority public key:", authorityKeypair.publicKey.toBase58());
    console.log("Escrow PDA (derived):", escrowPda.toBase58());
    console.log("Escrow Token PDA (derived):", escrowTokenPda.toBase58());
    console.log("Program ID:", program.programId.toBase58());

    // Initialize escrow
    let txSignature: string;
    try {
      txSignature = await program.methods
        .initializeEscrow(amount, lichessGameId, matchId)
        .accounts({
          escrow: escrowPda,
          escrowTokenAccount: escrowTokenPda,
          authority: authorityKeypair.publicKey,
          playerA: playerAKeypair.publicKey,
          playerB: playerBKeypair.publicKey,
          playerATokenAccount: playerAToken,
          playerBTokenAccount: playerBToken,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([authorityKeypair, playerAKeypair, playerBKeypair])
        .rpc();
      console.log("Initialize Escrow Signature:", txSignature);
      await connection.confirmTransaction(txSignature, "confirmed");
      console.log("Initialize Escrow Confirmation:", "Success");
    } catch (error) {
      console.error("Initialize Escrow failed:", error);
      throw error;
    }

    // Verify escrow state
    const escrow = await program.account.escrowState.fetch(escrowPda);
    console.log("Escrow state - amount:", escrow.amount.toString());
    console.log("Escrow state - playerA:", escrow.playerA.toBase58());
    console.log("Escrow state - playerB:", escrow.playerB.toBase58());
    console.log("Escrow state - lichessGameId:", escrow.lichessGameId);
    console.log("Escrow state - matchId:", escrow.matchId.toString());
    console.log("Escrow state - status:", JSON.stringify(escrow.status));
    assert.deepEqual(escrow.status, { initialized: {} });
    assert.equal(escrow.amount.toString(), amount.toString());
    assert.equal(escrow.playerA.toBase58(), playerAKeypair.publicKey.toBase58());
    assert.equal(escrow.playerB.toBase58(), playerBKeypair.publicKey.toBase58());
    assert.equal(escrow.lichessGameId, lichessGameId);
    assert.equal(escrow.matchId.toString(), matchId.toString());

    // Verify token balances
    const [playerABalance, playerBBalance, escrowTokenBalance] = await Promise.all([
      provider.connection.getTokenAccountBalance(playerAToken),
      provider.connection.getTokenAccountBalance(playerBToken),
      provider.connection.getTokenAccountBalance(escrowTokenPda),
    ]);
    console.log("Player A token balance after init:", playerABalance.value.uiAmount);
    console.log("Player B token balance after init:", playerBBalance.value.uiAmount);
    console.log("Escrow token balance after init:", escrowTokenBalance.value.uiAmount);
    assert.equal(playerABalance.value.uiAmount, 0.9); // 1 - 0.1
    assert.equal(playerBBalance.value.uiAmount, 0.9); // 1 - 0.1
    assert.equal(escrowTokenBalance.value.uiAmount, 0.2); // 0.1 + 0.1
  });

  it("Resolves the escrow", async () => {
    const matchId = new anchor.BN(matchIdCounter - 1); // Use the matchId from the previous test

    // Derive PDAs
    [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        playerAKeypair.publicKey.toBuffer(),
        playerBKeypair.publicKey.toBuffer(),
        matchId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    [escrowTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token"), escrowPda.toBuffer()],
      program.programId
    );

    // Log derived PDAs for debugging
    console.log("Escrow PDA (derived):", escrowPda.toBase58());
    console.log("Escrow Token PDA (derived):", escrowTokenPda.toBase58());

    // Resolve escrow (Player A wins)
    let txSignature: string;
    try {
      txSignature = await program.methods
        .resolveEscrow(playerAKeypair.publicKey)
        .accounts({
          escrow: escrowPda,
          escrowTokenAccount: escrowTokenPda,
          authority: authorityKeypair.publicKey,
          platformVault: platformVaultToken,
          winner: playerAKeypair.publicKey,
          winnerTokenAccount: playerAToken,
          playerA: playerAKeypair.publicKey,
          playerB: playerBKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([authorityKeypair])
        .rpc();
      console.log("Resolve Escrow Signature:", txSignature);
      await connection.confirmTransaction(txSignature, "confirmed");
      console.log("Resolve Escrow Confirmation:", "Success");
    } catch (error) {
      console.error("Resolve Escrow failed:", error);
      throw error;
    }

    // Verify escrow state
    const escrow = await program.account.escrowState.fetch(escrowPda);
    console.log("Escrow state - status:", JSON.stringify(escrow.status));
    assert.deepEqual(escrow.status, { completed: {} });

    // Verify token balances
    const [playerABalance, playerBBalance, escrowTokenBalance, platformVaultBalance] = await Promise.all([
      provider.connection.getTokenAccountBalance(playerAToken),
      provider.connection.getTokenAccountBalance(playerBToken),
      provider.connection.getTokenAccountBalance(escrowTokenPda),
      provider.connection.getTokenAccountBalance(platformVaultToken),
    ]);
    console.log("Player A token balance after resolve:", playerABalance.value.uiAmount);
    console.log("Player B token balance after resolve:", playerBBalance.value.uiAmount);
    console.log("Escrow token balance after resolve:", escrowTokenBalance.value.uiAmount);
    console.log("Platform vault token balance:", platformVaultBalance.value.uiAmount);
    assert.equal(playerABalance.value.uiAmount, 1.07); // 0.9 + 0.17 (0.2 - 0.03 fee)
    assert.equal(playerBBalance.value.uiAmount, 0.9); // No change
    assert.equal(escrowTokenBalance.value.uiAmount, 0); // Should be empty
    assert.equal(platformVaultBalance.value.uiAmount, 0.03); // 0.2 * 0.15 = 0.03
  });

  it("Forces a close", async () => {
    const amount = new anchor.BN(100_000_000); // 0.1 uiAmount per transfer
    const lichessGameId = "lichess456";
    const matchId = new anchor.BN(matchIdCounter++); // Increment counter for unique matchId

    // Derive PDAs for a new escrow
    [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        playerAKeypair.publicKey.toBuffer(),
        playerBKeypair.publicKey.toBuffer(),
        matchId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    [escrowTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token"), escrowPda.toBuffer()],
      program.programId
    );

    // Log derived PDAs for debugging
    console.log("New Escrow PDA (derived):", escrowPda.toBase58());
    console.log("New Escrow Token PDA (derived):", escrowTokenPda.toBase58());

    // Initialize a new escrow for force close test
    let txSignature: string;
    try {
      txSignature = await program.methods
        .initializeEscrow(amount, lichessGameId, matchId)
        .accounts({
          escrow: escrowPda,
          escrowTokenAccount: escrowTokenPda,
          authority: authorityKeypair.publicKey,
          playerA: playerAKeypair.publicKey,
          playerB: playerBKeypair.publicKey,
          playerATokenAccount: playerAToken,
          playerBTokenAccount: playerBToken,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([authorityKeypair, playerAKeypair, playerBKeypair])
        .rpc();
      console.log("Initialize Escrow for Force Close Signature:", txSignature);
      await connection.confirmTransaction(txSignature, "confirmed");
      console.log("Initialize Escrow for Force Close Confirmation:", "Success");
    } catch (error) {
      console.error("Initialize Escrow for Force Close failed:", error);
      throw error;
    }

    // Force close the new escrow
    try {
      txSignature = await program.methods
        .forceClose()
        .accounts({
          escrow: escrowPda,
          escrowTokenAccount: escrowTokenPda,
          authority: authorityKeypair.publicKey,
          playerA: playerAKeypair.publicKey,
          playerB: playerBKeypair.publicKey,
          playerATokenAccount: playerAToken,
          playerBTokenAccount: playerBToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([authorityKeypair])
        .rpc();
      console.log("Force Close Signature:", txSignature);
      await connection.confirmTransaction(txSignature, "confirmed");
      console.log("Force Close Confirmation:", "Success");
    } catch (error) {
      console.error("Force Close failed:", error);
      throw error;
    }

    // Verify escrow account is closed
    const escrowAccountInfo = await connection.getAccountInfo(escrowPda);
    console.log("Escrow account info after close:", escrowAccountInfo ? "Exists" : "Closed");
    assert.ok(escrowAccountInfo === null, "Escrow account should be closed");

    // Verify token balances (should be refunded) and escrow token account is closed
    const [playerABalance, playerBBalance, escrowTokenAccountInfo] = await Promise.all([
      provider.connection.getTokenAccountBalance(playerAToken),
      provider.connection.getTokenAccountBalance(playerBToken),
      provider.connection.getAccountInfo(escrowTokenPda),
    ]);
    console.log("Player A token balance after force close:", playerABalance.value.uiAmount);
    console.log("Player B token balance after force close:", playerBBalance.value.uiAmount);
    console.log("Escrow token account info after close:", escrowTokenAccountInfo ? "Exists" : "Closed");
    assert.equal(playerABalance.value.uiAmount, 1.07); // 1.07 from resolve_escrow, no net change
    assert.equal(playerBBalance.value.uiAmount, 0.9); // 0.9 from resolve_escrow, no net change
    assert.ok(escrowTokenAccountInfo === null, "Escrow token account should be closed");
  });

  it("Mints an NFT", async () => {
    // Derive metadata PDA
    const [metadata] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      METADATA_PROGRAM_ID
    );

    // Mint NFT
    let txSignature: string;
    try {
      txSignature = await program.methods
        .mintNft("GambitNFT", "GMT", "https://example.com/nft")
        .accounts({
          authority: authorityKeypair.publicKey,
          mint,
          metadata,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          metadataProgram: METADATA_PROGRAM_ID,
        })
        .signers([authorityKeypair])
        .rpc();
      console.log("Mint NFT Signature:", txSignature);
      await connection.confirmTransaction(txSignature, "confirmed");
      console.log("Mint NFT Confirmation:", "Success");
    } catch (error) {
      console.error("Mint NFT failed:", error);
      throw error;
    }

    // Verify metadata account exists
    const accountInfo = await provider.connection.getAccountInfo(metadata);
    console.log("Metadata account info:", accountInfo ? "Exists" : "Not Found");
    assert.ok(accountInfo, "Metadata account should exist");
  });
});