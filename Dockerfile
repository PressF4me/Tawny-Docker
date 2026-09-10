# Tawny — self-hosted pet monitor: the web client, its signalling relay, a TURN
# fallback, and the Tailscale node that makes all of it reachable.
#
# The build context is this repo. The server payload (server.js, public/,
# rendezvous/, docker/, package*.json) is vendored under app/ by tools/tawny-sync
# from the Tawny Android checkout — that repo is the source of truth for it.
# Every COPY path below is therefore app/… relative to this folder.
FROM node:22-alpine

# OCI metadata. org.opencontainers.image.source is what links the published
# GHCR package to its repository (auto-connects on push from an actor with
# write on that repo) — without it the package is orphaned.
LABEL org.opencontainers.image.source="https://github.com/pressf4me/tawny" \
      org.opencontainers.image.description="Tawny — self-hosted pet monitor: web client, signalling relay, TURN fallback, and Tailscale node"

WORKDIR /app
ENV NODE_ENV=production

# tailscale is what makes this deployment work at all, not an add-on:
#   - `tailscale serve` gives the app a Let's Encrypt certificate on
#     <node>.<tailnet>.ts.net, which is the only reason a browser will hand over
#     a microphone for talk-back. Nobody imports a CA; there is no CA.
#   - the subnet router advertises the Monitor phone's LAN into the tailnet,
#     which is what lets a Viewer anywhere reach the phone's 192.168.x host
#     candidate directly. That is the media path. See DESIGN.md.
# coturn is the fallback for a network that blocks direct UDP. Both together are
# well under half the image.
RUN apk add --no-cache tailscale coturn

COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# server.js only ever reads from these trees. Copy whole directories rather than
# individual files so a new `import './rendezvous/…'` in server.js cannot
# silently break the image the way the privacy-policy import did in 2026-08.
COPY app/server.js ./
COPY app/public ./public
COPY app/rendezvous ./rendezvous
# Whole directory (not just entrypoint.sh) so entrypoint.sh's own
# docker/route-conflict.js — the subnet-route overlap check it and server.js
# both run — ships too.
COPY app/docker ./docker
RUN cp ./docker/entrypoint.sh /usr/local/bin/tawny-entrypoint && \
    chmod +x /usr/local/bin/tawny-entrypoint

# Tailscale's node state, when the container runs its own tailscaled (TS_AUTHKEY
# set). Declared so a plain `docker run` with no -v still keeps its identity
# across a restart: delete this and the container comes back as a *new* node,
# needing a fresh auth key and a fresh route approval. It holds no certificate
# and no CA — there are none in this design.
VOLUME ["/data"]

# Runs as root so coturn may bind 3478 and tailscaled may write its state.
# tailscaled runs in userspace-networking mode, so it needs no NET_ADMIN and no
# /dev/net/tun — see the long note in entrypoint.sh.
EXPOSE 8099
EXPOSE 3478/udp
EXPOSE 3478/tcp
EXPOSE 49160-49200/udp

# server.js answers /healthz with {"ok":true,…}. With this in place a broken
# image shows as "unhealthy" in `docker ps` instead of a silent restart loop.
# busybox wget ships in node:*-alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8099/healthz | grep -q '"ok":true' || exit 1

ENTRYPOINT ["/usr/local/bin/tawny-entrypoint"]
