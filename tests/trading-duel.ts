import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TradingDuelProtocol } from "../target/types/trading_duel_protocol";
import { expect } from "chai";

describe("Trading Duel Protocol", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TradingDuelProtocol as Program<TradingDuelProtocol>;
  
  // Test accounts
  let authority: Keypair;
  let treasury: Keypair;
  let creator: Keypair;
  let opponent: Keypair;
  let oracle: Keypair;
  
  // PDAs
  let protocolPda: PublicKey;
  let protocolBump: number;
  let duelPda: PublicKey;
  let duelBump: number;
  let escrowPda: PublicKey;
  let escrowBump: number;

  before(async () => {
    // Initialize test accounts
    authority = Keypair.generate();
    treasury = Keypair.generate();
    creator = Keypair.generate();
    opponent = Keypair.generate();
    oracle = Keypair.generate();

    // Airdrop SOL to test accounts
    await Promise.all([
      provider.connection.requestAirdrop(authority.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(creator.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(opponent.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(oracle.publicKey, 2 * LAMPORTS_PER_SOL),
    ]);

    // Wait for airdrops to confirm
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Find PDAs
    [protocolPda, protocolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );
  });

  describe("Protocol Initialization", () => {
    it("Should initialize the protocol successfully", async () => {
      const protocolFeeBps = 250; // 2.5%

      await program.methods
        .initialize(protocolFeeBps)
        .accounts({
          protocol: protocolPda,
          authority: authority.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      // Verify protocol state
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      expect(protocolAccount.authority.toString()).to.equal(authority.publicKey.toString());
      expect(protocolAccount.treasury.toString()).to.equal(treasury.publicKey.toString());
      expect(protocolAccount.feeBps).to.equal(protocolFeeBps);
      expect(protocolAccount.totalDuels.toNumber()).to.equal(0);
      expect(protocolAccount.totalVolume.toNumber()).to.equal(0);
    });

    it("Should fail to initialize with the same authority", async () => {
      try {
        await program.methods
          .initialize(250)
          .accounts({
            protocol: protocolPda,
            authority: authority.publicKey,
            treasury: treasury.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc();
        
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("already in use");
      }
    });
  });

  describe("Duel Creation", () => {
    it("Should create a duel successfully", async () => {
      const stakeAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
      const duration = new anchor.BN(3600); // 1 hour
      const allowedTokens: PublicKey[] = [];

      // Get current protocol state for duel index
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      [duelPda, duelBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      await program.methods
        .createDuel(stakeAmount, duration, allowedTokens)
        .accounts({
          duel: duelPda,
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // Verify duel state
      const duelAccount = await program.account.duel.fetch(duelPda);
      expect(duelAccount.creator.toString()).to.equal(creator.publicKey.toString());
      expect(duelAccount.stakeAmount.toNumber()).to.equal(stakeAmount.toNumber());
      expect(duelAccount.duration.toNumber()).to.equal(duration.toNumber());
      expect(duelAccount.status).to.deep.equal({ pending: {} });
      expect(duelAccount.creatorStakeDeposited).to.be.false;
      expect(duelAccount.opponentStakeDeposited).to.be.false;

      // Verify protocol stats updated
      const updatedProtocol = await program.account.protocol.fetch(protocolPda);
      expect(updatedProtocol.totalDuels.toNumber()).to.equal(1);
    });

    it("Should fail with invalid stake amount", async () => {
      const stakeAmount = new anchor.BN(0); // Invalid
      const duration = new anchor.BN(3600);
      const allowedTokens: PublicKey[] = [];

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      [duelPda, duelBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      try {
        await program.methods
          .createDuel(stakeAmount, duration, allowedTokens)
          .accounts({
            duel: duelPda,
            protocol: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();
        
        expect.fail("Should have failed with zero stake amount");
      } catch (error) {
        // Should fail due to validation
      }
    });
  });

  describe("Duel Acceptance", () => {
    let testDuelPda: PublicKey;

    before(async () => {
      // Create a duel for testing acceptance
      const stakeAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
      const duration = new anchor.BN(1800); // 30 minutes
      const allowedTokens: PublicKey[] = [];

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      [testDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      await program.methods
        .createDuel(stakeAmount, duration, allowedTokens)
        .accounts({
          duel: testDuelPda,
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();
    });

    it("Should accept a duel successfully", async () => {
      await program.methods
        .acceptDuel()
        .accounts({
          duel: testDuelPda,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      // Verify duel state
      const duelAccount = await program.account.duel.fetch(testDuelPda);
      expect(duelAccount.opponent.toString()).to.equal(opponent.publicKey.toString());
      expect(duelAccount.status).to.deep.equal({ accepted: {} });
    });

    it("Should fail to accept already accepted duel", async () => {
      const anotherOpponent = Keypair.generate();
      await provider.connection.requestAirdrop(anotherOpponent.publicKey, LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        await program.methods
          .acceptDuel()
          .accounts({
            duel: testDuelPda,
            opponent: anotherOpponent.publicKey,
          })
          .signers([anotherOpponent])
          .rpc();
        
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("DuelAlreadyAccepted");
      }
    });
  });

  describe("Stake Deposits", () => {
    let testDuelPda: PublicKey;
    let testEscrowPda: PublicKey;

    before(async () => {
      // Create and accept a duel for testing deposits
      const stakeAmount = new anchor.BN(0.25 * LAMPORTS_PER_SOL);
      const duration = new anchor.BN(900); // 15 minutes
      const allowedTokens: PublicKey[] = [];

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      [testDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      [testEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), testDuelPda.toBuffer()],
        program.programId
      );

      // Create duel
      await program.methods
        .createDuel(stakeAmount, duration, allowedTokens)
        .accounts({
          duel: testDuelPda,
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // Accept duel
      await program.methods
        .acceptDuel()
        .accounts({
          duel: testDuelPda,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();
    });

    it("Should allow creator to deposit stake", async () => {
      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);

      await program.methods
        .depositStake()
        .accounts({
          duel: testDuelPda,
          duelEscrow: testEscrowPda,
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // Verify duel state
      const duelAccount = await program.account.duel.fetch(testDuelPda);
      expect(duelAccount.creatorStakeDeposited).to.be.true;

      // Verify balance change
      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      expect(creatorBalanceBefore - creatorBalanceAfter).to.be.approximately(
        0.25 * LAMPORTS_PER_SOL, 
        0.01 * LAMPORTS_PER_SOL // Account for transaction fees
      );
    });

    it("Should allow opponent to deposit stake and start duel", async () => {
      const opponentBalanceBefore = await provider.connection.getBalance(opponent.publicKey);

      await program.methods
        .depositStake()
        .accounts({
          duel: testDuelPda,
          duelEscrow: testEscrowPda,
          depositor: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();

      // Verify duel state
      const duelAccount = await program.account.duel.fetch(testDuelPda);
      expect(duelAccount.opponentStakeDeposited).to.be.true;
      expect(duelAccount.status).to.deep.equal({ active: {} });
      expect(duelAccount.startTime.toNumber()).to.be.greaterThan(0);
      expect(duelAccount.endTime.toNumber()).to.be.greaterThan(duelAccount.startTime.toNumber());

      // Verify balance change
      const opponentBalanceAfter = await provider.connection.getBalance(opponent.publicKey);
      expect(opponentBalanceBefore - opponentBalanceAfter).to.be.approximately(
        0.25 * LAMPORTS_PER_SOL, 
        0.01 * LAMPORTS_PER_SOL // Account for transaction fees
      );

      // Verify escrow balance
      const escrowBalance = await provider.connection.getBalance(testEscrowPda);
      expect(escrowBalance).to.equal(0.5 * LAMPORTS_PER_SOL);
    });
  });

  describe("Position Updates", () => {
    let activeDuelPda: PublicKey;

    before(async () => {
      // Create, accept, and fund a duel for testing position updates
      const stakeAmount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
      const duration = new anchor.BN(600); // 10 minutes
      const allowedTokens: PublicKey[] = [];

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      [activeDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), activeDuelPda.toBuffer()],
        program.programId
      );

      // Create, accept, and fund the duel
      await program.methods
        .createDuel(stakeAmount, duration, allowedTokens)
        .accounts({
          duel: activeDuelPda,
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .acceptDuel()
        .accounts({
          duel: activeDuelPda,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: activeDuelPda,
          duelEscrow: escrowPda,
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: activeDuelPda,
          duelEscrow: escrowPda,
          depositor: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();
    });

    it("Should update positions successfully", async () => {
      const creatorValue = new anchor.BN(0.12 * LAMPORTS_PER_SOL); // 20% gain
      const opponentValue = new anchor.BN(0.08 * LAMPORTS_PER_SOL); // 20% loss

      await program.methods
        .updatePositions(creatorValue, opponentValue)
        .accounts({
          duel: activeDuelPda,
          oracle: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();

      // Verify position updates
      const duelAccount = await program.account.duel.fetch(activeDuelPda);
      expect(duelAccount.creatorFinalValue.toNumber()).to.equal(creatorValue.toNumber());
      expect(duelAccount.opponentFinalValue.toNumber()).to.equal(opponentValue.toNumber());
    });

    it("Should fail to update positions when duel is not active", async () => {
      // Try to update a pending duel
      const stakeAmount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
      const duration = new anchor.BN(600);
      const allowedTokens: PublicKey[] = [];

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [pendingDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      await program.methods
        .createDuel(stakeAmount, duration, allowedTokens)
        .accounts({
          duel: pendingDuelPda,
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      try {
        await program.methods
          .updatePositions(new anchor.BN(0.1 * LAMPORTS_PER_SOL), new anchor.BN(0.1 * LAMPORTS_PER_SOL))
          .accounts({
            duel: pendingDuelPda,
            oracle: oracle.publicKey,
          })
          .signers([oracle])
          .rpc();
        
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("InvalidStatus");
      }
    });
  });

  describe("Duel Settlement", () => {
    let settleDuelPda: PublicKey;
    let settleEscrowPda: PublicKey;

    before(async () => {
      // Create a quick duel for testing settlement
      const stakeAmount = new anchor.BN(0.2 * LAMPORTS_PER_SOL);
      const duration = new anchor.BN(1); // 1 second for quick expiry
      const allowedTokens: PublicKey[] = [];

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      [settleDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      [settleEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), settleDuelPda.toBuffer()],
        program.programId
      );

      // Create, accept, and fund the duel
      await program.methods
        .createDuel(stakeAmount, duration, allowedTokens)
        .accounts({
          duel: settleDuelPda,
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .acceptDuel()
        .accounts({
          duel: settleDuelPda,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: settleDuelPda,
          duelEscrow: settleEscrowPda,
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: settleDuelPda,
          duelEscrow: settleEscrowPda,
          depositor: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();

      // Update positions
      const creatorValue = new anchor.BN(0.25 * LAMPORTS_PER_SOL); // 25% gain
      const opponentValue = new anchor.BN(0.15 * LAMPORTS_PER_SOL); // 25% loss

      await program.methods
        .updatePositions(creatorValue, opponentValue)
        .accounts({
          duel: settleDuelPda,
          oracle: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();

      // Wait for duel to expire
      await new Promise(resolve => setTimeout(resolve, 2000));
    });

    it("Should settle duel and distribute winnings correctly", async () => {
      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);
      const opponentBalanceBefore = await provider.connection.getBalance(opponent.publicKey);
      const treasuryBalanceBefore = await provider.connection.getBalance(treasury.publicKey);

      await program.methods
        .settleDuel()
        .accounts({
          duel: settleDuelPda,
          protocol: protocolPda,
          duelEscrow: settleEscrowPda,
          creator: creator.publicKey,
          opponent: opponent.publicKey,
          treasury: treasury.publicKey,
        })
        .rpc();

      // Verify duel state
      const duelAccount = await program.account.duel.fetch(settleDuelPda);
      expect(duelAccount.status).to.deep.equal({ settled: {} });
      expect(duelAccount.winner).to.deep.equal({ creator: {} }); // Creator won with higher PnL

      // Verify payouts
      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      const treasuryBalanceAfter = await provider.connection.getBalance(treasury.publicKey);

      // Creator should receive winnings (total stake minus protocol fee)
      const totalStake = 0.4 * LAMPORTS_PER_SOL;
      const protocolFee = totalStake * 0.025; // 2.5% fee
      const expectedWinnings = totalStake - protocolFee;

      expect(creatorBalanceAfter - creatorBalanceBefore).to.be.approximately(
        expectedWinnings,
        0.01 * LAMPORTS_PER_SOL
      );

      // Treasury should receive protocol fee
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.be.approximately(
        protocolFee,
        0.001 * LAMPORTS_PER_SOL
      );

      // Verify protocol stats updated
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      expect(protocolAccount.totalVolume.toNumber()).to.be.greaterThan(0);
    });

    it("Should fail to settle non-expired duel", async () => {
      // Create a duel with longer duration
      const stakeAmount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
      const duration = new anchor.BN(3600); // 1 hour
      const allowedTokens: PublicKey[] = [];

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [longDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [longEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), longDuelPda.toBuffer()],
        program.programId
      );

      // Create and start the duel
      await program.methods
        .createDuel(stakeAmount, duration, allowedTokens)
        .accounts({
          duel: longDuelPda,
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .acceptDuel()
        .accounts({
          duel: longDuelPda,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: longDuelPda,
          duelEscrow: longEscrowPda,
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: longDuelPda,
          duelEscrow: longEscrowPda,
          depositor: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();

      // Try to settle before expiry
      try {
        await program.methods
          .settleDuel()
          .accounts({
            duel: longDuelPda,
            protocol: protocolPda,
            duelEscrow: longEscrowPda,
            creator: creator.publicKey,
            opponent: opponent.publicKey,
            treasury: treasury.publicKey,
          })
          .rpc();
        
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("DuelNotExpired");
      }
    });
  });

  describe("Duel Cancellation", () => {
    it("Should allow creator to cancel pending duel", async () => {
      const stakeAmount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
      const duration = new anchor.BN(3600);
      const allowedTokens: PublicKey[] = [];

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [cancelDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      // Create duel
      await program.methods
        .createDuel(stakeAmount, duration, allowedTokens)
        .accounts({
          duel: cancelDuelPda,
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // Cancel duel
      await program.methods
        .cancelDuel()
        .accounts({
          duel: cancelDuelPda,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      // Verify duel state
      const duelAccount = await program.account.duel.fetch(cancelDuelPda);
      expect(duelAccount.status).to.deep.equal({ cancelled: {} });
    });

    it("Should fail to cancel accepted duel", async () => {
      const stakeAmount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
      const duration = new anchor.BN(3600);
      const allowedTokens: PublicKey[] = [];

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [acceptedDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      // Create and accept duel
      await program.methods
        .createDuel(stakeAmount, duration, allowedTokens)
        .accounts({
          duel: acceptedDuelPda,
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .acceptDuel()
        .accounts({
          duel: acceptedDuelPda,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      // Try to cancel
      try {
        await program.methods
          .cancelDuel()
          .accounts({
            duel: acceptedDuelPda,
            creator: creator.publicKey,
          })
          .signers([creator])
          .rpc();
        
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("CannotCancel");
      }
    });
  });
}); 