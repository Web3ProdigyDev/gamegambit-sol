import { expect } from 'chai';
import { pinataService, WagerDetails } from '../src/services/pinata.service';

describe('Pinata Integration', () => {
  it('should connect to Pinata successfully', async function() {
    this.timeout(10000);
    const connected = await pinataService.testConnection();
    expect(connected).to.be.true;
  });

  it('should create and upload NFT metadata', async function() {
    this.timeout(60000);
    
    const mockWagerDetails: WagerDetails = {
      wagerId: 'test_wager_' + Date.now(),
      winner: 'EaXp7KjQUCBvXvqzVhNx8dGZqF3mYvMk9Yv7XYbcDZQ9',
      loser: 'FbYq8LkRVDCwYwrzWiOy9eHaqG4nZwNl0Zw8YZcdEaR0',
      stakeLamports: 1500000000, // 1.5 SOL
      lichessGameId: 'abc123XYZ',
      matchId: 42,
      resolvedAt: new Date().toISOString(),
    };

    console.log('\n🎨 Creating test NFT...');
    const { metadataUri, imageUri } = await pinataService.createWagerNFT(mockWagerDetails);

    console.log('\n📊 Results:');
    console.log('Image URI:', imageUri);
    console.log('Metadata URI:', metadataUri);
    console.log('\n🔗 View your NFT:');
    console.log('Image:', imageUri);
    console.log('Metadata:', metadataUri);

    expect(metadataUri).to.include('gateway.pinata.cloud');
    expect(imageUri).to.include('gateway.pinata.cloud');
  });

  it('should list pinned files', async function() {
    this.timeout(10000);
    
    const files = await pinataService.listPinnedFiles(5);
    console.log('\n📋 Recently pinned files:', files.count);
    expect(files).to.have.property('rows');
  });
});
