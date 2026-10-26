#!/usr/bin/env bash
# Installs or updates Bedo on a fresh Ubuntu 24.04 server from a release
# bundle (made by deploy/make-bundle.sh). Safe to run again for updates.
#
# Usage (as root):  bash deploy/install.sh bedoapp.com
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: bash deploy/install.sh your-domain.com" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this as root (log in as root, or prefix with sudo)." >&2
  exit 1
fi

BUNDLE="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/bedo
DATA_DIR=/var/lib/bedo
NODE_DIR=/opt/bedo-node

step() { printf '\n==> [%s] %s\n' "$1" "$2"; }

step 1/7 "Installing system packages (Caddy web server)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q caddy curl ca-certificates

step 2/7 "Installing Node.js from the bundle"
rm -rf "$NODE_DIR"
mkdir -p "$NODE_DIR"
tar -xJf "$BUNDLE"/runtime/node-*.tar.xz -C "$NODE_DIR" --strip-components=1
ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
node --version

step 3/7 "Copying the app"
id bedo >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin bedo
mkdir -p "$DATA_DIR"
rm -rf "$APP_DIR.new"
mkdir -p "$APP_DIR.new"
cp -a "$BUNDLE"/{server,public,node_modules,scripts,package.json} "$APP_DIR.new"/
rm -rf "$APP_DIR.old"
[[ -d "$APP_DIR" ]] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"
install -m 755 "$BUNDLE/runtime/pmtiles" /usr/local/bin/pmtiles
chown -R bedo:bedo "$DATA_DIR"

step 4/7 "Building the Iran map (downloads about 1 GB; can take a while)"
if [[ -s "$DATA_DIR/iran.pmtiles" ]]; then
  echo "Map already present, skipping. Delete $DATA_DIR/iran.pmtiles to rebuild."
elif OUT="$DATA_DIR/iran.pmtiles" PMTILES=/usr/local/bin/pmtiles bash "$APP_DIR/scripts/build-iran-map.sh"; then
  chown bedo:bedo "$DATA_DIR/iran.pmtiles"
else
  echo "WARNING: the map could not be built now. The app will use public"
  echo "OpenStreetMap tiles until you run this again:"
  echo "  OUT=$DATA_DIR/iran.pmtiles PMTILES=/usr/local/bin/pmtiles bash $APP_DIR/scripts/build-iran-map.sh && chown bedo:bedo $DATA_DIR/iran.pmtiles"
fi

step 5/7 "Setting up the Bedo service"
cat > /etc/systemd/system/bedo.service <<EOF
[Unit]
Description=Bedo territory game
After=network.target

[Service]
User=bedo
WorkingDirectory=$APP_DIR
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=DB_PATH=$DATA_DIR/bedo.sqlite
Environment=MAP_TILES_PATH=$DATA_DIR/iran.pmtiles
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable bedo >/dev/null
systemctl restart bedo

step 6/7 "Setting up HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN, www.$DOMAIN {
	# The map file is read with byte ranges, which must not be compressed.
	@compressible not path /map/*
	encode @compressible gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl enable caddy >/dev/null
systemctl restart caddy

step 7/7 "Checking"
for _ in $(seq 1 15); do
  curl -fsS http://127.0.0.1:3000/api/config >/dev/null 2>&1 && break
  sleep 1
done
if curl -fsS http://127.0.0.1:3000/api/config >/dev/null; then
  echo
  echo "Bedo is running. Open: https://$DOMAIN"
  echo "(The HTTPS certificate can take a minute or two the first time.)"
else
  echo "The app did not start. Show the log with:  journalctl -u bedo -n 50" >&2
  exit 1
fi
