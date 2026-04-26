FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    iproute2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production

EXPOSE 9443

CMD ["npm", "start"]
