# Build from the repository root:  docker build -f examples/Dockerfile -t restore-drill .
FROM node:22-alpine

# Every external tool a drill can call. Drop the ones you do not use.
RUN apk add --no-cache sqlite tar unzip zstd xz gnupg age restic postgresql-client

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src

# Config in /config, read-only backups in /backups, results in /state.
ENV TMPDIR=/tmp
VOLUME ["/state"]
ENTRYPOINT ["node", "/app/bin/restore-drill.mjs"]
CMD ["run", "--config", "/config/drills.json", "--state", "/state"]
