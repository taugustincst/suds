FROM mirror.gcr.io/library/ubuntu:24.04
# Build-time only: reach the Ubuntu archive through the session's HTTPS proxy (docker build --network host).
COPY ca-bundle.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources \
 && echo 'Acquire::https::Proxy "http://127.0.0.1:35265";' > /etc/apt/apt.conf.d/99build-proxy \
 && apt-get update -q \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
      systemd systemd-sysv dbus ca-certificates curl xz-utils unzip ufw unattended-upgrades systemd-timesyncd \
      openssl iproute2 procps iptables sudo less \
 && rm -f /etc/apt/apt.conf.d/99build-proxy \
 && update-ca-certificates --fresh >/dev/null \
 && rm -rf /var/lib/apt/lists/*
# A VM-like boot: systemd as PID 1, no getty on a console that does not exist.
RUN systemctl mask getty@tty1.service console-getty.service systemd-firstboot.service 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
