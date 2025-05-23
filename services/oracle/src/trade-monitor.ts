import { Connection, PublicKey, GetProgramAccountsFilter, Keypair } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { TradingDuelClient } from '../../../client/src/program';
import { Jupiter } from '@jup-ag/api';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// DEX Program IDs
const DEX_PROGRAM_IDS = {
  RAYDIUM_V4: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  RAYDIUM_CLMM: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUQpMEXYP1e92HgQhG'),
  METEORA: new PublicKey('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB'),
  JUPITER: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
  PUMP_FUN: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  WHIRLPOOL: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
} as const;

// Token accounts and pricing
interface TokenBalance {
  mint: PublicKey;
  amount: BN;
  uiAmount: number;
  decimals: number;
}

interface PortfolioValue {
  totalValue: number; // In USD
  tokens: TokenBalance[];
  lastUpdated: number;
}

interface DuelMonitor {
  duelPubkey: PublicKey;
  creatorWallet: PublicKey;
  opponentWallet: PublicKey;
  startTime: number;
  endTime: number;
  lastUpdate: number;
}

export class TradeOracle {
  private connection: Connection;
  private client: TradingDuelClient;
  private oracleKeypair: Keypair;
  private activeMonitors: Map<string, DuelMonitor> = new Map();
  private jupiter: Jupiter;
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  private readonly PRICE_CACHE_TTL = 30_000; // 30 seconds

  constructor(
    connection: Connection, 
    client: TradingDuelClient,
    oracleKeypair: Keypair
  ) {
    this.connection = connection;
    this.client = client;
    this.oracleKeypair = oracleKeypair;
    this.jupiter = new Jupiter({
      connection,
      cluster: 'mainnet-beta', // or 'devnet'
      user: oracleKeypair,
    });
  }

  // Start monitoring active duels
  async startMonitoring(): Promise<void> {
    console.log('🔍 Starting trade oracle monitoring...');
    
    // Load active duels
    await this.loadActiveDuels();
    
    // Set up periodic monitoring
    setInterval(async () => {
      await this.updateAllPositions();
    }, 10_000); // Update every 10 seconds

    // Set up duel settlement monitoring  
    setInterval(async () => {
      await this.checkForSettlements();
    }, 30_000); // Check for settlements every 30 seconds

    console.log(`📊 Monitoring ${this.activeMonitors.size} active duels`);
  }

  // Load all active duels from the program
  private async loadActiveDuels(): Promise<void> {
    try {
      const allDuels = await this.client.getActiveDuels();
      
      for (const { pubkey, account } of allDuels) {
        if (account.status === 'Active') {
          this.activeMonitors.set(pubkey.toString(), {
            duelPubkey: pubkey,
            creatorWallet: account.creator,
            opponentWallet: account.opponent,
            startTime: account.startTime.toNumber(),
            endTime: account.endTime.toNumber(),
            lastUpdate: 0,
          });
        }
      }
    } catch (error) {
      console.error('❌ Error loading active duels:', error);
    }
  }

  // Update positions for all active duels
  private async updateAllPositions(): Promise<void> {
    const updates = Array.from(this.activeMonitors.values()).map(monitor => 
      this.updateDuelPositions(monitor)
    );

    await Promise.allSettled(updates);
  }

  // Update positions for a specific duel
  private async updateDuelPositions(monitor: DuelMonitor): Promise<void> {
    try {
      // Get current portfolio values
      const [creatorValue, opponentValue] = await Promise.all([
        this.calculatePortfolioValue(monitor.creatorWallet),
        this.calculatePortfolioValue(monitor.opponentWallet),
      ]);

      // Update on-chain positions
      await this.client.updatePositions(
        this.oracleKeypair,
        monitor.duelPubkey,
        new BN(Math.floor(creatorValue.totalValue * 1_000_000)), // Convert to lamports equivalent
        new BN(Math.floor(opponentValue.totalValue * 1_000_000))
      );

      monitor.lastUpdate = Date.now();

      console.log(`📈 Updated positions for duel ${monitor.duelPubkey.toString().slice(0, 8)}...`);
      console.log(`   Creator: $${creatorValue.totalValue.toFixed(2)}`);
      console.log(`   Opponent: $${opponentValue.totalValue.toFixed(2)}`);

    } catch (error) {
      console.error(`❌ Error updating duel ${monitor.duelPubkey.toString()}:`, error);
    }
  }

  // Calculate total portfolio value for a wallet
  private async calculatePortfolioValue(wallet: PublicKey): Promise<PortfolioValue> {
    try {
      // Get all token accounts for the wallet
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(wallet, {
        programId: TOKEN_PROGRAM_ID,
      });

      const tokens: TokenBalance[] = [];
      let totalValue = 0;

      // Get SOL balance
      const solBalance = await this.connection.getBalance(wallet);
      const solPrice = await this.getTokenPrice('So11111111111111111111111111111111111111112'); // Wrapped SOL
      const solValue = (solBalance / 1e9) * solPrice;
      totalValue += solValue;

      tokens.push({
        mint: new PublicKey('So11111111111111111111111111111111111111112'),
        amount: new BN(solBalance),
        uiAmount: solBalance / 1e9,
        decimals: 9,
      });

      // Process each token account
      for (const { account } of tokenAccounts.value) {
        const mintAddress = account.data.parsed.info.mint;
        const tokenAmount = account.data.parsed.info.tokenAmount;
        
        if (tokenAmount.uiAmount && tokenAmount.uiAmount > 0) {
          const price = await this.getTokenPrice(mintAddress);
          const value = tokenAmount.uiAmount * price;
          totalValue += value;

          tokens.push({
            mint: new PublicKey(mintAddress),
            amount: new BN(tokenAmount.amount),
            uiAmount: tokenAmount.uiAmount,
            decimals: tokenAmount.decimals,
          });
        }
      }

      return {
        totalValue,
        tokens,
        lastUpdated: Date.now(),
      };

    } catch (error) {
      console.error(`❌ Error calculating portfolio value for ${wallet.toString()}:`, error);
      return { totalValue: 0, tokens: [], lastUpdated: Date.now() };
    }
  }

  // Get token price with caching
  private async getTokenPrice(mintAddress: string): Promise<number> {
    const cached = this.priceCache.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < this.PRICE_CACHE_TTL) {
      return cached.price;
    }

    try {
      // Use Jupiter price API
      const response = await fetch(`https://price.jup.ag/v6/price?ids=${mintAddress}`);
      const data = await response.json();
      
      const price = data.data?.[mintAddress]?.price || 0;
      
      this.priceCache.set(mintAddress, {
        price,
        timestamp: Date.now(),
      });

      return price;
    } catch (error) {
      console.error(`❌ Error fetching price for ${mintAddress}:`, error);
      return 0;
    }
  }

  // Check for duels that need settlement
  private async checkForSettlements(): Promise<void> {
    const now = Date.now() / 1000; // Convert to seconds

    for (const [duelKey, monitor] of this.activeMonitors) {
      if (now >= monitor.endTime) {
        try {
          console.log(`⏰ Settling expired duel ${duelKey.slice(0, 8)}...`);
          
          await this.client.settleDuel(
            monitor.duelPubkey,
            monitor.creatorWallet,
            monitor.opponentWallet
          );

          // Remove from active monitoring
          this.activeMonitors.delete(duelKey);
          
          console.log(`✅ Duel ${duelKey.slice(0, 8)}... settled successfully`);
        } catch (error) {
          console.error(`❌ Error settling duel ${duelKey}:`, error);
        }
      }
    }
  }

  // Monitor for new DEX transactions from duel participants
  async monitorDEXTransactions(): Promise<void> {
    console.log('🔍 Starting DEX transaction monitoring...');

    // Monitor each DEX program
    for (const [dexName, programId] of Object.entries(DEX_PROGRAM_IDS)) {
      this.connection.onLogs(programId, (logs, ctx) => {
        this.processDEXLogs(dexName, logs, ctx);
      });
    }
  }

  // Process DEX transaction logs
  private processDEXLogs(dexName: string, logs: any, ctx: any): void {
    // Extract relevant transaction data
    const signature = ctx.signature;
    
    // Check if any of our monitored wallets are involved
    for (const monitor of this.activeMonitors.values()) {
      // This would need more sophisticated parsing of transaction logs
      // to determine if the creator or opponent made a trade
      console.log(`📊 ${dexName} transaction detected: ${signature}`);
    }
  }

  // Add a new duel to monitoring
  async addDuelToMonitoring(duelPubkey: PublicKey): Promise<void> {
    try {
      const duelAccount = await this.client.fetchDuel(duelPubkey);
      
      if (duelAccount.status === 'Active') {
        this.activeMonitors.set(duelPubkey.toString(), {
          duelPubkey,
          creatorWallet: duelAccount.creator,
          opponentWallet: duelAccount.opponent,
          startTime: duelAccount.startTime.toNumber(),
          endTime: duelAccount.endTime.toNumber(),
          lastUpdate: 0,
        });

        console.log(`✅ Added duel ${duelPubkey.toString().slice(0, 8)}... to monitoring`);
      }
    } catch (error) {
      console.error(`❌ Error adding duel to monitoring:`, error);
    }
  }

  // Remove a duel from monitoring
  removeDuelFromMonitoring(duelPubkey: PublicKey): void {
    this.activeMonitors.delete(duelPubkey.toString());
    console.log(`🗑️ Removed duel ${duelPubkey.toString().slice(0, 8)}... from monitoring`);
  }

  // Get monitoring statistics
  getMonitoringStats(): {
    activeDuels: number;
    totalMonitored: number;
    lastUpdate: number;
  } {
    const lastUpdates = Array.from(this.activeMonitors.values()).map(m => m.lastUpdate);
    
    return {
      activeDuels: this.activeMonitors.size,
      totalMonitored: this.activeMonitors.size,
      lastUpdate: Math.max(...lastUpdates, 0),
    };
  }
}

// Helper function to start the oracle service
export async function startOracle(
  connection: Connection,
  client: TradingDuelClient,
  oracleKeypair: Keypair
): Promise<TradeOracle> {
  const oracle = new TradeOracle(connection, client, oracleKeypair);
  
  await oracle.startMonitoring();
  await oracle.monitorDEXTransactions();
  
  return oracle;
} 