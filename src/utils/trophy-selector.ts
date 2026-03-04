import { WagerDetails } from '../services/pinata.service';
import trophyUris from '../config/trophy-uris.json';

export type TrophyTier = 'bronze' | 'silver' | 'gold' | 'diamond';

export interface TrophyConfig {
  tier: TrophyTier;
  name: string;
  minStake: number;
  maxStake: number;
  imageUri: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
}

const LAMPORTS_PER_SOL = 1_000_000_000;

export const TROPHY_TIERS: Record<TrophyTier, TrophyConfig> = {
  bronze: {
    tier: 'bronze',
    name: 'Bronze Champion',
    minStake: 0.01 * LAMPORTS_PER_SOL,
    maxStake: 0.1 * LAMPORTS_PER_SOL,
    imageUri: trophyUris.bronze || '',
    rarity: 'common',
  },
  silver: {
    tier: 'silver',
    name: 'Silver Victor',
    minStake: 0.1 * LAMPORTS_PER_SOL,
    maxStake: 1 * LAMPORTS_PER_SOL,
    imageUri: trophyUris.silver || '',
    rarity: 'uncommon',
  },
  gold: {
    tier: 'gold',
    name: 'Gold Master',
    minStake: 1 * LAMPORTS_PER_SOL,
    maxStake: 10 * LAMPORTS_PER_SOL,
    imageUri: trophyUris.gold || '',
    rarity: 'rare',
  },
  diamond: {
    tier: 'diamond',
    name: 'Diamond Legend',
    minStake: 10 * LAMPORTS_PER_SOL,
    maxStake: Infinity,
    imageUri: trophyUris.diamond || '',
    rarity: 'legendary',
  },
};

export function getTrophyTier(stakeLamports: number): TrophyConfig {
  if (stakeLamports >= TROPHY_TIERS.diamond.minStake) {
    return TROPHY_TIERS.diamond;
  } else if (stakeLamports >= TROPHY_TIERS.gold.minStake) {
    return TROPHY_TIERS.gold;
  } else if (stakeLamports >= TROPHY_TIERS.silver.minStake) {
    return TROPHY_TIERS.silver;
  } else {
    return TROPHY_TIERS.bronze;
  }
}

export function formatTrophyName(wagerDetails: WagerDetails): string {
  const trophy = getTrophyTier(wagerDetails.stakeLamports);
  return `${trophy.name} #${wagerDetails.matchId}`;
}

export function getTrophyDescription(wagerDetails: WagerDetails): string {
  const trophy = getTrophyTier(wagerDetails.stakeLamports);
  const prizeSOL = (wagerDetails.stakeLamports * 2 / LAMPORTS_PER_SOL).toFixed(4);
  
  return `${trophy.tier.toUpperCase()} tier victory trophy from GameGambit. ` +
    `Winner claimed ${prizeSOL} SOL by defeating their opponent in ` +
    `Lichess game ${wagerDetails.lichessGameId}. Rarity: ${trophy.rarity}.`;
}

export function getTrophyAttributes(wagerDetails: WagerDetails) {
  const trophy = getTrophyTier(wagerDetails.stakeLamports);
  
  return [
    { trait_type: 'Tier', value: trophy.tier },
    { trait_type: 'Rarity', value: trophy.rarity },
    { trait_type: 'Match ID', value: wagerDetails.matchId },
    { trait_type: 'Game Type', value: 'Chess' },
    { trait_type: 'Platform', value: 'Lichess' },
    { trait_type: 'Lichess Game', value: wagerDetails.lichessGameId },
    { trait_type: 'Prize (SOL)', value: wagerDetails.stakeLamports * 2 / LAMPORTS_PER_SOL },
    { trait_type: 'Stake Amount (SOL)', value: wagerDetails.stakeLamports / LAMPORTS_PER_SOL },
    { trait_type: 'Winner', value: wagerDetails.winner.slice(0, 8) + '...' },
    { trait_type: 'Date Earned', value: wagerDetails.resolvedAt },
  ];
}
