FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY ../../package.json ../../
COPY ../../client/package*.json ../../client/

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .
COPY ../../client/ ../../client/
COPY ../../schema.prisma ../../

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Production image
FROM node:18-alpine AS production

RUN apk add --no-cache dumb-init

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./

USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

CMD ["dumb-init", "node", "dist/server.js"] 