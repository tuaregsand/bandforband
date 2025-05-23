import { TwitterApi, TweetV2PostTweetResult } from 'twitter-api-v2';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { TradingDuelClient } from '../../../client/src/program';

interface ChallengeData {
  challenger: string;
  opponent: string;
  stakeAmount: number;
  duration: number; // in hours
  allowedTokens?: string[];
  tweetId: string;
}

interface DuelResult {
  duelPubkey: PublicKey;
  creator: string;
  opponent: string;
  creatorPnL: number;
  opponentPnL: number;
  winner: 'Creator' | 'Opponent' | 'Draw';
  winnerPayout: number;
  originalTweetId?: string;
}

export class TwitterBot {
  private twitter: TwitterApi;
  private client: TradingDuelClient;
  private connection: Connection;
  private botKeypair: Keypair;
  private pendingChallenges: Map<string, ChallengeData> = new Map();
  private walletRegistry: Map<string, PublicKey> = new Map(); // Twitter username -> Solana wallet

  constructor(
    twitterConfig: {
      apiKey: string;
      apiSecret: string;
      accessToken: string;
      accessTokenSecret: string;
    },
    client: TradingDuelClient,
    connection: Connection,
    botKeypair: Keypair
  ) {
    this.twitter = new TwitterApi({
      appKey: twitterConfig.apiKey,
      appSecret: twitterConfig.apiSecret,
      accessToken: twitterConfig.accessToken,
      accessSecret: twitterConfig.accessTokenSecret,
    });
    
    this.client = client;
    this.connection = connection;
    this.botKeypair = botKeypair;
  }

  // Start monitoring Twitter for challenges
  async startMonitoring(): Promise<void> {
    console.log('🐦 Starting Twitter bot monitoring...');

    // Listen for mentions and hashtags
    const stream = await this.twitter.v2.searchStream({
      'tweet.fields': ['author_id', 'created_at', 'conversation_id'],
      'user.fields': ['username'],
    });

    stream.on('data', async (tweet) => {
      await this.processTweet(tweet);
    });

    stream.on('error', (error) => {
      console.error('❌ Twitter stream error:', error);
    });

    // Set up rules for monitoring
    await this.setupStreamRules();

    console.log('✅ Twitter bot monitoring started');
  }

  // Setup streaming rules to monitor for challenges
  private async setupStreamRules(): Promise<void> {
    try {
      // Get existing rules
      const existingRules = await this.twitter.v2.streamRules();
      
      // Delete existing rules
      if (existingRules.data?.length) {
        await this.twitter.v2.updateStreamRules({
          delete: {
            ids: existingRules.data.map(rule => rule.id),
          },
        });
      }

      // Add new rules
      await this.twitter.v2.updateStreamRules({
        add: [
          { value: '@TradingDuelBot 1v1', tag: 'challenge' },
          { value: '@TradingDuelBot duel', tag: 'challenge' },
          { value: '@TradingDuelBot accept', tag: 'accept' },
          { value: '#TradingDuel', tag: 'hashtag' },
        ],
      });

      console.log('✅ Twitter stream rules configured');
    } catch (error) {
      console.error('❌ Error setting up stream rules:', error);
    }
  }

  // Process incoming tweets
  private async processTweet(tweet: any): Promise<void> {
    try {
      const tweetText = tweet.data.text.toLowerCase();
      const author = tweet.includes?.users?.[0];
      
      if (!author) return;

      console.log(`📨 Processing tweet from @${author.username}: ${tweet.data.text}`);

      // Check if it's a challenge
      if (this.isChallengeFormat(tweetText)) {
        await this.processChallenge(tweet, author);
      }
      
      // Check if it's an acceptance
      else if (this.isAcceptanceFormat(tweetText)) {
        await this.processAcceptance(tweet, author);
      }

      // Check for wallet linking
      else if (this.isWalletLinking(tweetText)) {
        await this.processWalletLinking(tweet, author);
      }

    } catch (error) {
      console.error('❌ Error processing tweet:', error);
    }
  }

  // Check if tweet is a challenge format
  private isChallengeFormat(text: string): boolean {
    const challengePatterns = [
      /1v1.*(\d+(\.\d+)?)\s*(sol|$)/i,
      /duel.*(\d+(\.\d+)?)\s*(sol|$)/i,
      /@\w+.*1v1/i,
    ];

    return challengePatterns.some(pattern => pattern.test(text));
  }

  // Check if tweet is accepting a challenge
  private isAcceptanceFormat(text: string): boolean {
    const acceptPatterns = [
      /accept/i,
      /let's go/i,
      /i'm in/i,
      /bring it/i,
    ];

    return acceptPatterns.some(pattern => pattern.test(text));
  }

  // Check if tweet is linking wallet
  private isWalletLinking(text: string): boolean {
    // Look for Solana wallet address pattern
    return /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(text) && text.includes('wallet');
  }

  // Process a challenge tweet
  private async processChallenge(tweet: any, author: any): Promise<void> {
    try {
      const challengeData = this.parseChallengeData(tweet.data.text, author.username);
      if (!challengeData) return;

      // Store pending challenge
      this.pendingChallenges.set(tweet.data.id, challengeData);

      // Reply with confirmation and instructions
      const replyText = `🔥 Challenge detected! 

@${challengeData.challenger} challenges @${challengeData.opponent} to a ${challengeData.duration}h trading duel for ${challengeData.stakeAmount} SOL!

@${challengeData.opponent} reply with "accept" to join the battle! ⚔️

Both traders must link their wallets first. Reply with "wallet: YOUR_WALLET_ADDRESS"

#TradingDuel #SolanaTradingWars`;

      await this.twitter.v2.reply(replyText, tweet.data.id);

      console.log(`✅ Challenge processed: ${challengeData.challenger} vs ${challengeData.opponent}`);

    } catch (error) {
      console.error('❌ Error processing challenge:', error);
    }
  }

  // Parse challenge data from tweet text
  private parseChallengeData(text: string, challenger: string): ChallengeData | null {
    try {
      // Extract opponent (looking for @mentions)
      const mentionMatch = text.match(/@(\w+)/);
      const opponent = mentionMatch?.[1];
      if (!opponent || opponent === 'TradingDuelBot') return null;

      // Extract stake amount
      const stakeMatch = text.match(/(\d+(?:\.\d+)?)\s*sol/i);
      const stakeAmount = stakeMatch ? parseFloat(stakeMatch[1]) : 1; // Default to 1 SOL

      // Extract duration (default to 1 hour)
      const durationMatch = text.match(/(\d+)\s*h/i);
      const duration = durationMatch ? parseInt(durationMatch[1]) : 1;

      return {
        challenger,
        opponent,
        stakeAmount,
        duration,
        tweetId: '',
      };

    } catch (error) {
      console.error('❌ Error parsing challenge data:', error);
      return null;
    }
  }

  // Process acceptance of a challenge
  private async processAcceptance(tweet: any, author: any): Promise<void> {
    try {
      // Find the original challenge tweet
      const conversationId = tweet.data.conversation_id;
      const challenge = Array.from(this.pendingChallenges.entries())
        .find(([_, data]) => data.opponent === author.username);

      if (!challenge) {
        await this.twitter.v2.reply(
          `❌ No pending challenge found for @${author.username}. Make sure someone has challenged you first!`,
          tweet.data.id
        );
        return;
      }

      const [challengeId, challengeData] = challenge;

      // Check if both users have linked wallets
      const challengerWallet = this.walletRegistry.get(challengeData.challenger);
      const opponentWallet = this.walletRegistry.get(challengeData.opponent);

      if (!challengerWallet || !opponentWallet) {
        await this.twitter.v2.reply(
          `❌ Both traders must link their wallets first! Reply with "wallet: YOUR_WALLET_ADDRESS"`,
          tweet.data.id
        );
        return;
      }

      // Create duel on-chain
      const { duelPubkey } = await this.createOnChainDuel(challengeData, challengerWallet, opponentWallet);

      // Remove from pending
      this.pendingChallenges.delete(challengeId);

      // Reply with duel creation confirmation
      const replyText = `⚔️ DUEL ACCEPTED! 

🔥 @${challengeData.challenger} vs @${challengeData.opponent}
💰 Stake: ${challengeData.stakeAmount} SOL each
⏰ Duration: ${challengeData.duration} hours

🔗 Duel ID: ${duelPubkey.toString().slice(0, 8)}...

Both traders must now deposit their stakes to begin! Good luck! 🚀

#TradingDuel #LFG`;

      await this.twitter.v2.reply(replyText, tweet.data.id);

      console.log(`✅ Duel created: ${duelPubkey.toString()}`);

    } catch (error) {
      console.error('❌ Error processing acceptance:', error);
      await this.twitter.v2.reply(
        `❌ Error creating duel. Please try again or contact support.`,
        tweet.data.id
      );
    }
  }

  // Process wallet linking
  private async processWalletLinking(tweet: any, author: any): Promise<void> {
    try {
      const walletMatch = tweet.data.text.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (!walletMatch) return;

      const walletAddress = walletMatch[1];
      
      // Validate wallet address
      try {
        const pubkey = new PublicKey(walletAddress);
        this.walletRegistry.set(author.username, pubkey);

        await this.twitter.v2.reply(
          `✅ Wallet linked successfully for @${author.username}!\n\n🔗 ${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}\n\nYou can now participate in trading duels! 🚀`,
          tweet.data.id
        );

        console.log(`✅ Wallet linked: @${author.username} -> ${walletAddress}`);

      } catch (error) {
        await this.twitter.v2.reply(
          `❌ Invalid wallet address. Please check and try again.`,
          tweet.data.id
        );
      }

    } catch (error) {
      console.error('❌ Error processing wallet linking:', error);
    }
  }

  // Create duel on-chain
  private async createOnChainDuel(
    challengeData: ChallengeData,
    challengerWallet: PublicKey,
    opponentWallet: PublicKey
  ): Promise<{ duelPubkey: PublicKey }> {
    // For now, use bot keypair to create duel
    // In production, this would be handled differently
    const { duelPubkey } = await this.client.createDuel(this.botKeypair, {
      stakeAmount: new BN(challengeData.stakeAmount * 1e9), // Convert to lamports
      durationSeconds: new BN(challengeData.duration * 3600), // Convert to seconds
      allowedTokens: [], // Allow all tokens by default
    });

    return { duelPubkey };
  }

  // Post duel results
  async postDuelResults(result: DuelResult): Promise<void> {
    try {
      const winnerEmoji = result.winner === 'Creator' ? '🟢' : result.winner === 'Opponent' ? '🔴' : '🟡';
      const pnlText = result.winner === 'Draw' ? 'It\'s a draw!' : 
        `Winner PnL: ${result.winner === 'Creator' ? result.creatorPnL : result.opponentPnL}%`;

      const tweetText = `🏁 DUEL COMPLETE! ${winnerEmoji}

⚔️ ${result.creator} vs ${result.opponent}
🎯 ${pnlText}
💰 Winner takes: ${(result.winnerPayout / 1e9).toFixed(2)} SOL

📊 Final Stats:
${result.creator}: ${result.creatorPnL.toFixed(2)}% PnL
${result.opponent}: ${result.opponentPnL.toFixed(2)}% PnL

GG! Ready for another round? 🔥

#TradingDuel #SolanaTrading #DeFi`;

      await this.twitter.v2.tweet(tweetText);

      console.log(`📢 Posted duel results for ${result.duelPubkey.toString()}`);

    } catch (error) {
      console.error('❌ Error posting duel results:', error);
    }
  }

  // Post leaderboard updates
  async postLeaderboardUpdate(leaderboard: Array<{ username: string; winRate: number; totalWinnings: number }>): Promise<void> {
    try {
      const topTraders = leaderboard.slice(0, 5);
      
      let tweetText = '🏆 WEEKLY LEADERBOARD 🏆\n\n';
      
      topTraders.forEach((trader, index) => {
        const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][index];
        tweetText += `${medal} @${trader.username}\n`;
        tweetText += `   📈 ${trader.winRate.toFixed(1)}% win rate\n`;
        tweetText += `   💰 ${trader.totalWinnings.toFixed(2)} SOL earned\n\n`;
      });

      tweetText += 'Think you can make it to the top? Challenge someone now! ⚔️\n\n#TradingDuel #Leaderboard #SolanaTrading';

      await this.twitter.v2.tweet(tweetText);

      console.log('📢 Posted leaderboard update');

    } catch (error) {
      console.error('❌ Error posting leaderboard update:', error);
    }
  }

  // Get wallet for Twitter user
  getWalletForUser(username: string): PublicKey | undefined {
    return this.walletRegistry.get(username);
  }

  // Add wallet manually (for testing)
  addWalletMapping(username: string, wallet: PublicKey): void {
    this.walletRegistry.set(username, wallet);
    console.log(`✅ Added wallet mapping: @${username} -> ${wallet.toString()}`);
  }

  // Get pending challenges
  getPendingChallenges(): Map<string, ChallengeData> {
    return new Map(this.pendingChallenges);
  }

  // Clear pending challenge
  clearPendingChallenge(challengeId: string): void {
    this.pendingChallenges.delete(challengeId);
  }
}

// Helper function to create Twitter bot instance
export function createTwitterBot(
  twitterConfig: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  },
  client: TradingDuelClient,
  connection: Connection,
  botKeypair: Keypair
): TwitterBot {
  return new TwitterBot(twitterConfig, client, connection, botKeypair);
} 