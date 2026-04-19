FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --production

# Copy source
COPY src ./src
COPY public ./public

# Environment defaults
ENV PORT=3101
ENV AUDIO_WS_PORT=3001
ENV HOST=0.0.0.0

EXPOSE 3101 3001

CMD ["node", "src/index.js"]
