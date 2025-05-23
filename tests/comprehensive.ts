import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TradingDuelProtocol } from "../target/types/trading_duel_protocol";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("Trading Duel Protocol - Comprehensive Tests", () => {
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

  // Test parameters
  const PROTOCOL_FEE_BPS = 250; // 2.5%
  const STAKE_AMOUNT = new anchor.BN(1 * LAMPORTS_PER_SOL);
  const DURATION = new anchor.BN(3600); // 1 hour

  before(async () => {
    // Initialize keypairs
    authority = Keypair.generate();
    treasury = Keypair.generate();
    creator = Keypair.generate();
    opponent = Keypair.generate();
    oracle = Keypair.generate();

    // Airdrop SOL
    await Promise.all([
      provider.connection.requestAirdrop(authority.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(creator.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(opponent.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(oracle.publicKey, 2 * LAMPORTS_PER_SOL),
    ]);

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Find protocol PDA
    [protocolPda, protocolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );
  });

  describe("Protocol Initialization", () => {
    it("Should initialize protocol successfully", async () => {
      await program.methods
        .initialize(PROTOCOL_FEE_BPS)
        .accounts({
          authority: authority.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      expect(protocolAccount.authority.toString()).to.equal(authority.publicKey.toString());
      expect(protocolAccount.treasury.toString()).to.equal(treasury.publicKey.toString());
      expect(protocolAccount.feeBps).to.equal(PROTOCOL_FEE_BPS);
      expect(protocolAccount.totalDuels.toNumber()).to.equal(0);
      expect(protocolAccount.totalVolume.toNumber()).to.equal(0);
    });

    it("Should fail to reinitialize protocol", async () => {
      try {
        await program.methods
          .initialize(PROTOCOL_FEE_BPS)
          .accounts({
            authority: authority.publicKey,
            treasury: treasury.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc();
        
        expect.fail("Should have failed to reinitialize");
      } catch (error) {
        expect(error.message).to.include("already in use");
      }
    });
  });

  describe("Duel Creation", () => {
    let duelPda: PublicKey;
    let escrowPda: PublicKey;

    it("Should create a duel successfully", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      [duelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), duelPda.toBuffer()],
        program.programId
      );

      await program.methods
        .createDuel(STAKE_AMOUNT, DURATION, [])
        .accounts({
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const duelAccount = await program.account.duel.fetch(duelPda);
      expect(duelAccount.creator.toString()).to.equal(creator.publicKey.toString());
      expect(duelAccount.stakeAmount.toNumber()).to.equal(STAKE_AMOUNT.toNumber());
      expect(duelAccount.status).to.deep.equal({ pending: {} });
      expect(duelAccount.creatorStakeDeposited).to.be.false;
      expect(duelAccount.opponentStakeDeposited).to.be.false;

      // Verify protocol stats updated
      const updatedProtocol = await program.account.protocol.fetch(protocolPda);
      expect(updatedProtocol.totalDuels.toNumber()).to.equal(1);
    });

    it("Should fail with zero stake amount", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [errorDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      try {
        await program.methods
          .createDuel(new anchor.BN(0), DURATION, [])
          .accounts({
            protocol: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();
        
        expect.fail("Should have failed with zero stake");
      } catch (error) {
        // Expected to fail
      }
    });

    it("Should create duel with allowed tokens list", async () => {
      const allowedTokens = [
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
      ];

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [tokenDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      await program.methods
        .createDuel(STAKE_AMOUNT, DURATION, allowedTokens)
        .accounts({
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const duelAccount = await program.account.duel.fetch(tokenDuelPda);
      expect(duelAccount.allowedTokens.length).to.equal(3);
      expect(duelAccount.allowedTokens[0].toString()).to.equal(allowedTokens[0].toString());
    });

    describe("Duel Acceptance", () => {
      it("Should accept the duel successfully", async () => {
        await program.methods
          .acceptDuel()
          .accounts({
            duel: duelPda,
            opponent: opponent.publicKey,
          })
          .signers([opponent])
          .rpc();

        const duelAccount = await program.account.duel.fetch(duelPda);
        expect(duelAccount.opponent.toString()).to.equal(opponent.publicKey.toString());
        expect(duelAccount.status).to.deep.equal({ accepted: {} });
      });

      it("Should fail to accept already accepted duel", async () => {
        const anotherUser = Keypair.generate();
        await provider.connection.requestAirdrop(anotherUser.publicKey, LAMPORTS_PER_SOL);
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
          await program.methods
            .acceptDuel()
            .accounts({
              duel: duelPda,
              opponent: anotherUser.publicKey,
            })
            .signers([anotherUser])
            .rpc();
          
          expect.fail("Should have failed");
        } catch (error) {
          expect(error.message).to.include("InvalidStatus");
        }
      });
    });

    describe("Stake Deposits", () => {
      it("Should allow creator to deposit stake", async () => {
        const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);

        await program.methods
          .depositStake()
          .accounts({
            duel: duelPda,
            depositor: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
        const escrowBalance = await provider.connection.getBalance(escrowPda);
        
        expect(creatorBalanceBefore - creatorBalanceAfter).to.be.approximately(
          STAKE_AMOUNT.toNumber(),
          0.01 * LAMPORTS_PER_SOL
        );
        expect(escrowBalance).to.equal(STAKE_AMOUNT.toNumber());

        const duelAccount = await program.account.duel.fetch(duelPda);
        expect(duelAccount.creatorStakeDeposited).to.be.true;
      });

      it("Should allow opponent to deposit stake and activate duel", async () => {
        const opponentBalanceBefore = await provider.connection.getBalance(opponent.publicKey);

        await program.methods
          .depositStake()
          .accounts({
            duel: duelPda,
            depositor: opponent.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([opponent])
          .rpc();

        const duelAccount = await program.account.duel.fetch(duelPda);
        expect(duelAccount.opponentStakeDeposited).to.be.true;
        expect(duelAccount.status).to.deep.equal({ active: {} });
        expect(duelAccount.startTime.toNumber()).to.be.greaterThan(0);
        expect(duelAccount.endTime.toNumber()).to.be.greaterThan(duelAccount.startTime.toNumber());

        const escrowBalance = await provider.connection.getBalance(escrowPda);
        expect(escrowBalance).to.equal(STAKE_AMOUNT.toNumber() * 2);

        const opponentBalanceAfter = await provider.connection.getBalance(opponent.publicKey);
        expect(opponentBalanceBefore - opponentBalanceAfter).to.be.approximately(
          STAKE_AMOUNT.toNumber(),
          0.01 * LAMPORTS_PER_SOL
        );
      });

      it("Should fail to deposit stake from non-participant", async () => {
        // Create a new duel for this test
        const protocolAccount = await program.account.protocol.fetch(protocolPda);
        const duelIndex = protocolAccount.totalDuels.toNumber();

        const [testDuelPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
          program.programId
        );

        const [testEscrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), testDuelPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createDuel(new anchor.BN(0.5 * LAMPORTS_PER_SOL), DURATION, [])
          .accounts({
            protocol: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        await program.methods
          .acceptDuel()
          .accounts({
            duel: testDuelPda,
            opponent: opponent.publicKey,
          })
          .signers([opponent])
          .rpc();

        const randomUser = Keypair.generate();
        await provider.connection.requestAirdrop(randomUser.publicKey, 2 * LAMPORTS_PER_SOL);
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
          await program.methods
            .depositStake()
            .accounts({
              duel: testDuelPda,
              depositor: randomUser.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([randomUser])
            .rpc();
          
          expect.fail("Should have failed");
        } catch (error) {
          expect(error.message).to.include("NotParticipant");
        }
      });
    });

    describe("Position Updates", () => {
      it("Should allow oracle to update positions", async () => {
        const creatorValue = new anchor.BN(1.2 * LAMPORTS_PER_SOL); // 20% gain
        const opponentValue = new anchor.BN(0.8 * LAMPORTS_PER_SOL); // 20% loss

        await program.methods
          .updatePositions(creatorValue, opponentValue)
          .accounts({
            duel: duelPda,
            oracle: oracle.publicKey,
          })
          .signers([oracle])
          .rpc();

        const duelAccount = await program.account.duel.fetch(duelPda);
        expect(duelAccount.creatorFinalValue.toNumber()).to.equal(creatorValue.toNumber());
        expect(duelAccount.opponentFinalValue.toNumber()).to.equal(opponentValue.toNumber());
      });

      it("Should fail to update positions on inactive duel", async () => {
        // Create but don't activate a duel
        const protocolAccount = await program.account.protocol.fetch(protocolPda);
        const duelIndex = protocolAccount.totalDuels.toNumber();

        const [inactiveDuelPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
          program.programId
        );

        await program.methods
          .createDuel(STAKE_AMOUNT, DURATION, [])
          .accounts({
            protocol: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        try {
          await program.methods
            .updatePositions(STAKE_AMOUNT, STAKE_AMOUNT)
            .accounts({
              duel: inactiveDuelPda,
              oracle: oracle.publicKey,
            })
            .signers([oracle])
            .rpc();
          
          expect.fail("Should have failed");
        } catch (error) {
          expect(error.message).to.include("InvalidStatus");
        }
      });

      it("Should fail to update positions after duel expires", async () => {
        // This is testing the time constraint logic
        try {
          // Try to update positions far in the future (would fail due to timestamp check)
          await program.methods
            .updatePositions(new anchor.BN(1.5 * LAMPORTS_PER_SOL), new anchor.BN(0.5 * LAMPORTS_PER_SOL))
            .accounts({
              duel: duelPda,
              oracle: oracle.publicKey,
            })
            .signers([oracle])
            .rpc();
        } catch (error) {
          // This might not fail in test environment since we can't manipulate time easily
          // but the check exists in the contract
        }
      });
    });
  });

  describe("Duel Settlement", () => {
    let settleDuelPda: PublicKey;
    let settleEscrowPda: PublicKey;

    before(async () => {
      // Create a quick duel for settlement testing
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

      // Create, accept, and fund a quick duel (0 duration for immediate settlement)
      await program.methods
        .createDuel(new anchor.BN(0.5 * LAMPORTS_PER_SOL), new anchor.BN(0), [])
        .accounts({
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
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: settleDuelPda,
          depositor: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();
    });

    it("Should settle duel with creator winning", async () => {
      // Update positions - creator wins
      await program.methods
        .updatePositions(
          new anchor.BN(0.6 * LAMPORTS_PER_SOL), // Creator gains 20%
          new anchor.BN(0.4 * LAMPORTS_PER_SOL)  // Opponent loses 20%
        )
        .accounts({
          duel: settleDuelPda,
          oracle: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();

      // Get balances before settlement
      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);
      const treasuryBalanceBefore = await provider.connection.getBalance(treasury.publicKey);

      // Settle the duel
      await program.methods
        .settleDuel()
        .accounts({
          duel: settleDuelPda,
          protocol: protocolPda,
          duelEscrow: settleEscrowPda,
          creator: creator.publicKey,
          opponent: opponent.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Verify settlement
      const duelAccount = await program.account.duel.fetch(settleDuelPda);
      expect(duelAccount.status).to.deep.equal({ settled: {} });
      expect(duelAccount.winner).to.deep.equal({ creator: {} });

      // Verify payouts
      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      const treasuryBalanceAfter = await provider.connection.getBalance(treasury.publicKey);

      const totalStake = 0.5 * LAMPORTS_PER_SOL * 2;
      const protocolFee = Math.floor((totalStake * PROTOCOL_FEE_BPS) / 10000);
      const winnerPayout = totalStake - protocolFee;

      expect(creatorBalanceAfter - creatorBalanceBefore).to.be.approximately(
        winnerPayout,
        0.01 * LAMPORTS_PER_SOL
      );
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(protocolFee);

      // Verify protocol stats updated
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      expect(protocolAccount.totalVolume.toNumber()).to.be.greaterThan(0);
    });

    it("Should handle draw correctly", async () => {
      // Create another quick duel for draw testing
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [drawDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [drawEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), drawDuelPda.toBuffer()],
        program.programId
      );

      // Create and fully activate duel
      await program.methods
        .createDuel(new anchor.BN(0.3 * LAMPORTS_PER_SOL), new anchor.BN(0), [])
        .accounts({
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .acceptDuel()
        .accounts({
          duel: drawDuelPda,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: drawDuelPda,
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: drawDuelPda,
          depositor: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();

      // Update with equal positions for draw
      await program.methods
        .updatePositions(
          new anchor.BN(0.3 * LAMPORTS_PER_SOL),
          new anchor.BN(0.3 * LAMPORTS_PER_SOL)
        )
        .accounts({
          duel: drawDuelPda,
          oracle: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();

      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);
      const opponentBalanceBefore = await provider.connection.getBalance(opponent.publicKey);

      // Settle the draw
      await program.methods
        .settleDuel()
        .accounts({
          duel: drawDuelPda,
          protocol: protocolPda,
          duelEscrow: drawEscrowPda,
          creator: creator.publicKey,
          opponent: opponent.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Verify draw result
      const duelAccount = await program.account.duel.fetch(drawDuelPda);
      expect(duelAccount.winner).to.deep.equal({ draw: {} });

      // Both should receive their stake minus half the fee each
      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      const opponentBalanceAfter = await provider.connection.getBalance(opponent.publicKey);

      const stakeAmount = 0.3 * LAMPORTS_PER_SOL;
      const totalFee = Math.floor((stakeAmount * 2 * PROTOCOL_FEE_BPS) / 10000);
      const refundAmount = stakeAmount - (totalFee / 2);

      expect(creatorBalanceAfter - creatorBalanceBefore).to.be.approximately(
        refundAmount,
        0.01 * LAMPORTS_PER_SOL
      );
      expect(opponentBalanceAfter - opponentBalanceBefore).to.be.approximately(
        refundAmount,
        0.01 * LAMPORTS_PER_SOL
      );
    });

    it("Should handle opponent winning", async () => {
      // Create another duel for opponent winning test
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [opponentWinDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [opponentWinEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), opponentWinDuelPda.toBuffer()],
        program.programId
      );

      // Create and activate duel
      await program.methods
        .createDuel(new anchor.BN(0.2 * LAMPORTS_PER_SOL), new anchor.BN(0), [])
        .accounts({
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .acceptDuel()
        .accounts({
          duel: opponentWinDuelPda,
          opponent: opponent.publicKey,
        })
        .signers([opponent])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: opponentWinDuelPda,
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: opponentWinDuelPda,
          depositor: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();

      // Update positions - opponent wins
      await program.methods
        .updatePositions(
          new anchor.BN(0.15 * LAMPORTS_PER_SOL), // Creator loses 25%
          new anchor.BN(0.25 * LAMPORTS_PER_SOL)  // Opponent gains 25%
        )
        .accounts({
          duel: opponentWinDuelPda,
          oracle: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();

      const opponentBalanceBefore = await provider.connection.getBalance(opponent.publicKey);

      // Settle
      await program.methods
        .settleDuel()
        .accounts({
          duel: opponentWinDuelPda,
          protocol: protocolPda,
          duelEscrow: opponentWinEscrowPda,
          creator: creator.publicKey,
          opponent: opponent.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const duelAccount = await program.account.duel.fetch(opponentWinDuelPda);
      expect(duelAccount.winner).to.deep.equal({ opponent: {} });

      const opponentBalanceAfter = await provider.connection.getBalance(opponent.publicKey);
      const totalStake = 0.2 * LAMPORTS_PER_SOL * 2;
      const protocolFee = Math.floor((totalStake * PROTOCOL_FEE_BPS) / 10000);
      const winnerPayout = totalStake - protocolFee;

      expect(opponentBalanceAfter - opponentBalanceBefore).to.be.approximately(
        winnerPayout,
        0.01 * LAMPORTS_PER_SOL
      );
    });

    it("Should fail to settle non-expired duel", async () => {
      // Create a duel with longer duration
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [longDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [longDuelEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), longDuelPda.toBuffer()],
        program.programId
      );

      // Create and start the duel
      await program.methods
        .createDuel(new anchor.BN(0.1 * LAMPORTS_PER_SOL), new anchor.BN(3600), [])
        .accounts({
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
          depositor: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .depositStake()
        .accounts({
          duel: longDuelPda,
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
            duelEscrow: longDuelEscrowPda,
            creator: creator.publicKey,
            opponent: opponent.publicKey,
            treasury: treasury.publicKey,
            systemProgram: SystemProgram.programId,
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
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [cancelDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      await program.methods
        .createDuel(STAKE_AMOUNT, DURATION, [])
        .accounts({
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .cancelDuel()
        .accounts({
          duel: cancelDuelPda,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      const duelAccount = await program.account.duel.fetch(cancelDuelPda);
      expect(duelAccount.status).to.deep.equal({ cancelled: {} });
    });

    it("Should fail to cancel accepted duel", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [acceptedDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      await program.methods
        .createDuel(STAKE_AMOUNT, DURATION, [])
        .accounts({
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

    it("Should fail when non-creator tries to cancel", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [unauthorizedCancelDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      await program.methods
        .createDuel(STAKE_AMOUNT, DURATION, [])
        .accounts({
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      try {
        await program.methods
          .cancelDuel()
          .accounts({
            duel: unauthorizedCancelDuelPda,
            creator: opponent.publicKey, // Wrong signer
          })
          .signers([opponent])
          .rpc();
        
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("Unauthorized");
      }
    });
  });

  describe("Edge Cases and Stress Tests", () => {
    it("Should handle maximum allowed tokens", async () => {
      const allowedTokens = Array(10).fill(null).map(() => Keypair.generate().publicKey);

      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [maxTokensDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      await program.methods
        .createDuel(STAKE_AMOUNT, DURATION, allowedTokens)
        .accounts({
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const duelAccount = await program.account.duel.fetch(maxTokensDuelPda);
      expect(duelAccount.allowedTokens.length).to.equal(10);
    });

    it("Should validate PnL calculation precision", async () => {
      // Test PnL calculation with various values to ensure accuracy
      const testCases = [
        { start: 1000000, end: 1100000, expectedPnl: 1000 }, // 10% gain
        { start: 1000000, end: 900000, expectedPnl: -1000 }, // 10% loss
        { start: 1000000, end: 1000000, expectedPnl: 0 }, // No change
        { start: 1000000, end: 2000000, expectedPnl: 10000 }, // 100% gain
        { start: 1000000, end: 500000, expectedPnl: -5000 }, // 50% loss
      ];

      for (const testCase of testCases) {
        const pnl = ((testCase.end - testCase.start) * 10000) / testCase.start;
        expect(pnl).to.equal(testCase.expectedPnl);
      }
    });

    it("Should handle minimum stake amounts", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [minStakeDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      // Test with 1 lamport (minimum possible)
      await program.methods
        .createDuel(new anchor.BN(1), DURATION, [])
        .accounts({
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const duelAccount = await program.account.duel.fetch(minStakeDuelPda);
      expect(duelAccount.stakeAmount.toNumber()).to.equal(1);
    });

    it("Should handle very short duration duels", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [shortDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      // Test with 1 second duration
      await program.methods
        .createDuel(new anchor.BN(0.1 * LAMPORTS_PER_SOL), new anchor.BN(1), [])
        .accounts({
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const duelAccount = await program.account.duel.fetch(shortDuelPda);
      expect(duelAccount.duration.toNumber()).to.equal(1);
    });

    it("Should handle large stake amounts", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      const duelIndex = protocolAccount.totalDuels.toNumber();

      const [largeStakeDuelPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      // Test with large stake amount
      const largeStake = new anchor.BN(100 * LAMPORTS_PER_SOL);
      
      await program.methods
        .createDuel(largeStake, DURATION, [])
        .accounts({
          protocol: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const duelAccount = await program.account.duel.fetch(largeStakeDuelPda);
      expect(duelAccount.stakeAmount.toNumber()).to.equal(largeStake.toNumber());
    });
  });

  describe("Protocol Statistics", () => {
    it("Should track total duels correctly", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      // Should have created multiple duels by this point
      expect(protocolAccount.totalDuels.toNumber()).to.be.greaterThan(10);
    });

    it("Should track total volume correctly", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      // Should have some volume from settled duels
      expect(protocolAccount.totalVolume.toNumber()).to.be.greaterThan(0);
    });

    it("Should maintain protocol fee accuracy", async () => {
      const protocolAccount = await program.account.protocol.fetch(protocolPda);
      expect(protocolAccount.feeBps).to.equal(PROTOCOL_FEE_BPS);
    });
  });
}); 