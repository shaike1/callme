FROM debian:bookworm-slim

# Install 3CX SmartSBC from the official 3CX apt repository
# Only x86_64 (amd64) is supported by 3CX — see ARM64 notes in docs/SETUP.md
# Use the keyring copied directly from the host (correct 3CX repo key)
COPY 3cx-archive-keyring.gpg /usr/share/keyrings/3cx-archive-keyring.gpg
COPY 3cxsbc-reprovision /usr/local/bin/3cxsbc-reprovision
RUN apt-get update && \
    apt-get install -y ca-certificates wget --no-install-recommends && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/3cx-archive-keyring.gpg] http://repo.3cx.com/3cx bookworm main" \
      > /etc/apt/sources.list.d/3cx.list && \
    apt-get update && \
    printf '#!/bin/sh\nexit 0\n' > /usr/bin/systemctl && chmod +x /usr/bin/systemctl && \
    apt-get install -y 3cxsbc --no-install-recommends && \
    install -m 0755 /usr/local/bin/3cxsbc-reprovision /usr/sbin/3cxsbc-reprovision && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# The SBC config is volume-mounted from the host at runtime.
# Generate it by running: ./sbc/provision.sh  (see docs/SETUP.md Step 1)
# The file is auto-rewritten by the SBC on each restart — do not edit manually.
VOLUME ["/etc/3cxsbc.conf"]

CMD ["/usr/sbin/3cxsbc", "-m", "/etc/3cxsbc.conf"]
