import * as dotenv from 'dotenv';
import { PublicKey } from '@solana/web3.js';

dotenv.config();

export interface EnvConfig {
    pinata: {
        apiKey: string;
        secretKey: string;
        jwt: string;
        gateway: string;
    };
    solana: {
        rpcUrl: string;
        network: 'devnet' | 'testnet' | 'mainnet-beta';
        programId: PublicKey;
    };
}

class ConfigService {
    private config: EnvConfig;

    constructor() {
        this.config = this.loadConfig();
        this.validateConfig();
    }

    private loadConfig(): EnvConfig {
        const programId = process.env.ANCHOR_PROGRAM_ID || 'CPS82nShfYFBdJPLs4kLMYEUrTwvxieqSrkw6VYRopzx';

        return {
            pinata: {
                apiKey: process.env.PINATA_API_KEY || '',
                secretKey: process.env.PINATA_SECRET_KEY || '',
                jwt: process.env.PINATA_JWT || '',
                gateway: process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs',
            },
            solana: {
                rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
                network: (process.env.SOLANA_NETWORK as any) || 'devnet',
                programId: new PublicKey(programId),
            },
        };
    }

    private validateConfig(): void {
        const missingVars: string[] = [];

        if (!this.config.pinata.jwt) {
            missingVars.push('PINATA_JWT');
        }
        if (!this.config.solana.rpcUrl) {
            missingVars.push('SOLANA_RPC_URL');
        }

        if (missingVars.length > 0) {
            throw new Error(
                `Missing required environment variables: ${missingVars.join(', ')}\n` +
                'Please check your .env file'
            );
        }
    }

    public get(): EnvConfig {
        return this.config;
    }

    public getPinataConfig() {
        return this.config.pinata;
    }

    public getSolanaConfig() {
        return this.config.solana;
    }
}

export const config = new ConfigService();
export const getPinataConfig = () => config.getPinataConfig();
export const getSolanaConfig = () => config.getSolanaConfig();
