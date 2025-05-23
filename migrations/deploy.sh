#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Trading Duel Protocol - Production Deployment${NC}"
echo "=================================================="

# Check if running as root
if [ "$EUID" -eq 0 ]; then
  echo -e "${RED}❌ Please don't run this script as root${NC}"
  exit 1
fi

# Check dependencies
command -v docker >/dev/null 2>&1 || { echo -e "${RED}❌ Docker is required but not installed.${NC}" >&2; exit 1; }
command -v docker-compose >/dev/null 2>&1 || { echo -e "${RED}❌ Docker Compose is required but not installed.${NC}" >&2; exit 1; }

# Check environment file
if [ ! -f ".env" ]; then
  echo -e "${YELLOW}⚠️  No .env file found. Copying from .env.example${NC}"
  cp env.example .env
  echo -e "${RED}❌ Please configure your .env file with production values${NC}"
  exit 1
fi

# Load environment variables
set -a
source .env
set +a

# Validate required environment variables
required_vars=(
  "DATABASE_URL"
  "SOLANA_RPC_URL"
  "JWT_SECRET"
  "PROGRAM_ID"
)

missing_vars=()
for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    missing_vars+=($var)
  fi
done

if [ ${#missing_vars[@]} -ne 0 ]; then
  echo -e "${RED}❌ Missing required environment variables:${NC}"
  printf '%s\n' "${missing_vars[@]}"
  exit 1
fi

echo -e "${GREEN}✅ Environment validation passed${NC}"

# Build and deploy services
echo -e "${YELLOW}📦 Building Docker images...${NC}"
docker-compose build --no-cache

echo -e "${YELLOW}🗄️  Setting up database...${NC}"
docker-compose up -d postgres redis

# Wait for database to be ready
echo -e "${YELLOW}⏳ Waiting for database to be ready...${NC}"
sleep 10

# Run database migrations
echo -e "${YELLOW}📊 Running database migrations...${NC}"
docker-compose run --rm api npx prisma migrate deploy
docker-compose run --rm api npx prisma generate

# Start all services
echo -e "${YELLOW}🔄 Starting all services...${NC}"
docker-compose up -d

# Wait for services to be ready
echo -e "${YELLOW}⏳ Waiting for services to start...${NC}"
sleep 15

# Health checks
echo -e "${YELLOW}🩺 Running health checks...${NC}"

# Check API health
if curl -f http://localhost:8080/health > /dev/null 2>&1; then
  echo -e "${GREEN}✅ API service is healthy${NC}"
else
  echo -e "${RED}❌ API service health check failed${NC}"
  docker-compose logs api
  exit 1
fi

# Check database connectivity
if docker-compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; then
  echo -e "${GREEN}✅ Database is healthy${NC}"
else
  echo -e "${RED}❌ Database health check failed${NC}"
  exit 1
fi

# Check Redis connectivity
if docker-compose exec -T redis redis-cli ping > /dev/null 2>&1; then
  echo -e "${GREEN}✅ Redis is healthy${NC}"
else
  echo -e "${RED}❌ Redis health check failed${NC}"
  exit 1
fi

echo ""
echo -e "${GREEN}🎉 Deployment completed successfully!${NC}"
echo ""
echo "📍 Service URLs:"
echo "   🌐 API Server: http://localhost:8080"
echo "   📊 Grafana: http://localhost:3000 (admin/admin)"
echo "   🗄️  Database: localhost:5432"
echo "   ⚡ Redis: localhost:6379"
echo ""
echo "📋 Next steps:"
echo "   1. Configure your frontend to point to http://localhost:8080"
echo "   2. Set up monitoring alerts in Grafana"
echo "   3. Configure your Twitter API credentials"
echo "   4. Deploy your Solana program to mainnet"
echo "   5. Update PROGRAM_ID in your .env file"
echo ""
echo "📝 Useful commands:"
echo "   🔍 View logs: docker-compose logs -f [service]"
echo "   🔄 Restart: docker-compose restart [service]"
echo "   🛑 Stop: docker-compose down"
echo "   📊 Status: docker-compose ps"
echo ""
echo -e "${GREEN}Happy trading! 🎮⚔️${NC}" 