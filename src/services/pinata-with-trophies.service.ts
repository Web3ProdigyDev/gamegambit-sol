import axios from 'axios';
import { getPinataConfig } from '../config/env.config';
import { 
  getTrophyTier, 
  formatTrophyName, 
  getTrophyDescription, 
  getTrophyAttributes 
} from '../utils/trophy-selector';

const PINATA_API_URL = 'https://api.pinata.cloud';

export interface WagerDetails {
  wagerId: string;
  winner: string;
  loser: string;
  stakeLamports: number;
  lichessGameId: string;
  matchId: number;
  resolvedAt: string;
}

export class PinataServiceV2 {
  private jwt: string;
  private gateway: string;

  constructor() {
    const config = getPinataConfig();
    this.jwt = config.jwt;
    this.gateway = config.gateway;
  }

  private get headers() {
    return {
      'Authorization': `Bearer ${this.jwt}`,
    };
  }

  async uploadJSON(metadata: any, fileName: string): Promise<string> {
    try {
      const response = await axios.post(
        `${PINATA_API_URL}/pinning/pinJSONToIPFS`,
        {
          pinataContent: metadata,
          pinataMetadata: { name: fileName },
          pinataOptions: { cidVersion: 1 },
        },
        { headers: this.headers, timeout: 10000 }
      );

      console.log(`✅ Uploaded JSON: ${fileName}`);
      return response.data.IpfsHash;
    } catch (error: any) {
      console.error('Error uploading JSON:', error.message);
      throw new Error(`Failed to upload JSON: ${error.message}`);
    }
  }

  async createWagerNFT(wagerDetails: WagerDetails): Promise<{ metadataUri: string; imageUri: string; tier: string }> {
    try {
      console.log(`📦 Creating NFT for wager ${wagerDetails.wagerId.slice(0, 8)}...`);

      // Get the appropriate trophy based on stake amount
      const trophy = getTrophyTier(wagerDetails.stakeLamports);
      const imageUri = trophy.imageUri;

      console.log(`🏆 Selected ${trophy.tier.toUpperCase()} tier trophy (${trophy.rarity})`);

      // Create metadata
      const metadata = {
        name: formatTrophyName(wagerDetails),
        symbol: 'GGWIN',
        description: getTrophyDescription(wagerDetails),
        image: imageUri,
        attributes: getTrophyAttributes(wagerDetails),
        properties: {
          files: [{ uri: imageUri, type: 'image/png' }],
          category: 'image',
        },
      };

      const metadataHash = await this.uploadJSON(
        metadata,
        `wager_${wagerDetails.matchId}_metadata.json`
      );
      const metadataUri = `${this.gateway}/${metadataHash}`;

      console.log(`✅ NFT created successfully!`);
      return { metadataUri, imageUri, tier: trophy.tier };
    } catch (error) {
      console.error('❌ Error creating wager NFT:', error);
      throw error;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get(`${PINATA_API_URL}/data/testAuthentication`, {
        headers: this.headers,
        timeout: 10000,
      });
      console.log('✅ Pinata connection successful');
      return true;
    } catch (error: any) {
      console.error('❌ Pinata connection failed:', error.message);
      return false;
    }
  }
}

export const pinataServiceV2 = new PinataServiceV2();
