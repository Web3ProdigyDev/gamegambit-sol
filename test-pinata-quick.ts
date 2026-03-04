import { pinataService } from './src/services/pinata.service';

async function testPinata() {
  console.log('🧪 Testing Pinata Integration...\n');

  try {
    console.log('1️⃣ Testing connection...');
    const connected = await pinataService.testConnection();

    if (!connected) {
      console.log('\n⚠️  Check your .env file');
      process.exit(1);
    }

    console.log('\n2️⃣ Creating test NFT metadata...');
    const mockWager = {
      wagerId: 'test_' + Date.now(),
      winner: 'EaXp7KjQUCBvXvqzVhNx8dGZqF3mYvMk9Yv7XYbcDZQ9',
      loser: 'FbYq8LkRVDCwYwrzWiOy9eHaqG4nZwNl0Zw8YZcdEaR0',
      stakeLamports: 150000000,
      lichessGameId: 'test_abc123',
      matchId: 42,
      resolvedAt: new Date().toISOString(),
    };

    const result = await pinataService.createWagerNFT(mockWager);

    console.log('\n✅ NFT Metadata Created Successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🖼️  Image URI:', result.imageUri);
    console.log('📄 Metadata URI:', result.metadataUri);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n🔗 View your NFT:');
    console.log('   Image:', result.imageUri);
    console.log('   Metadata:', result.metadataUri);

    console.log('\n3️⃣ Listing recent uploads...');
    const files = await pinataService.listPinnedFiles(5);
    console.log(`📋 Total pinned files: ${files.count}`);

    console.log('\n🎉 All tests passed!');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.response?.data) {
      console.error('API Error:', error.response.data);
    }
    process.exit(1);
  }
}

testPinata();
