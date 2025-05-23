import { 
  Connection, 
  PublicKey, 
  Transaction,
  Keypair,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY
} from '@solana/web3.js';
import { BN, Program, Provider, web3, AnchorProvider } from '@coral-xyz/anchor';
import { TradingDuelProtocol } from '../../target/types/trading_duel_protocol';
import idl from '../../target/idl/trading_duel_protocol.json';

export const TRADING_DUEL_PROGRAM_ID = new PublicKey('2tjZvgNNXxGhHm6dzQx65rbVbEb8ZtJRN95gcgeE8bo8');
const IDL = idl as TradingDuelProtocol;

export enum DuelStatus {
  Pending = 'Pending',
  Accepted = 'Accepted', 
  Active = 'Active',
  Settled = 'Settled',
  Cancelled = 'Cancelled'
}

export enum DuelWinner {
  None = 'None',
  Creator = 'Creator',
  Opponent = 'Opponent',
  Draw = 'Draw'
}

export interface CreateDuelParams {
  stakeAmount: BN;
  durationSeconds: BN;
  allowedTokens: PublicKey[];
  opponent?: PublicKey;
}

export interface DuelAccount {
  creator: PublicKey;
  opponent: PublicKey;
  stakeAmount: BN;
  createdAt: BN;
  startTime: BN;
  endTime: BN;
  duration: BN;
  status: DuelStatus;
  winner: DuelWinner;
  creatorStakeDeposited: boolean;
  opponentStakeDeposited: boolean;
  allowedTokens: PublicKey[];
  creatorStartingValue: BN;
  opponentStartingValue: BN;
  creatorFinalValue: BN;
  opponentFinalValue: BN;
}

export class TradingDuelClient {
  program: Program;
  provider: AnchorProvider;
  
  constructor(provider: AnchorProvider) {
    this.provider = provider;
    this.program = new Program(IDL, TRADING_DUEL_PROGRAM_ID, provider);
  }

  // Get protocol PDA
  getProtocolAddress(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('protocol')],
      TRADING_DUEL_PROGRAM_ID
    );
  }

  // Get duel PDA
  getDuelAddress(duelIndex: number): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('duel'), new BN(duelIndex).toArrayLike(Buffer, 'le', 8)],
      TRADING_DUEL_PROGRAM_ID
    );
  }

  // Get escrow PDA
  getEscrowAddress(duelPubkey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), duelPubkey.toBuffer()],
      TRADING_DUEL_PROGRAM_ID
    );
  }

  // Initialize the protocol (admin only)
  async initialize(
    authority: Keypair,
    treasury: PublicKey,
    protocolFeeBps: number
  ): Promise<string> {
    const [protocolPda] = this.getProtocolAddress();

    const tx = await this.program.methods
      .initialize(protocolFeeBps)
      .accounts({
        protocol: protocolPda,
        authority: authority.publicKey,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    return tx;
  }

  // Create a new duel
  async createDuel(
    creator: Keypair,
    params: CreateDuelParams
  ): Promise<{ duelPubkey: PublicKey; signature: string }> {
    const [protocolPda] = this.getProtocolAddress();
    const protocol = await this.program.account.protocol.fetch(protocolPda);
    const duelIndex = protocol.totalDuels.toNumber();
    
    const [duelPda] = this.getDuelAddress(duelIndex);

    const tx = await this.program.methods
      .createDuel(
        params.stakeAmount,
        params.durationSeconds,
        params.allowedTokens
      )
      .accounts({
        duel: duelPda,
        protocol: protocolPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    return { duelPubkey: duelPda, signature: tx };
  }

  // Accept a duel challenge
  async acceptDuel(
    opponent: Keypair,
    duelPubkey: PublicKey
  ): Promise<string> {
    const tx = await this.program.methods
      .acceptDuel()
      .accounts({
        duel: duelPubkey,
        opponent: opponent.publicKey,
      })
      .signers([opponent])
      .rpc();

    return tx;
  }

  // Deposit stake for a duel
  async depositStake(
    depositor: Keypair,
    duelPubkey: PublicKey
  ): Promise<string> {
    const [escrowPda] = this.getEscrowAddress(duelPubkey);

    const tx = await this.program.methods
      .depositStake()
      .accounts({
        duel: duelPubkey,
        duelEscrow: escrowPda,
        depositor: depositor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    return tx;
  }

  // Update positions (oracle only)
  async updatePositions(
    oracle: Keypair,
    duelPubkey: PublicKey,
    creatorValue: BN,
    opponentValue: BN
  ): Promise<string> {
    const tx = await this.program.methods
      .updatePositions(creatorValue, opponentValue)
      .accounts({
        duel: duelPubkey,
        oracle: oracle.publicKey,
      })
      .signers([oracle])
      .rpc();

    return tx;
  }

  // Settle a duel
  async settleDuel(
    duelPubkey: PublicKey,
    creator: PublicKey,
    opponent: PublicKey
  ): Promise<string> {
    const [protocolPda] = this.getProtocolAddress();
    const [escrowPda] = this.getEscrowAddress(duelPubkey);
    
    const protocol = await this.program.account.protocol.fetch(protocolPda);

    const tx = await this.program.methods
      .settleDuel()
      .accounts({
        duel: duelPubkey,
        protocol: protocolPda,
        duelEscrow: escrowPda,
        creator,
        opponent,
        treasury: protocol.treasury,
      })
      .rpc();

    return tx;
  }

  // Cancel a pending duel
  async cancelDuel(
    creator: Keypair,
    duelPubkey: PublicKey
  ): Promise<string> {
    const tx = await this.program.methods
      .cancelDuel()
      .accounts({
        duel: duelPubkey,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    return tx;
  }

  // Fetch duel account
  async fetchDuel(duelPubkey: PublicKey): Promise<DuelAccount> {
    return await this.program.account.duel.fetch(duelPubkey);
  }

  // Fetch protocol stats
  async fetchProtocol(): Promise<any> {
    const [protocolPda] = this.getProtocolAddress();
    return await this.program.account.protocol.fetch(protocolPda);
  }

  // Get all duels for a user
  async getUserDuels(userPubkey: PublicKey): Promise<{ pubkey: PublicKey; account: DuelAccount }[]> {
    const duels = await this.program.account.duel.all([
      {
        memcmp: {
          offset: 8, // Skip discriminator
          bytes: userPubkey.toBase58(),
        },
      },
    ]);

    // Also search as opponent
    const opponentDuels = await this.program.account.duel.all([
      {
        memcmp: {
          offset: 8 + 32, // Skip discriminator + creator
          bytes: userPubkey.toBase58(),
        },
      },
    ]);

    return [...duels, ...opponentDuels];
  }

  // Get active duels
  async getActiveDuels(): Promise<{ pubkey: PublicKey; account: DuelAccount }[]> {
    return await this.program.account.duel.all();
  }

  // Subscribe to duel events
  subscribeToEvents(callback: (event: any) => void) {
    return this.program.addEventListener('positionUpdate', callback);
  }

  // Calculate current PnL
  calculatePnL(startingValue: BN, currentValue: BN): number {
    if (startingValue.isZero()) return 0;
    
    const diff = currentValue.sub(startingValue);
    return diff.mul(new BN(10000)).div(startingValue).toNumber();
  }
}

// Helper function to create client instance
export function createTradingDuelClient(
  connection: Connection,
  wallet: any
): TradingDuelClient {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  
  return new TradingDuelClient(provider);
} 