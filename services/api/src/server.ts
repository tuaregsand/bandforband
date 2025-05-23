import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import WebSocket from 'ws';
import http from 'http';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { Connection, PublicKey } from '@solana/web3.js';
import { createPublicKey, verify as verifyEd25519 } from 'crypto';
import { TradingDuelClient } from '../../../client/src/program';
import { PrismaClient } from '@prisma/client';

// Environment configuration
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Initialize services
const prisma = new PrismaClient();
const connection = new Connection(SOLANA_RPC_URL);
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Minimal base58 decoder for signature verification
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeBase58(value: string): Buffer {
  const BASE = BASE58_ALPHABET.length;
  const bytes: number[] = [0];

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error('Invalid base58 character');
    }

    let carry = index;
    for (let j = 0; j < bytes.length; ++j) {
      carry += bytes[j] * BASE;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Deal with leading zeros
  let leadingZeroCount = 0;
  for (let i = 0; i < value.length && value[i] === '1'; i++) {
    leadingZeroCount++;
  }

  const result = Buffer.from(bytes.reverse());
  if (leadingZeroCount) {
    return Buffer.concat([Buffer.alloc(leadingZeroCount), result]);
  }
  return result;
}

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

const ConnectWalletSchema = z.object({
  address: z.string(),
  signature: z.string(),
  message: z.string(),
});

// Types
interface AuthRequest extends Request {
  user?: {
    address: string;
    id: string;
  };
}

interface WebSocketClient extends WebSocket {
  subscriptions?: Set<string>;
  userId?: string;
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});
app.use('/api/', limiter);

// JWT Authentication middleware
const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const user = await prisma.user.findUnique({
      where: { address: decoded.address }
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = { address: user.address, id: user.id };
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Auth Routes
app.post('/api/auth/connect-wallet', async (req: Request, res: Response) => {
  try {
    const { address, signature, message } = ConnectWalletSchema.parse(req.body);

    const pubkey = new PublicKey(address);
    const msgBuffer = Buffer.from(message, 'utf8');

    let sigBuffer: Buffer;
    try {
      sigBuffer = decodeBase58(signature);
    } catch (err) {
      try {
        sigBuffer = Buffer.from(signature, 'base64');
      } catch (e) {
        return res.status(400).json({ error: 'Invalid signature format' });
      }
    }

    const derPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const keyObject = createPublicKey({
      key: Buffer.concat([derPrefix, pubkey.toBytes()]),
      format: 'der',
      type: 'spki'
    });

    const isValid = verifyEd25519(null, msgBuffer, keyObject, sigBuffer);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Find or create user
    let user = await prisma.user.findUnique({
      where: { address }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          address,
          username: `trader_${address.slice(0, 8)}`,
          createdAt: new Date(),
        }
      });
    }

    // Generate JWT
    const token = jwt.sign(
      { address: user.address, id: user.id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        address: user.address,
        username: user.username,
        avatar: user.avatar,
        bio: user.bio,
      }
    });

  } catch (error) {
    console.error('Auth error:', error);
    res.status(400).json({ error: 'Invalid request' });
  }
});

app.post('/api/auth/link-twitter', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { twitterUsername, twitterId } = req.body;

    await prisma.user.update({
      where: { address: req.user!.address },
      data: {
        twitterUsername,
        twitterId,
        updatedAt: new Date(),
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Twitter linking error:', error);
    res.status(500).json({ error: 'Failed to link Twitter account' });
  }
});

// User Profile Routes
app.get('/api/users/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const user = await prisma.user.findUnique({
      where: { address },
      include: {
        _count: {
          select: {
            createdDuels: true,
            participatedDuels: true,
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: user.id,
      address: user.address,
      username: user.username,
      avatar: user.avatar,
      bio: user.bio,
      twitterUsername: user.twitterUsername,
      totalDuels: user._count.createdDuels + user._count.participatedDuels,
      createdAt: user.createdAt,
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.put('/api/users/profile', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const updates = UpdateProfileSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { address: req.user!.address },
      data: {
        ...updates,
        updatedAt: new Date(),
      }
    });

    res.json({
      id: user.id,
      address: user.address,
      username: user.username,
      avatar: user.avatar,
      bio: user.bio,
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(400).json({ error: 'Invalid request' });
  }
});

app.get('/api/users/:address/stats', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    // Get user duels and calculate stats
    const duels = await prisma.duel.findMany({
      where: {
        OR: [
          { creatorAddress: address },
          { opponentAddress: address }
        ],
        status: 'SETTLED'
      }
    });

    let wins = 0;
    let totalPnL = 0;
    let totalVolume = 0;

    duels.forEach(duel => {
      const isCreator = duel.creatorAddress === address;
      const userPnL = isCreator ? duel.creatorPnL : duel.opponentPnL;
      
      totalPnL += userPnL || 0;
      totalVolume += duel.stakeAmount;

      if (
        (duel.winner === 'CREATOR' && isCreator) ||
        (duel.winner === 'OPPONENT' && !isCreator)
      ) {
        wins++;
      }
    });

    const winRate = duels.length > 0 ? (wins / duels.length) * 100 : 0;

    res.json({
      totalDuels: duels.length,
      wins,
      losses: duels.length - wins,
      winRate,
      totalPnL,
      totalVolume,
      averagePnL: duels.length > 0 ? totalPnL / duels.length : 0,
    });

  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ error: 'Failed to fetch user stats' });
  }
});

// Duel Routes
app.post('/api/duels', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const duelData = CreateDuelSchema.parse(req.body);

    // TODO: Create duel on-chain first
    // For now, we'll create it in the database

    const duel = await prisma.duel.create({
      data: {
        creatorAddress: req.user!.address,
        opponentAddress: duelData.opponentAddress,
        stakeAmount: duelData.stakeAmount,
        duration: duelData.duration,
        allowedTokens: duelData.allowedTokens || [],
        status: duelData.opponentAddress ? 'ACCEPTED' : 'PENDING',
        createdAt: new Date(),
      }
    });

    res.json(duel);

  } catch (error) {
    console.error('Create duel error:', error);
    res.status(400).json({ error: 'Invalid request' });
  }
});

app.get('/api/duels/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const duel = await prisma.duel.findUnique({
      where: { id },
      include: {
        creator: {
          select: { username: true, avatar: true }
        },
        opponent: {
          select: { username: true, avatar: true }
        }
      }
    });

    if (!duel) {
      return res.status(404).json({ error: 'Duel not found' });
    }

    res.json(duel);

  } catch (error) {
    console.error('Get duel error:', error);
    res.status(500).json({ error: 'Failed to fetch duel' });
  }
});

app.post('/api/duels/:id/accept', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const duel = await prisma.duel.update({
      where: { id },
      data: {
        opponentAddress: req.user!.address,
        status: 'ACCEPTED',
        updatedAt: new Date(),
      }
    });

    // Broadcast update via WebSocket
    broadcastDuelUpdate(id, duel);

    res.json(duel);

  } catch (error) {
    console.error('Accept duel error:', error);
    res.status(400).json({ error: 'Failed to accept duel' });
  }
});

app.get('/api/duels', async (req: Request, res: Response) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const duels = await prisma.duel.findMany({
      where: status ? { status: status as any } : undefined,
      include: {
        creator: {
          select: { username: true, avatar: true }
        },
        opponent: {
          select: { username: true, avatar: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
    });

    res.json(duels);

  } catch (error) {
    console.error('List duels error:', error);
    res.status(500).json({ error: 'Failed to fetch duels' });
  }
});

// Leaderboard Routes
app.get('/api/leaderboard', async (req: Request, res: Response) => {
  try {
    const { period = 'all' } = req.query;

    // Calculate leaderboard based on win rate and total winnings
    const users = await prisma.user.findMany({
      include: {
        createdDuels: {
          where: { status: 'SETTLED' }
        },
        participatedDuels: {
          where: { status: 'SETTLED' }
        }
      }
    });

    const leaderboard = users.map(user => {
      const allDuels = [...user.createdDuels, ...user.participatedDuels];
      let wins = 0;
      let totalWinnings = 0;

      allDuels.forEach(duel => {
        const isCreator = duel.creatorAddress === user.address;
        if (
          (duel.winner === 'CREATOR' && isCreator) ||
          (duel.winner === 'OPPONENT' && !isCreator)
        ) {
          wins++;
          totalWinnings += duel.stakeAmount * 2; // Winner takes all
        }
      });

      const winRate = allDuels.length > 0 ? (wins / allDuels.length) * 100 : 0;

      return {
        user: {
          address: user.address,
          username: user.username,
          avatar: user.avatar,
        },
        totalDuels: allDuels.length,
        wins,
        winRate,
        totalWinnings,
        score: winRate * Math.log(totalWinnings + 1), // Combined score
      };
    })
    .filter(entry => entry.totalDuels > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);

    res.json(leaderboard);

  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Analytics Routes
app.get('/api/analytics/overview', async (req: Request, res: Response) => {
  try {
    const totalDuels = await prisma.duel.count();
    const activeDuels = await prisma.duel.count({
      where: { status: 'ACTIVE' }
    });
    const totalUsers = await prisma.user.count();
    
    const totalVolume = await prisma.duel.aggregate({
      _sum: { stakeAmount: true },
      where: { status: 'SETTLED' }
    });

    res.json({
      totalDuels,
      activeDuels,
      totalUsers,
      totalVolume: totalVolume._sum.stakeAmount || 0,
    });

  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// WebSocket handling
interface WSMessage {
  type: 'subscribe' | 'unsubscribe';
  channel: string;
  data?: any;
}

wss.on('connection', (ws: WebSocketClient) => {
  ws.subscriptions = new Set();

  ws.on('message', (message: string) => {
    try {
      const data: WSMessage = JSON.parse(message);

      switch (data.type) {
        case 'subscribe':
          ws.subscriptions?.add(data.channel);
          console.log(`Client subscribed to ${data.channel}`);
          break;

        case 'unsubscribe':
          ws.subscriptions?.delete(data.channel);
          console.log(`Client unsubscribed from ${data.channel}`);
          break;
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Broadcast functions
function broadcastDuelUpdate(duelId: string, duelData: any) {
  wss.clients.forEach((client: WebSocketClient) => {
    if (client.readyState === WebSocket.OPEN && client.subscriptions?.has(`duel:${duelId}`)) {
      client.send(JSON.stringify({
        type: 'duel_update',
        data: duelData,
      }));
    }
  });
}

function broadcastLeaderboardUpdate(leaderboard: any[]) {
  wss.clients.forEach((client: WebSocketClient) => {
    if (client.readyState === WebSocket.OPEN && client.subscriptions?.has('leaderboard')) {
      client.send(JSON.stringify({
        type: 'leaderboard_update',
        data: leaderboard,
      }));
    }
  });
}

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Trading Duel API server running on port ${PORT}`);
  console.log(`📊 WebSocket server ready for real-time updates`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await prisma.$disconnect();
  process.exit(0);
});

export { app, server, wss }; 