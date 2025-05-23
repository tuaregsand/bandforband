import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import request from 'supertest';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

// Test configuration
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://test:test@localhost:5432/trading_duel_test';
const JWT_SECRET = 'test-secret';

describe('Trading Duel API Tests', () => {
  let app: express.Application;
  let prisma: PrismaClient;
  let testUserToken: string;
  let testUser2Token: string;
  let testDuelId: string;

  const testUser1 = {
    address: '11111112Aa1FJqNJmFnbbzLCAqPJjXKu9PG8kCJ5z8C',
    username: 'test_trader_1'
  };

  const testUser2 = {
    address: '22222223Bb2GKrOKnGoccAMBrQKjYKv9QH9lDK6A9D',
    username: 'test_trader_2'
  };

  before(async () => {
    // Initialize test database
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: TEST_DATABASE_URL
        }
      }
    });

    // Clear test data
    await prisma.trade.deleteMany();
    await prisma.duel.deleteMany();
    await prisma.user.deleteMany();

    // Create test users
    const user1 = await prisma.user.create({
      data: {
        walletAddress: testUser1.address,
        username: testUser1.username,
      }
    });

    const user2 = await prisma.user.create({
      data: {
        walletAddress: testUser2.address,
        username: testUser2.username,
      }
    });

    // Generate test tokens
    testUserToken = jwt.sign({ address: testUser1.address, id: user1.id }, JWT_SECRET);
    testUser2Token = jwt.sign({ address: testUser2.address, id: user2.id }, JWT_SECRET);

    // Import and start API server
    const { createApp } = await import('../services/api/src/server');
    app = createApp(prisma, JWT_SECRET);
  });

  after(async () => {
    await prisma.$disconnect();
  });

  describe('Authentication Endpoints', () => {
    it('should connect wallet and return JWT token', async () => {
      const response = await request(app)
        .post('/api/auth/connect-wallet')
        .send({
          address: '33333334Cc3HLsMOnHpddBNCsPKjZKw9RI0mEL7B0E',
          signature: 'mock-signature',
          message: 'Connect to Trading Duel Protocol'
        });

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('token');
      expect(response.body.user).to.have.property('address');
      expect(response.body.user).to.have.property('username');
    });

    it('should link Twitter account', async () => {
      const response = await request(app)
        .post('/api/auth/link-twitter')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          twitterHandle: '@test_trader',
          twitterId: '123456789'
        });

      expect(response.status).to.equal(200);
      expect(response.body.success).to.be.true;
    });

    it('should reject requests without valid token', async () => {
      const response = await request(app)
        .put('/api/users/profile')
        .send({ username: 'hacker' });

      expect(response.status).to.equal(401);
    });
  });

  describe('User Profile Endpoints', () => {
    it('should get user profile', async () => {
      const response = await request(app)
        .get(`/api/users/${testUser1.address}`);

      expect(response.status).to.equal(200);
      expect(response.body.address).to.equal(testUser1.address);
      expect(response.body.username).to.equal(testUser1.username);
    });

    it('should update user profile', async () => {
      const updateData = {
        username: 'updated_trader',
        bio: 'Professional SOL trader',
        avatar: 'https://example.com/avatar.jpg'
      };

      const response = await request(app)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(updateData);

      expect(response.status).to.equal(200);
      expect(response.body.username).to.equal(updateData.username);
      expect(response.body.bio).to.equal(updateData.bio);
    });

    it('should get user statistics', async () => {
      const response = await request(app)
        .get(`/api/users/${testUser1.address}/stats`);

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('totalDuels');
      expect(response.body).to.have.property('wins');
      expect(response.body).to.have.property('winRate');
      expect(response.body).to.have.property('totalPnl');
    });

    it('should return 404 for non-existent user', async () => {
      const response = await request(app)
        .get('/api/users/invalid-address');

      expect(response.status).to.equal(404);
    });
  });

  describe('Duel Management Endpoints', () => {
    it('should create a new duel', async () => {
      const duelData = {
        opponentAddress: testUser2.address,
        stakeAmount: 1000000000, // 1 SOL
        duration: 3600, // 1 hour
        allowedTokens: ['So11111111111111111111111111111111111111112'] // SOL
      };

      const response = await request(app)
        .post('/api/duels')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(duelData);

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('id');
      expect(response.body.stakeAmount).to.equal(duelData.stakeAmount);
      expect(response.body.duration).to.equal(duelData.duration);
      
      testDuelId = response.body.id;
    });

    it('should get duel details', async () => {
      const response = await request(app)
        .get(`/api/duels/${testDuelId}`);

      expect(response.status).to.equal(200);
      expect(response.body.id).to.equal(testDuelId);
      expect(response.body).to.have.property('creator');
      expect(response.body).to.have.property('opponent');
    });

    it('should accept a duel challenge', async () => {
      const response = await request(app)
        .post(`/api/duels/${testDuelId}/accept`)
        .set('Authorization', `Bearer ${testUser2Token}`);

      expect(response.status).to.equal(200);
      expect(response.body.status).to.equal('ACCEPTED');
    });

    it('should list duels with filters', async () => {
      const response = await request(app)
        .get('/api/duels?status=ACCEPTED&limit=10');

      expect(response.status).to.equal(200);
      expect(Array.isArray(response.body)).to.be.true;
      expect(response.body.length).to.be.greaterThan(0);
    });

    it('should get pending duels', async () => {
      const response = await request(app)
        .get('/api/duels?status=PENDING');

      expect(response.status).to.equal(200);
      expect(Array.isArray(response.body)).to.be.true;
    });

    it('should validate duel creation parameters', async () => {
      const invalidDuelData = {
        stakeAmount: -100, // Invalid negative amount
        duration: 0 // Invalid zero duration
      };

      const response = await request(app)
        .post('/api/duels')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(invalidDuelData);

      expect(response.status).to.equal(400);
    });
  });

  describe('Leaderboard Endpoints', () => {
    it('should get global leaderboard', async () => {
      const response = await request(app)
        .get('/api/leaderboard');

      expect(response.status).to.equal(200);
      expect(Array.isArray(response.body)).to.be.true;
    });

    it('should get weekly leaderboard', async () => {
      const response = await request(app)
        .get('/api/leaderboard?period=weekly');

      expect(response.status).to.equal(200);
      expect(Array.isArray(response.body)).to.be.true;
    });

    it('should get PnL leaderboard', async () => {
      const response = await request(app)
        .get('/api/leaderboard/pnl');

      expect(response.status).to.equal(200);
      expect(Array.isArray(response.body)).to.be.true;
    });
  });

  describe('Analytics Endpoints', () => {
    it('should get protocol overview', async () => {
      const response = await request(app)
        .get('/api/analytics/overview');

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('totalDuels');
      expect(response.body).to.have.property('totalVolume');
      expect(response.body).to.have.property('activeUsers');
    });

    it('should get trending tokens', async () => {
      const response = await request(app)
        .get('/api/analytics/tokens');

      expect(response.status).to.equal(200);
      expect(Array.isArray(response.body)).to.be.true;
    });

    it('should get DEX usage statistics', async () => {
      const response = await request(app)
        .get('/api/analytics/dexes');

      expect(response.status).to.equal(200);
      expect(Array.isArray(response.body)).to.be.true;
    });
  });

  describe('Trade Tracking', () => {
    it('should record a trade', async () => {
      const tradeData = {
        duelId: testDuelId,
        signature: 'test-signature-123',
        inputToken: 'So11111111111111111111111111111111111111112',
        outputToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inputAmount: '1000000000',
        outputAmount: '1000000',
        dex: 'raydium'
      };

      const response = await request(app)
        .post('/api/trades')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(tradeData);

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('id');
    });

    it('should get duel trades', async () => {
      const response = await request(app)
        .get(`/api/duels/${testDuelId}/trades`);

      expect(response.status).to.equal(200);
      expect(Array.isArray(response.body)).to.be.true;
    });
  });

  describe('Rate Limiting', () => {
    it('should enforce rate limits', async function() {
      this.timeout(5000); // Increase timeout for this test

      const requests = [];
      for (let i = 0; i < 105; i++) { // Exceed the 100 request limit
        requests.push(
          request(app)
            .get('/api/leaderboard')
            .expect((res) => {
              if (i > 100) {
                expect(res.status).to.equal(429);
              }
            })
        );
      }

      await Promise.all(requests);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON', async () => {
      const response = await request(app)
        .post('/api/duels')
        .set('Authorization', `Bearer ${testUserToken}`)
        .set('Content-Type', 'application/json')
        .send('{ invalid json }');

      expect(response.status).to.equal(400);
    });

    it('should handle database connection errors gracefully', async () => {
      // This would require mocking database failures
      // For now, we'll test the error response structure
      const response = await request(app)
        .get('/api/users/non-existent-user');

      expect(response.status).to.equal(404);
      expect(response.body).to.have.property('error');
    });
  });

  describe('Input Validation', () => {
    it('should validate wallet addresses', async () => {
      const response = await request(app)
        .get('/api/users/invalid-wallet-address');

      expect(response.status).to.equal(404);
    });

    it('should validate stake amounts', async () => {
      const response = await request(app)
        .post('/api/duels')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          stakeAmount: 'not-a-number',
          duration: 3600
        });

      expect(response.status).to.equal(400);
    });

    it('should validate duration limits', async () => {
      const response = await request(app)
        .post('/api/duels')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          stakeAmount: 1000000000,
          duration: 86401 // More than 24 hours
        });

      expect(response.status).to.equal(400);
    });
  });
}); 