import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TradingDuelProtocol } from "../target/types/trading_duel_protocol";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

describe("Error Debug Test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.TradingDuelProtocol as Program<TradingDuelProtocol>;

  let authority: Keypair;
  let treasury: Keypair;
  let creator: Keypair;
  let opponent: Keypair;
  let protocolPda: PublicKey;

  before(async () => {
    authority = Keypair.generate();
    treasury = Keypair.generate();
    creator = Keypair.generate();
    opponent = Keypair.generate();

    await Promise.all([
      provider.connection.requestAirdrop(authority.publicKey, 5 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(creator.publicKey, 5 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(opponent.publicKey, 5 * LAMPORTS_PER_SOL),
    ]);

    await new Promise(resolve => setTimeout(resolve, 1000));

    [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );

    // Initialize protocol
    await program.methods
      .initialize(250)
      .accounts({
        authority: authority.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
  });

  it("Should test error format", async () => {
    const protocolAccount = await program.account.protocol.fetch(protocolPda);
    const duelIndex = protocolAccount.totalDuels.toNumber();

    const [duelPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("duel"), new anchor.BN(duelIndex).toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Create duel
    await program.methods
      .createDuel(new anchor.BN(LAMPORTS_PER_SOL), new anchor.BN(3600), [])
      .accounts({
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
        duel: duelPda,
        opponent: opponent.publicKey,
      })
      .signers([opponent])
      .rpc();

    // Try to accept again - should error
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
    } catch (error) {
      console.log("Full error:", error);
      console.log("Error message:", error.message);
      console.log("Error code:", error.code);
      console.log("Error name:", error.name);
      console.log("Error toString:", error.toString());
      
      // Check if it's an AnchorError
      if (error.code !== undefined) {
        console.log("This is an AnchorError with code:", error.code);
      }
    }
  });
}); 