# Tawny — self-hosted pet monitor: the web client, its signalling relay, a TURN
# fallback, and the Tailscale node that makes all of it reachable.
#
# The build context is this repo, and every COPY path below is app/… relative
# to this folder. server.js, docker/, rendezvous/ and package*.json live here;
# only app/public/ — the web client, the same bundle the Android app ships — is
# vendored, by tools/tawny-sync, from the Tawny Android checkout.
FROM node:22-alpine

# OCI metadata. org.opencontainers.image.source is what links the published
# GHCR package to its repository (auto-connects on push from an actor with
# write on that repo) — without it the package is orphaned.
LABEL org.opencontainers.image.source="https://github.com/PressF4me/Tawny-Docker" \
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
#
# tailscale comes from Tailscale, NOT from `apk add tailscale`. Alpine's package
# lags upstream by many releases (this image shipped 1.98.5-AlpineLinux, with a
# known vulnerability, long after upstream had moved on) and nothing about a tag
# build would ever have moved it forward. These are the static binaries Tailscale
# publishes and documents for containers; `?mode=json` names the current stable
# tarball per architecture, so every build resolves whatever is current that day.
#
# TAILSCALE_VERSION=latest resolves at build time. Pass an explicit version
# (--build-arg TAILSCALE_VERSION=1.90.2) to pin one — for reproducing an old
# image, or to hold back a release that broke something. Note that a *local*
# rebuild can serve this layer from Docker's cache and stay on the old version;
# .github/workflows/release.yml sets no buildx cache, so a vX.Y.Z tag build
# always starts cold and always resolves current.
#
# ca-certificates is not optional: these are static Go binaries and without the
# system trust store tailscaled cannot complete TLS to controlplane.tailscale.com.
# No iptables/ip6tables — tailscaled runs --tun=userspace-networking here and
# touches no kernel netfilter state at all (see the long note in entrypoint.sh).
ARG TARGETARCH
ARG TAILSCALE_VERSION=latest
RUN set -eu; \
    apk add --no-cache coturn ca-certificates; \
    case "${TARGETARCH:-amd64}" in \
      amd64|arm64|arm|386) tsarch="${TARGETARCH:-amd64}" ;; \
      *) echo "no Tailscale static build for TARGETARCH=${TARGETARCH:-}" >&2; exit 1 ;; \
    esac; \
    if [ "$TAILSCALE_VERSION" = latest ]; then \
      # Take the tarball *name* from the index rather than assembling one from a
      # version string: it is the index's own answer for this architecture, so a
      # change in their naming cannot silently 404 the build.
      tgz="$(wget -qO- 'https://pkgs.tailscale.com/stable/?mode=json' | node -e '\
        let s = ""; \
        process.stdin.on("data", (d) => (s += d)).on("end", () => { \
          const j = JSON.parse(s); \
          process.stdout.write(String((j.Tarballs || {})[process.argv[1]] || "")); \
        });' "$tsarch")"; \
    else \
      tgz="tailscale_${TAILSCALE_VERSION}_${tsarch}.tgz"; \
    fi; \
    [ -n "$tgz" ] || { echo "could not resolve a Tailscale tarball for $tsarch" >&2; exit 1; }; \
    wget -qO /tmp/ts.tgz "https://pkgs.tailscale.com/stable/$tgz"; \
    tar -xzf /tmp/ts.tgz -C /tmp; \
    dir="/tmp/${tgz%.tgz}"; \
    install -m 0755 "$dir/tailscale"  /usr/local/bin/tailscale; \
    install -m 0755 "$dir/tailscaled" /usr/local/bin/tailscaled; \
    rm -rf /tmp/ts.tgz "$dir"; \
    # Fail the build here rather than at 3am in someone's living room if the
    # binaries did not land on PATH — entrypoint.sh runs both by bare name.
    tailscale version; \
    tailscaled --version

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
