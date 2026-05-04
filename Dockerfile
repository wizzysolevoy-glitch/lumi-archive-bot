FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY bot.js ./
COPY .env.example ./

RUN mkdir -p archives

ENV NODE_ENV=production

CMD ["node", "bot.js"]
