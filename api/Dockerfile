# Use Debian-based Node to avoid musl issues with better-sqlite3 on Raspberry Pi
FROM node:20-bookworm-slim

WORKDIR /usr/src/app

# Build tools needed for native modules (better-sqlite3)
# + Install gpiod tools to provide gpioset/gpioget inside the container
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 make g++ gpiod \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

ENV PORT=4000
EXPOSE 4000

CMD ["npm", "run", "dev"]
