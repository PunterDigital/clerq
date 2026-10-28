# Multi-stage build for the self-hosted Clerq instance.
# - builder: full workspace, used for next build and as the one-shot
#   migration runner in docker-compose (it has drizzle-kit and the
#   migrations folder).
# - runner: minimal production image from Next.js standalone output.

FROM node:26-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Node 25+ no longer ships corepack, so install it from npm. It still reads
# the pnpm version from package.json's packageManager field.
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# Bundle the runtime migrator to a single dependency-light migrate.mjs (pg is
# left external; it is already in the standalone output). Run on boot.
RUN pnpm build:migrator
# Same bundling for the platform-admin bootstrap. The standalone runner has no
# workspace tooling (no pnpm deps, no tsx), so the tsx `pnpm admin:grant` path
# can't run there; this ships a dependency-light grant-admin.mjs operators run
# with `docker compose exec app node grant-admin.mjs <email>`.
RUN pnpm build:grant-admin

FROM base AS runner
# Set by the release workflow from the pushed git tag (e.g. "1.3.1", no "v"
# prefix - see .github/workflows/release.yml). Empty for a local/source
# build, which the update checker treats as "unknown" and never prompts for.
ARG CLERQ_VERSION=""
ENV CLERQ_VERSION=$CLERQ_VERSION
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Runtime migrations: the bundled migrator plus the SQL it applies. The
# entrypoint runs them before the server starts, so the image self-migrates.
COPY --from=builder --chown=nextjs:nodejs /app/migrate.mjs ./migrate.mjs
COPY --from=builder --chown=nextjs:nodejs /app/db/migrations ./db/migrations
# Platform-admin bootstrap, run on demand (not on boot):
#   docker compose exec app node grant-admin.mjs <email>
COPY --from=builder --chown=nextjs:nodejs /app/grant-admin.mjs ./grant-admin.mjs
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENTRYPOINT ["./docker-entrypoint.sh"]
