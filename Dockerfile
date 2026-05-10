# Use Node.js as base
FROM node:18-slim

# Install Python and dependencies for yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && ln -s /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip
RUN pip3 install --no-cache-dir yt-dlp

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
# Note: we use --build-from-source for better-sqlite3 if needed, but binaries usually work
RUN npm install

# Copy the rest of the code
COPY . .

# Environment variables
ENV PORT=3000
ENV MUSIC_DIR=/app/data/music
ENV NODE_ENV=production

# Create data directories
RUN mkdir -p /app/data/music

# Expose port
EXPOSE 3000

# Start command (with openssl legacy provider as requested in package.json)
CMD ["node", "--openssl-legacy-provider", "server.js"]
