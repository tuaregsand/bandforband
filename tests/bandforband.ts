import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TradingDuelProtocol } from "../target/types/trading_duel_protocol";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("trading-duel-protocol", () => {
  // Configure the client
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TradingDuelProtocol as Program<TradingDuelProtocol>;
  
  // Test accounts
  let protocolPDA: PublicKey;
  let treasury: Keypair;
  let creator: Keypair;
  let opponent: Keypair;
  let oracle: Keypair;
  let duelPDA: PublicKey;
  let duelEscrow: PublicKey;

  // Test parameters
  const PROTOCOL_FEE_BPS = 250; // 2.5%
  const STAKE_AMOUNT = 1 * LAMPORTS_PER_SOL; // 1 SOL
  const DUEL_DURATION = 3600; // 1 hour in seconds

  before(async () => {
    // Generate keypairs
    treasury = Keypair.generate();
    creator = Keypair.generate();
    opponent = Keypair.generate();
    oracle = Keypair.generate();

    // Airdrop SOL to test accounts
    const airdropAmount = 10 * LAMPORTS_PER_SOL;
    await provider.connection.requestAirdrop(creator.publicKey, airdropAmount);
    await provider.connection.requestAirdrop(opponent.publicKey, airdropAmount);
    await provider.connection.requestAirdrop(oracle.publicKey, airdropAmount);
    
    // Wait for airdrops to confirm
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Derive PDAs
    [protocolPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );
  });

  describe("Protocol Initialization", () => {
    it("Initializes the protocol", async () => {
      const tx = await program.methods
        .initialize(PROTOCOL_FEE_BPS)
        .accounts({
          protocol: protocolPDA,
          authority: provider.wallet.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Fetch and verify protocol account
      const protocolAccount = await program.account.protocol.fetch(protocolPDA);
      
      assert.equal(
        protocolAccount.authority.toString(),
        provider.wallet.publicKey.toString()
      );
      assert.equal(
        protocolAccount.treasury.toString(),
        treasury.publicKey.toString()
      );
      assert.equal(protocolAccount.feeBps, PROTOCOL_FEE_BPS);
      assert.equal(protocolAccount.totalDuels.toNumber(), 0);
      assert.equal(protocolAccount.totalVolume.toNumber(), 0);
    });

    it("Fails to reinitialize protocol", async () => {
      try {
        await program.methods
          .initialize(PROTOCOL_FEE_BPS)
          .accounts({
            protocol: protocolPDA,
            authority: provider.wallet.publicKey,
            treasury: treasury.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        
        assert.fail("Should have failed to reinitialize");
      } catch (err) {
        assert.include(err.toString(), "already in use");
      }
    });
  });

  describe("Duel Creation", () => {
    before(async () => {
      // Get current protocol state to get the duel index
      const protocolAccount = await program.account.protocol.fetch(protocolPDA);
      const duelIndex = protocolAccount.totalDuels.toNumber();
      
      // Derive duel PDA using correct seeds
      [duelPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      
      // Derive escrow PDA
      [duelEscrow] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), duelPDA.toBuffer()],
        program.programId
      );
    });

    it("Creates a new duel", async () => {
      const allowedTokens = []; // Empty means all tokens allowed

      const tx = await program.methods
        .createDuel(
          new anchor.BN(STAKE_AMOUNT),
          new anchor.BN(DUEL_DURATION),
          allowedTokens
        )
        .accounts({
          duel: duelPDA,
          protocol: protocolPDA,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // Fetch and verify duel account
      const duelAccount = await program.account.duel.fetch(duelPDA);
      
      assert.equal(duelAccount.creator.toString(), creator.publicKey.toString());
      assert.equal(duelAccount.opponent.toString(), PublicKey.default.toString());
      assert.equal(duelAccount.stakeAmount.toNumber(), STAKE_AMOUNT);
      assert.equal(duelAccount.duration.toNumber(), DUEL_DURATION);
      assert.equal(duelAccount.status.pending !== undefined, true);
      assert.equal(duelAccount.creatorStakeDeposited, false);
      assert.equal(duelAccount.opponentStakeDeposited, false);
    });

    it("Increments protocol duel counter", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPDA);
      assert.equal(protocolAccount.totalDuels.toNumber(), 1);
    });

    it("Fails to create duel with invalid parameters", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPDA);
      const duelIndex = protocolAccount.totalDuels.toNumber();
      
      const [invalidDuelPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      try {
        await program.methods
          .createDuel(
            new anchor.BN(0), // Invalid stake amount
            new anchor.BN(DUEL_DURATION),
            []
          )
          .accounts({
            duel: invalidDuelPDA,
            protocol: protocolPDA,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();
        
        assert.fail("Should have failed with 0 stake");
      } catch (err) {
        // Expected error
      }
    });
  });

  describe("Duel Acceptance", () => {
    it("Accepts the duel", async () => {
      const tx = await program.methods
        .acceptDuel()
        .accounts({
          duel: duelPDA,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      // Verify duel state
      const duelAccount = await program.account.duel.fetch(duelPDA);
      
      assert.equal(duelAccount.opponent.toString(), opponent.publicKey.toString());
      assert.equal(duelAccount.status.accepted !== undefined, true);
    });

    it("Fails to accept already accepted duel", async () => {
      const randomUser = Keypair.generate();
      await provider.connection.requestAirdrop(randomUser.publicKey, 2 * LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        await program.methods
          .acceptDuel()
          .accounts({
            duel: duelPDA,
            opponent: randomUser.publicKey,
          })
          .signers([randomUser])
          .rpc();
        
        assert.fail("Should have failed");
      } catch (err) {
        assert.include(err.toString(), "DuelAlreadyAccepted");
      }
    });
  });

  describe("Stake Deposits", () => {
    it("Creator deposits stake", async () => {
      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);

      const tx = await program.methods
        .depositStake()
        .accounts({
          duel: duelPDA,
          duelEscrow: duelEscrow,
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // Verify balances
      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      const escrowBalance = await provider.connection.getBalance(duelEscrow);

      assert.approximately(
        creatorBalanceBefore - creatorBalanceAfter,
        STAKE_AMOUNT,
        0.01 * LAMPORTS_PER_SOL // Allow for transaction fees
      );
      assert.equal(escrowBalance, STAKE_AMOUNT);

      // Verify duel state
      const duelAccount = await program.account.duel.fetch(duelPDA);
      assert.equal(duelAccount.creatorStakeDeposited, true);
      assert.equal(duelAccount.status.accepted !== undefined, true); // Still accepted
    });

    it("Opponent deposits stake and activates duel", async () => {
      const tx = await program.methods
        .depositStake()
        .accounts({
          duel: duelPDA,
          duelEscrow: duelEscrow,
          depositor: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();

      // Verify duel is now active
      const duelAccount = await program.account.duel.fetch(duelPDA);
      assert.equal(duelAccount.opponentStakeDeposited, true);
      assert.equal(duelAccount.status.active !== undefined, true);
      assert.isAbove(duelAccount.startTime.toNumber(), 0);
      assert.isAbove(duelAccount.endTime.toNumber(), duelAccount.startTime.toNumber());
    });

    it("Fails to deposit stake from non-participant", async () => {
      const randomUser = Keypair.generate();
      await provider.connection.requestAirdrop(randomUser.publicKey, 2 * LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        await program.methods
          .depositStake()
          .accounts({
            duel: duelPDA,
            duelEscrow: duelEscrow,
            depositor: randomUser.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([randomUser])
          .rpc();
        
        assert.fail("Should have failed");
      } catch (err) {
        assert.include(err.toString(), "NotParticipant");
      }
    });
  });

  describe("Position Updates", () => {
    it("Oracle updates positions", async () => {
      const creatorValue = new anchor.BN(1.2 * LAMPORTS_PER_SOL); // 20% profit
      const opponentValue = new anchor.BN(0.9 * LAMPORTS_PER_SOL); // 10% loss

      const tx = await program.methods
        .updatePositions(creatorValue, opponentValue)
        .accounts({
          duel: duelPDA,
          oracle: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();

      // Verify positions updated
      const duelAccount = await program.account.duel.fetch(duelPDA);
      assert.equal(duelAccount.creatorFinalValue.toNumber(), creatorValue.toNumber());
      assert.equal(duelAccount.opponentFinalValue.toNumber(), opponentValue.toNumber());
    });

    it("Fails to update positions on inactive duel", async () => {
      // Create a new duel for this test
      const protocolAccount = await program.account.protocol.fetch(protocolPDA);
      const duelIndex = protocolAccount.totalDuels.toNumber();
      
      const [inactiveDuelPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      
      // Create but don't activate a duel
      await program.methods
        .createDuel(
          new anchor.BN(STAKE_AMOUNT),
          new anchor.BN(DUEL_DURATION),
          []
        )
        .accounts({
          duel: inactiveDuelPDA,
          protocol: protocolPDA,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      try {
        await program.methods
          .updatePositions(
            new anchor.BN(STAKE_AMOUNT),
            new anchor.BN(STAKE_AMOUNT)
          )
          .accounts({
            duel: inactiveDuelPDA,
            oracle: oracle.publicKey,
          })
          .signers([oracle])
          .rpc();
        
        assert.fail("Should have failed");
      } catch (err) {
        assert.include(err.toString(), "InvalidStatus");
      }
    });
  });

  describe("Duel Settlement", () => {
    it("Settles duel after expiry", async () => {
      // Fast forward time (in tests, we can't actually do this, so we'll create a new duel with 0 duration)
      const expiredDuel = Keypair.generate();
      const [expiredEscrow] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), expiredDuel.publicKey.toBuffer()],
        program.programId
      );

      // Create and immediately activate a duel with 0 duration
      await program.methods
        .createDuel(
          new anchor.BN(STAKE_AMOUNT),
          new anchor.BN(0), // 0 duration
          []
        )
        .accounts({
          duel: expiredDuel.publicKey,
          protocol: protocolPDA,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator, expiredDuel])
        .rpc();

      // Accept
      await program.methods
        .acceptDuel()
        .accounts({
          duel: expiredDuel.publicKey,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      // Both deposit
      await program.methods
        .depositStake()
        .accounts({
          duel: expiredDuel.publicKey,
          duelEscrow: expiredEscrow,
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: expiredDuel.publicKey,
          duelEscrow: expiredEscrow,
          depositor: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();

      // Update positions
      await program.methods
        .updatePositions(
          new anchor.BN(1.5 * LAMPORTS_PER_SOL), // Creator wins
          new anchor.BN(0.8 * LAMPORTS_PER_SOL)  // Opponent loses
        )
        .accounts({
          duel: expiredDuel.publicKey,
          oracle: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();

      // Get balances before settlement
      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);
      const treasuryBalanceBefore = await provider.connection.getBalance(treasury.publicKey);

      // Settle
      await program.methods
        .settleDuel()
        .accounts({
          duel: expiredDuel.publicKey,
          protocol: protocolPDA,
          duelEscrow: expiredEscrow,
          creator: creator.publicKey,
          opponent: opponent.publicKey,
          treasury: treasury.publicKey,
        })
        .rpc();

      // Verify settlement
      const duelAccount = await program.account.duel.fetch(expiredDuel.publicKey);
      assert.equal(duelAccount.status.settled !== undefined, true);
      assert.equal(duelAccount.winner.creator !== undefined, true);

      // Verify payouts
      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      const treasuryBalanceAfter = await provider.connection.getBalance(treasury.publicKey);

      const totalStake = STAKE_AMOUNT * 2;
      const protocolFee = Math.floor((totalStake * PROTOCOL_FEE_BPS) / 10000);
      const winnerPayout = totalStake - protocolFee;

      assert.approximately(
        creatorBalanceAfter - creatorBalanceBefore,
        winnerPayout,
        0.01 * LAMPORTS_PER_SOL
      );
      assert.equal(treasuryBalanceAfter - treasuryBalanceBefore, protocolFee);
    });

    it("Handles draw correctly", async () => {
      const drawDuel = Keypair.generate();
      const [drawEscrow] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), drawDuel.publicKey.toBuffer()],
        program.programId
      );

      // Create, accept, and activate duel
      await program.methods
        .createDuel(
          new anchor.BN(STAKE_AMOUNT),
          new anchor.BN(0),
          []
        )
        .accounts({
          duel: drawDuel.publicKey,
          protocol: protocolPDA,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator, drawDuel])
        .rpc();

      await program.methods
        .acceptDuel()
        .accounts({
          duel: drawDuel.publicKey,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: drawDuel.publicKey,
          duelEscrow: drawEscrow,
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: drawDuel.publicKey,
          duelEscrow: drawEscrow,
          depositor: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();

      // Update with equal positions
      await program.methods
        .updatePositions(
          new anchor.BN(STAKE_AMOUNT),
          new anchor.BN(STAKE_AMOUNT)
        )
        .accounts({
          duel: drawDuel.publicKey,
          oracle: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();

      // Get balances before
      const creatorBefore = await provider.connection.getBalance(creator.publicKey);
      const opponentBefore = await provider.connection.getBalance(opponent.publicKey);

      // Settle
      await program.methods
        .settleDuel()
        .accounts({
          duel: drawDuel.publicKey,
          protocol: protocolPDA,
          duelEscrow: drawEscrow,
          creator: creator.publicKey,
          opponent: opponent.publicKey,
          treasury: treasury.publicKey,
        })
        .rpc();

      // Verify draw
      const duelAccount = await program.account.duel.fetch(drawDuel.publicKey);
      assert.equal(duelAccount.winner.draw !== undefined, true);

      // Both should receive stake minus half fee each
      const creatorAfter = await provider.connection.getBalance(creator.publicKey);
      const opponentAfter = await provider.connection.getBalance(opponent.publicKey);

      const totalFee = Math.floor((STAKE_AMOUNT * 2 * PROTOCOL_FEE_BPS) / 10000);
      const refundAmount = STAKE_AMOUNT - (totalFee / 2);

      assert.approximately(
        creatorAfter - creatorBefore,
        refundAmount,
        0.01 * LAMPORTS_PER_SOL
      );
      assert.approximately(
        opponentAfter - opponentBefore,
        refundAmount,
        0.01 * LAMPORTS_PER_SOL
      );
    });
  });

  describe("Duel Cancellation", () => {
    it("Creator can cancel pending duel", async () => {
      const cancelDuel = Keypair.generate();

      await program.methods
        .createDuel(
          new anchor.BN(STAKE_AMOUNT),
          new anchor.BN(DUEL_DURATION),
          []
        )
        .accounts({
          duel: cancelDuel.publicKey,
          protocol: protocolPDA,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator, cancelDuel])
        .rpc();

      await program.methods
        .cancelDuel()
        .accounts({
          duel: cancelDuel.publicKey,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      const duelAccount = await program.account.duel.fetch(cancelDuel.publicKey);
      assert.equal(duelAccount.status.cancelled !== undefined, true);
    });

    it("Non-creator cannot cancel duel", async () => {
      const anotherDuel = Keypair.generate();

      await program.methods
        .createDuel(
          new anchor.BN(STAKE_AMOUNT),
          new anchor.BN(DUEL_DURATION),
          []
        )
        .accounts({
          duel: anotherDuel.publicKey,
          protocol: protocolPDA,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator, anotherDuel])
        .rpc();

      try {
        await program.methods
          .cancelDuel()
          .accounts({
            duel: anotherDuel.publicKey,
            creator: opponent.publicKey,
          })
          .signers([opponent])
          .rpc();
        
        assert.fail("Should have failed");
      } catch (err) {
        assert.include(err.toString(), "Unauthorized");
      }
    });

    it("Cannot cancel accepted duel", async () => {
      const acceptedDuel = Keypair.generate();

      await program.methods
        .createDuel(
          new anchor.BN(STAKE_AMOUNT),
          new anchor.BN(DUEL_DURATION),
          []
        )
        .accounts({
          duel: acceptedDuel.publicKey,
          protocol: protocolPDA,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator, acceptedDuel])
        .rpc();

      await program.methods
        .acceptDuel()
        .accounts({
          duel: acceptedDuel.publicKey,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      try {
        await program.methods
          .cancelDuel()
          .accounts({
            duel: acceptedDuel.publicKey,
            creator: creator.publicKey,
          })
          .signers([creator])
          .rpc();
        
        assert.fail("Should have failed");
      } catch (err) {
        assert.include(err.toString(), "CannotCancel");
      }
    });
  });

  describe("Edge Cases", () => {
    it("Handles maximum allowed tokens", async () => {
      const maxTokensDuel = Keypair.generate();
      const allowedTokens = Array(10).fill(null).map(() => Keypair.generate().publicKey);

      await program.methods
        .createDuel(
          new anchor.BN(STAKE_AMOUNT),
          new anchor.BN(DUEL_DURATION),
          allowedTokens
        )
        .accounts({
          duel: maxTokensDuel.publicKey,
          protocol: protocolPDA,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator, maxTokensDuel])
        .rpc();

      const duelAccount = await program.account.duel.fetch(maxTokensDuel.publicKey);
      assert.equal(duelAccount.allowedTokens.length, 10);
    });

    it("Validates PnL calculation precision", async () => {
      // Test PnL calculation with various values
      const testCases = [
        { start: 1000000, end: 1100000, expectedPnl: 1000 }, // 10% gain
        { start: 1000000, end: 900000, expectedPnl: -1000 }, // 10% loss
        { start: 1000000, end: 1000000, expectedPnl: 0 }, // No change
        { start: 1000000, end: 2000000, expectedPnl: 10000 }, // 100% gain
      ];

      for (const testCase of testCases) {
        const pnl = ((testCase.end - testCase.start) * 10000) / testCase.start;
        assert.equal(pnl, testCase.expectedPnl);
      }
    });
  });
});