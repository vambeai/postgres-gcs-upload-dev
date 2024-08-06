FROM alpine:3.18 AS build
WORKDIR /root
# Install Node.js and npm
RUN apk add --update --no-cache nodejs npm
# Copy package files and install dependencies
COPY package*.json ./
RUN npm install
# Copy source files and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Prune dev dependencies
RUN npm prune --production

FROM alpine:3.18
WORKDIR /root
# Copy built files and production node_modules
COPY --from=build /root/node_modules ./node_modules
COPY --from=build /root/dist ./dist
# Install Node.js and PostgreSQL 16.x client
RUN apk add --update --no-cache nodejs
# Add PostgreSQL 16.x repository and install client
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/main" >> /etc/apk/repositories && \
    echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories && \
    apk update && \
    apk add --no-cache postgresql16-client

# Set the environment variable
ENV ENABLE_ALPINE_PRIVATE_NETWORKING=true

# Set the entrypoint
ENTRYPOINT ["node", "dist/index.js"]
