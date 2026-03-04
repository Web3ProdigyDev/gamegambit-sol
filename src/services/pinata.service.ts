import axios from 'axios';
import FormData from 'form-data';
import { getPinataConfig } from '../config/env.config';

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

export class PinataService {
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
        { headers: this.headers }
      );

      console.log(`✅ Uploaded JSON: ${fileName}`);
      return response.data.IpfsHash;
    } catch (error: any) {
      console.error('Error uploading JSON:', error.response?.data || error.message);
      throw new Error(`Failed to upload JSON: ${error.message}`);
    }
  }

  async uploadBuffer(buffer: Buffer, fileName: string): Promise<string> {
    try {
      const formData = new FormData();
      formData.append('file', buffer, { filename: fileName, contentType: 'image/svg+xml' });
      formData.append('pinataMetadata', JSON.stringify({ name: fileName }));
      formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

      const response = await axios.post(
        `${PINATA_API_URL}/pinning/pinFileToIPFS`,
        formData,
        {
          headers: { ...this.headers, ...formData.getHeaders() },
          maxBodyLength: Infinity,
        }
      );

      console.log(`✅ Uploaded file: ${fileName}`);
      return response.data.IpfsHash;
    } catch (error: any) {
      console.error('Error uploading buffer:', error.message);
      throw new Error(`Failed to upload buffer: ${error.message}`);
    }
  }

  private generateTrophySVG(wagerDetails: WagerDetails): string {
    const prizeSOL = (wagerDetails.stakeLamports / 1e9).toFixed(4);
    
    return `<svg width="500" height="500" xmlns="http://www.w3.org/2000/svg">
  <rect width="500" height="500" fill="#0f172a"/>
  <rect x="20" y="20" width="460" height="460" fill="none" stroke="#fbbf24" stroke-width="3" rx="15"/>
  <text x="250" y="160" font-size="100" text-anchor="middle">🏆</text>
  <text x="250" y="240" font-size="32" font-weight="bold" fill="#fbbf24" text-anchor="middle">VICTORY</text>
  <text x="250" y="270" font-size="16" fill="#94a3b8" text-anchor="middle">GameGambit Champion</text>
  <rect x="170" y="290" width="160" height="40" fill="#1e293b" stroke="#fbbf24" stroke-width="2" rx="8"/>
  <text x="250" y="315" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">Match #${wagerDetails.matchId}</text>
  <text x="250" y="360" font-size="28" font-weight="bold" fill="#10b981" text-anchor="middle">${prizeSOL} SOL</text>
  <text x="250" y="420" font-size="12" fill="#64748b" text-anchor="middle">Lichess: ${wagerDetails.lichessGameId}</text>
</svg>`;
  }

  async createWagerNFT(wagerDetails: WagerDetails): Promise<{ metadataUri: string; imageUri: string }> {
    try {
      console.log(`📦 Creating NFT for wager ${wagerDetails.wagerId.slice(0, 8)}...`);

      const svgContent = this.generateTrophySVG(wagerDetails);
      const svgBuffer = Buffer.from(svgContent, 'utf-8');
      const imageHash = await this.uploadBuffer(svgBuffer, `wager_${wagerDetails.matchId}_trophy.svg`);
      const imageUri = `${this.gateway}/${imageHash}`;

      const metadata = {
        name: `GameGambit Victory #${wagerDetails.matchId}`,
        symbol: 'GGWIN',
        description: `Victory NFT from GameGambit. Winner claimed ${(wagerDetails.stakeLamports / 1e9).toFixed(4)} SOL.`,
        image: imageUri,
        attributes: [
          { trait_type: 'Match ID', value: wagerDetails.matchId },
          { trait_type: 'Lichess Game', value: wagerDetails.lichessGameId },
          { trait_type: 'Prize (SOL)', value: wagerDetails.stakeLamports / 1e9 },
          { trait_type: 'Platform', value: 'GameGambit' },
        ],
        properties: {
          files: [{ uri: imageUri, type: 'image/svg+xml' }],
          category: 'image',
        },
      };

      const metadataHash = await this.uploadJSON(metadata, `wager_${wagerDetails.matchId}_metadata.json`);
      const metadataUri = `${this.gateway}/${metadataHash}`;

      console.log(`✅ NFT created successfully!`);
      return { metadataUri, imageUri };
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

  async listPinnedFiles(limit: number = 10): Promise<any> {
    try {
      const response = await axios.get(`${PINATA_API_URL}/data/pinList`, {
        headers: this.headers,
        params: { status: 'pinned', pageLimit: limit },
        timeout: 10000,
      });
      return response.data;
    } catch (error: any) {
      console.error('Error listing files:', error.message);
      throw error;
    }
  }
}

export const pinataService = new PinataService();
