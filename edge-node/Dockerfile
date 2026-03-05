FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm i --no-audit --no-fund

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx tsc -p tsconfig.json

EXPOSE 8080
CMD ["node", "dist/index.js"]