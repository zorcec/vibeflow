# Vibeflow MCP server — local-mode (stdio) container image for Glama.
#
# Built FROM SOURCE in this repo, never `npm install @vibeflow-tools/cli@<version>`:
# the pre-publish gate (scripts/check-docker-image.sh, wired into the private
# repo's deploy/scripts/publish-cli.sh) runs BEFORE the new version reaches npm,
# so the version under test does not exist on the registry yet. A source build
# is the only shape that can verify the code that is about to be published.
#
# Placed at the repo ROOT (not packages/cli/): the CLI is a pnpm workspace
# package (@vibeflow-tools/shared, api-core, ui are workspace:* deps), so the
# build needs the root pnpm-workspace.yaml + pnpm-lock.yaml + sibling packages
# as context. A packages/cli/Dockerfile would COPY ../.. anyway — root is honest.
#
# WHY /project must already be a valid project (do NOT "simplify" this away):
# `vibeflow mcp` refuses to start in stdio mode unless --project points at a
# directory that is a git repo OR already contains .vibeflow/ —
#   `✗ <dir> is not a vibeflow project: no .git and no .vibeflow/.`
# (measured against the built CLI; see packages/cli/src/core/project-root.ts).
# A bare image has neither, so the server would exit before answering
# `initialize`. We bake a minimal one-task .vibeflow/ sample at /project
# instead of `git init`: it satisfies the check without installing git, keeps
# the image slim and the build offline-safe. VOLUME /project still lets users
# mount their own repo over it — their .git/.vibeflow then wins.
#
# Stdio-only: no EXPOSE, no ports, no tokens. There is no secret in any layer
# or build arg — scripts/check-docker-image.sh asserts this on every build.

FROM node:22-alpine AS builder
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Manifests first for a cache-friendly install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/api-core/package.json packages/api-core/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
# Everything else the build embeds (overlay bundles, kanban css, swagger ui,
# generated API artifacts are produced by the prebuild scripts themselves).
COPY . .
RUN pnpm --filter @vibeflow-tools/cli run build
# Self-contained prod bundle: package files + production node_modules only
# (workspace devDeps, tests, browsers never ship). Verified: initialize +
# tools/list succeed from this dir with plain `node` and no network. `--legacy`:
# pnpm v10+ only deploys from workspaces with injected deps by default; this
# workspace does not inject, so the legacy copy-plus-prod-install path applies.
RUN pnpm --filter @vibeflow-tools/cli --prod deploy --legacy /app

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app /app
# Baked minimal project sample — see the header comment for WHY it exists.
COPY docker/mcp-sample/.vibeflow /project/.vibeflow
RUN addgroup -S vibeflow && adduser -S vibeflow -G vibeflow \
  && chown -R vibeflow:vibeflow /app /project
USER vibeflow
WORKDIR /project
VOLUME /project
# ENTRYPOINT carries the fixed subcommand; CMD carries the default project so
# `docker run <img> --project /myrepo` (or -v $PWD:/project) overrides it.
ENTRYPOINT ["node", "/app/dist/cli/index.js", "mcp"]
CMD ["--project", "/project"]
