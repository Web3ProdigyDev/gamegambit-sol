import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createCreateMetadataAccountV3Instruction,
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
} from '@metaplex-foundation/mpl-token-metadata';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { pinataServiceV2, WagerDetails } from './pinata-with-trophies.service';
import { getSolanaConfig } from '../config/env.config';

export class NFTMintService {
  private connection: Connection;

  constructor(connection?: Connection) {
    const config = getSolanaConfig();
    this.connection = connection || new Connection(config.rpcUrl, 'confirmed');
  }

  async mintVictoryNFT(
    payer: Keypair,
    winner: PublicKey,
    wagerDetails: WagerDetails
  ): Promise<{ mintAddress: string; metadataUri: string; signature: string }> {
    try {
      console.log('\n🎨 Starting NFT minting process...');

      const { metadataUri, tier } = await pinataServiceV2.createWagerNFT(wagerDetails);
      console.log(`✅ Using ${tier.toUpperCase()} tier trophy`);

      const mint = await createMint(
        this.connection,
        payer,
        payer.publicKey,
        null,
        0,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      console.log('✅ Mint created:', mint.toBase58());

      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        payer,
        mint,
        winner
      );

      await mintTo(
        this.connection,
        payer,
        mint,
        tokenAccount.address,
        payer.publicKey,
        1
      );
      console.log('✅ NFT minted to winner');

      const signature = await this.createMetadataAccount(payer, mint, metadataUri, wagerDetails);

      console.log(`\n🎉 View: https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`);

      return {
        mintAddress: mint.toBase58(),
        metadataUri,
        signature,
      };
    } catch (error) {
      console.error('❌ Error minting NFT:', error);
      throw error;
    }
  }

  private async createMetadataAccount(
    payer: Keypair,
    mint: PublicKey,
    metadataUri: string,
    wagerDetails: WagerDetails
  ): Promise<string> {
    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );

    const instruction = createCreateMetadataAccountV3Instruction(
      {
        metadata: metadataPDA,
        mint: mint,
        mintAuthority: payer.publicKey,
        payer: payer.publicKey,
        updateAuthority: payer.publicKey,
      },
      {
        createMetadataAccountArgsV3: {
          data: {
            name: `GameGambit Victory #${wagerDetails.matchId}`,
            symbol: 'GGWIN',
            uri: metadataUri,
            sellerFeeBasisPoints: 500,
            creators: [
              {
                address: payer.publicKey,
                verified: true,
                share: 100,
              },
            ],
            collection: null,
            uses: null,
          },
          isMutable: true,
          collectionDetails: null,
        },
      }
    );

    const transaction = new Transaction().add(instruction);
    return await sendAndConfirmTransaction(this.connection, transaction, [payer]);
  }
}

export const nftMintService = new NFTMintService();
