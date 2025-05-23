# ⚔️ Trading Duel Protocol

> **The Ultimate Solana Trading Competition Platform** - Challenge traders to head-to-head PnL battles with real stakes and social integration.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solana](https://img.shields.io/badge/Solana-black?logo=Solana&logoColor=blueviolet)](https://solana.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Anchor](https://img.shields.io/badge/Anchor-FF6B6B?logo=anchor)](https://www.anchor-lang.com/)

## 🎯 What is Trading Duel Protocol?

**Trading Duel Protocol** is a decentralized platform where traders can challenge each other to time-bound trading competitions with real SOL stakes. Think "1v1 me bro" but for DeFi trading.

### 🔥 Key Features

- **⚔️ Twitter-Native Challenges**: Challenge anyone via `@TradingDuelBot 1v1 @opponent 0.5 SOL 2h`
- **🔒 Trustless Escrow**: Smart contracts hold stakes until settlement
- **📊 Real-Time Monitoring**: Live PnL tracking across all major Solana DEXs
- **🏆 Automated Settlement**: Oracle determines winners and distributes rewards
- **🎮 Gamification**: Leaderboards, achievements, and ELO ratings
- **💰 Multi-Token Support**: Trade any SPL token, compete on total portfolio PnL

---

## 🏗️ Architecture

```mermaid
graph TB
    A[Twitter Bot] --> B[API Server]
    B --> C[Smart Contract]
    B --> D[Database]
    E[Oracle Service] --> C
    E --> F[Price Feeds]
    C --> G[Escrow Accounts]
    H[Frontend] --> B
    B --> I[WebSocket]
```

### Core Components

1. **🎯 Smart Contract**: Solana program managing duel lifecycle and escrow
2. **🔮 Oracle Service**: Real-time portfolio monitoring and position updates  
3. **🌐 API Server**: REST API + WebSocket for frontend integration
4. **🐦 Twitter Bot**: Social integration for viral challenges
5. **📱 Frontend**: React app for duel management and analytics

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ and **Yarn**
- **Rust** 1.70+ and **Solana CLI** 1.16+
- **Anchor CLI** 0.28+
- **Docker** and **Docker Compose**
- **PostgreSQL** 15+

### 1. Clone and Install

```bash
git clone https://github.com/tuaregsand/bandforband.git
cd bandforband
yarn install
```

### 2. Environment Setup

```bash
cp env.example .env
# Edit .env with your configuration
```

### 3. Database Setup

```bash
# Start PostgreSQL with Docker
docker-compose up postgres -d

# Run migrations
npx prisma db push
npx prisma generate
```

### 4. Build and Test Smart Contract

```bash
# Build the Anchor program
anchor build

# Run comprehensive tests (28 tests)
anchor test
```

### 5. Start Services

```bash
# Start all services
docker-compose up -d

# Or run individually:
cd services/api && npm run dev
cd services/oracle && npm run dev  
cd services/twitter-bot && npm run dev
```

### 6. Deploy to Devnet

```bash
# Configure for devnet
solana config set --url devnet

# Deploy smart contract
anchor deploy

# Initialize protocol
anchor run initialize
```

---

## 📖 Usage Examples

### Twitter Challenge Flow

1. **Challenge**: `@TradingDuelBot 1v1 @alice 0.5 SOL 2h`
2. **Response**: Bot creates challenge and asks for wallet linking
3. **Link Wallet**: `@TradingDuelBot wallet: 7xKXpGhP...abc123`
4. **Accept**: `@alice` replies "accept" to join
5. **Deposit**: Both traders deposit 0.5 SOL stakes
6. **Trade**: 2-hour trading period begins
7. **Settlement**: Oracle determines winner based on PnL

### API Integration

```typescript
import { TradingDuelClient } from './client/src/program';
import { Connection, PublicKey } from '@solana/web3.js';

const connection = new Connection('https://api.devnet.solana.com');
const client = new TradingDuelClient(connection, wallet);

// Create a duel
const duel = await client.createDuel({
  stakeAmount: 0.5 * 1e9, // 0.5 SOL
  duration: 2 * 60 * 60, // 2 hours
  allowedTokens: [], // All tokens allowed
});

// Monitor duel status
const duelData = await client.getDuel(duel.publicKey);
console.log(`Status: ${duelData.status}`);
```

### REST API

```bash
# Get active duels
curl https://api.tradingduel.com/api/duels/active

# Get leaderboard
curl https://api.tradingduel.com/api/leaderboard

# Create duel (authenticated)
curl -X POST https://api.tradingduel.com/api/duels \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"stakeAmount": 0.5, "duration": 7200}'
```

---

## 🎮 Game Mechanics

### Duel Lifecycle

1. **Creation** → Set stake amount, duration, token restrictions
2. **Acceptance** → Opponent joins the challenge  
3. **Deposit** → Both parties deposit stakes to escrow
4. **Active** → Trading period with real-time monitoring
5. **Settlement** → Winner determined by highest PnL %

### Scoring System

- **PnL Calculation**: `(Final Value - Starting Value) / Starting Value * 100`
- **Winner**: Highest PnL percentage wins the pot
- **Draw**: If PnL within 0.1%, stakes returned minus fees
- **Protocol Fee**: 2% of total pot goes to treasury

### ELO Rating

- **Starting Rating**: 1500 ELO
- **Win/Loss**: ±25 points adjusted by opponent rating
- **Leaderboard**: Global rankings by ELO and winnings

---

## 🧪 Testing

The protocol includes comprehensive test coverage:

```bash
# Smart contract tests (28 tests)
anchor test

# API integration tests  
cd services/api && npm test

# Oracle service tests
cd services/oracle && npm test

# End-to-end tests
npm run test:e2e
```

### Test Coverage

- ✅ Protocol initialization
- ✅ Duel creation and acceptance  
- ✅ Stake deposits and escrow
- ✅ Oracle position updates
- ✅ Settlement mechanics
- ✅ Edge cases and error handling
- ✅ Fee calculations
- ✅ Access controls

---

## 🔧 Configuration

### Environment Variables

```bash
# Database
DATABASE_URL="postgresql://user:pass@host:5432/trading_duel"
REDIS_URL="redis://localhost:6379"

# Solana
SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
PROGRAM_ID="your-deployed-program-id"
ORACLE_WALLET_PRIVATE_KEY="[base58-encoded-key]"

# Authentication  
JWT_SECRET="your-256-bit-secret"

# Twitter API
TWITTER_API_KEY="your-api-key"
TWITTER_API_SECRET="your-api-secret"
TWITTER_ACCESS_TOKEN="your-access-token"
TWITTER_ACCESS_SECRET="your-access-secret"

# External Services
HELIUS_API_KEY="your-helius-key"
```

### Smart Contract Configuration

```rust
// Program parameters (modifiable by authority)
pub struct Protocol {
    pub authority: Pubkey,      // Protocol admin
    pub treasury: Pubkey,       // Fee collection
    pub fee_bps: u16,          // Fee in basis points (200 = 2%)
    pub total_duels: u64,      // Statistics
    pub total_volume: u64,     // Total volume traded
}
```

---

## 📊 Monitoring

### Grafana Dashboard

The project includes pre-configured Grafana dashboards:

```bash
# Start monitoring stack
docker-compose up grafana -d

# Access dashboard at http://localhost:3000
# Username: admin, Password: admin
```

### Key Metrics

- **Active Duels**: Currently running competitions
- **Settlement Rate**: Successful vs failed settlements  
- **Oracle Uptime**: Position update reliability
- **API Performance**: Response times and error rates
- **TVL**: Total value locked in escrows

---

## 🚀 Production Deployment

### Quick Deploy Options

1. **Railway** (Recommended)
   ```bash
   # Deploy all services with one click
   railway up
   ```

2. **DigitalOcean App Platform**
   ```bash
   # Use provided app spec
   doctl apps create --spec .do/app.yaml
   ```

3. **Self-Hosted VPS**
   ```bash
   # Use deployment script
   ./scripts/deploy.sh production
   ```

### Database Providers

- **Supabase**: https://supabase.com (PostgreSQL)
- **PlanetScale**: https://planetscale.com (MySQL)  
- **Railway**: https://railway.app (PostgreSQL)

### External Services

- **Helius**: https://helius.dev (Solana RPC/webhooks)
- **QuickNode**: https://quicknode.com (Solana RPC)
- **Twitter API**: https://developer.twitter.com

---

## 🛠️ Development

### Project Structure

```
├── programs/bandforband/    # Solana smart contract
├── client/                  # TypeScript SDK
├── services/
│   ├── api/                # REST API server
│   ├── oracle/             # Position monitoring
│   └── twitter-bot/        # Social integration
├── frontend/               # React web app
├── tests/                  # Comprehensive test suite
├── migrations/             # Database migrations
└── docker-compose.yml      # Local development
```

### Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Run tests: `anchor test && npm test`
4. Commit changes: `git commit -m 'Add amazing feature'`
5. Push to branch: `git push origin feature/amazing-feature`
6. Open Pull Request

---

## 📚 API Documentation

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/auth/connect-wallet` | Authenticate with Solana wallet |
| `GET` | `/duels` | List all duels with filters |
| `POST` | `/duels` | Create new duel |
| `GET` | `/duels/:id` | Get duel details |
| `POST` | `/duels/:id/accept` | Accept duel challenge |
| `GET` | `/leaderboard` | Global leaderboard |
| `GET` | `/users/:address` | User profile and stats |

### WebSocket Events

- `subscribe:duel` - Real-time duel updates
- `subscribe:leaderboard` - Leaderboard changes  
- `subscribe:prices` - Token price updates

---

## 🔐 Security

### Smart Contract Security

- ✅ **Access Controls**: Role-based permissions
- ✅ **Input Validation**: All parameters validated
- ✅ **Reentrancy Protection**: State changes before external calls
- ✅ **Integer Overflow**: Using checked math operations
- ✅ **Escrow Safety**: Funds locked until settlement

### API Security

- ✅ **JWT Authentication**: Signed tokens with expiration
- ✅ **Rate Limiting**: 100 requests per 15 minutes
- ✅ **Input Sanitization**: Zod schema validation
- ✅ **CORS Protection**: Restricted origins
- ✅ **SQL Injection**: Prisma ORM parameterized queries

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- **Solana Labs** for the incredible blockchain infrastructure
- **Anchor Framework** for Solana development tools
- **Jupiter** for DEX aggregation and pricing
- **Helius** for reliable RPC and webhook services

---

## 🔗 Links

- **Website**: https://tradingduel.com
- **Twitter**: [@TradingDuelBot](https://twitter.com/TradingDuelBot)
- **Discord**: https://discord.gg/tradingduel
- **Documentation**: https://docs.tradingduel.com

---

<div align="center">
  <strong>Built with ❤️ on Solana</strong><br>
  <em>Trade. Compete. Dominate.</em>
</div>