// api/routes.ts - API Structure
import { Router } from 'express';
import { z } from 'zod';

// Validation schemas
const CreateDuelSchema = z.object({
  opponentAddress: z.string().optional(),
  stakeAmount: z.number().positive(),
  duration: z.number().positive(),
  allowedTokens: z.array(z.string()).optional(),
});

const UpdateProfileSchema = z.object({
  username: z.string().min(3).max(20).optional(),
  bio: z.string().max(200).optional(),
  avatar: z.string().url().optional(),
});

// API Routes Structure
export const apiRoutes = {
  // Auth
  'POST /auth/connect-wallet': 'Connect wallet and get JWT',
  'POST /auth/link-twitter': 'Link Twitter account',
  'POST /auth/refresh': 'Refresh JWT token',
  
  // User Profile
  'GET /users/:address': 'Get user profile',
  'PUT /users/profile': 'Update user profile',
  'GET /users/:address/stats': 'Get detailed user statistics',
  'GET /users/:address/duels': 'Get user duel history',
  'GET /users/:address/trades': 'Get user trade history',
  
  // Duels
  'POST /duels': 'Create new duel',
  'GET /duels/:id': 'Get duel details',
  'POST /duels/:id/accept': 'Accept duel challenge',
  'POST /duels/:id/deposit': 'Deposit stake',
  'GET /duels/:id/trades': 'Get duel trades',
  'GET /duels/:id/snapshots': 'Get duel PnL snapshots',
  'GET /duels/:id/live': 'WebSocket endpoint for live updates',
  
  // Discovery
  'GET /duels': 'List duels with filters',
  'GET /duels/active': 'Get all active duels',
  'GET /duels/pending': 'Get pending challenges',
  
  // Leaderboard
  'GET /leaderboard': 'Get global leaderboard',
  'GET /leaderboard/weekly': 'Get weekly leaderboard',
  'GET /leaderboard/pnl': 'Get PnL leaderboard',
  
  // Analytics
  'GET /analytics/overview': 'Protocol overview stats',
  'GET /analytics/tokens': 'Most traded tokens',
  'GET /analytics/dexes': 'DEX usage statistics',
  
  // Social
  'POST /social/challenge': 'Create Twitter challenge',
  'GET /social/feed': 'Get social feed',
  
  // Notifications
  'GET /notifications': 'Get user notifications',
  'PUT /notifications/:id/read': 'Mark notification as read',
  
  // Tournaments
  'GET /tournaments': 'List tournaments',
  'GET /tournaments/:id': 'Get tournament details',
  'POST /tournaments/:id/join': 'Join tournament',
  
  // Token Data
  'GET /tokens/prices': 'Get token prices',
  'GET /tokens/trending': 'Get trending tokens',
  
  // WebSocket Events
  'WS /': {
    'subscribe:duel': 'Subscribe to duel updates',
    'subscribe:leaderboard': 'Subscribe to leaderboard changes',
    'subscribe:prices': 'Subscribe to price updates',
  }
};

// Example API implementation structure
export class DuelAPI {
  async createDuel(req: Request, res: Response) {
    const { opponentAddress, stakeAmount, duration, allowedTokens } = 
      CreateDuelSchema.parse(req.body);
    
    // 1. Validate user authentication
    // 2. Create on-chain transaction
    // 3. Store in database
    // 4. Send notifications
    // 5. Return duel details
  }

  async getDuel(req: Request, res: Response) {
    const { id } = req.params;
    
    // 1. Fetch from database
    // 2. Get on-chain state
    // 3. Calculate current PnL
    // 4. Return enriched data
  }

  async subscribeToDuel(ws: WebSocket, duelId: string) {
    // 1. Validate duel exists
    // 2. Add to subscription list
    // 3. Send initial state
    // 4. Stream updates on trade events
  }
}