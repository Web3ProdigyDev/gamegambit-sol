import { nftMintService } from './src/services/nft-mint.service';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';

async function testMint() {
  const authority = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync('test-keys/authority.json', 'utf-8')))
  );
  
  const winner = new PublicKey('YOUR_WALLET_ADDRESS_HERE');
  
  const wagerDetails = {
    wagerId: 'test_123',
    winner: winner.toString(),
    loser: 'FbYq8LkRVDCwYwrzWiOy9eHaqG4nZwNl0Zw8YZcdEaR0',
    stakeLamports: 500_000_000, // 0.5 SOL = Silver
    lichessGameId: 'test_game',
    matchId: 999,
    resolvedAt: new Date().toISOString(),
  };

  const result = await nftMintService.mintVictoryNFT(authority, winner, wagerDetails);
  console.log('NFT Minted:', result.mintAddress);
}

testMint();
