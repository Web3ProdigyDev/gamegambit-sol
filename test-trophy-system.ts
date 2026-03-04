import { pinataServiceV2 } from './src/services/pinata-with-trophies.service';

async function testTrophySystem() {
  console.log('🧪 Testing Trophy NFT System...\n');

  const testWagers = [
    { name: 'Bronze', stakeLamports: 50_000_000 }, // 0.05 SOL
    { name: 'Silver', stakeLamports: 500_000_000 }, // 0.5 SOL
    { name: 'Gold', stakeLamports: 5_000_000_000 }, // 5 SOL
    { name: 'Diamond', stakeLamports: 50_000_000_000 }, // 50 SOL
  ];

  for (const test of testWagers) {
    console.log(`\n━━━ Testing ${test.name} Tier ━━━`);
    
    const mockWager = {
      wagerId: 'test_' + Date.now(),
      winner: 'EaXp7KjQUCBvXvqzVhNx8dGZqF3mYvMk9Yv7XYbcDZQ9',
      loser: 'FbYq8LkRVDCwYwrzWiOy9eHaqG4nZwNl0Zw8YZcdEaR0',
      stakeLamports: test.stakeLamports,
      lichessGameId: 'test_abc123',
      matchId: Math.floor(Math.random() * 1000),
      resolvedAt: new Date().toISOString(),
    };

    try {
      const result = await pinataServiceV2.createWagerNFT(mockWager);
      console.log('✅ Success!');
      console.log('   Tier:', result.tier);
      console.log('   Image:', result.imageUri);
      console.log('   Metadata:', result.metadataUri);
    } catch (error: any) {
      console.error('❌ Failed:', error.message);
    }
    
    // Wait 2 seconds between uploads
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n🎉 Trophy system test complete!');
}

testTrophySystem();
