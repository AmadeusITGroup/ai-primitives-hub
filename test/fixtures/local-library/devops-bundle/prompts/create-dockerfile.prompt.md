# Create Dockerfile

Generate multi-stage, optimized Dockerfiles following best practices.

## Principles

1. Use multi-stage builds to reduce image size
2. Leverage build cache effectively
3. Run as non-root user
4. Minimize layers
5. Use specific base image versions

## Template

```dockerfile
# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

# Production stage
FROM node:18-alpine
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
WORKDIR /app
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
USER nodejs
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Best Practices

- Use `.dockerignore` to exclude unnecessary files
- Pin base image versions
- Combine RUN commands to reduce layers
- Use COPY instead of ADD
- Leverage build cache by copying package files first

Build efficient Docker images\!
