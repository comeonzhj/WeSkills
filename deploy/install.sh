#!/usr/bin/env bash
set -euo pipefail
umask 077

archive=$1
port=$2
domain=$3
base=/opt/weskills
data=/var/lib/weskills
config=/etc/weskills
unit=/etc/systemd/system/weskills.service
[[ $(id -u) == 0 ]] || { echo "Root or passwordless sudo is required" >&2; exit 1; }
command -v systemctl >/dev/null
command -v curl >/dev/null
command -v openssl >/dev/null
mkdir -p "$base"
exec 9>"$base/deploy.lock"
flock -n 9 || { echo "Another WeSkills deployment is running" >&2; exit 1; }

if [[ -n $domain ]]; then
  if [[ -x /www/server/nginx/sbin/nginx && -f /www/server/nginx/conf/nginx.conf &&
        -d /www/server/panel/vhost/nginx ]]; then
    nginx=(/www/server/nginx/sbin/nginx -c /www/server/nginx/conf/nginx.conf)
    vhosts=/www/server/panel/vhost/nginx
  else
    nginx=("$(command -v nginx)")
    vhosts=/etc/nginx/conf.d
  fi
  command -v certbot >/dev/null
  site="$vhosts/weskills-$domain.conf"
  mkdir -p "$vhosts"
  current_config=$("${nginx[@]}" -T 2>&1)
  if [[ -f $site ]] && ! grep -q '^# Managed by WeSkills$' "$site"; then
    echo "The target virtual host file already exists" >&2
    exit 1
  fi
  if [[ ! -f $site ]] && awk -v domain="$domain" '
    $1 == "server_name" { for (i = 2; i <= NF; i++) { field = $i; sub(/;$/, "", field); if (field == domain) found=1 } }
    END { exit !found }' <<< "$current_config"; then
    echo "This domain already has an Nginx site" >&2
    exit 1
  fi
fi

if [[ ! -e $unit ]] && ss -H -ltn "sport = :$port" | grep -q .; then
  echo "The requested local port is already in use" >&2
  exit 1
fi
if [[ -e $unit ]] && ! grep -q '^# Managed by WeSkills$' "$unit"; then
  echo "The systemd service name is already in use" >&2
  exit 1
fi

node_bin=$(command -v node || true)
if [[ -z $node_bin ]] || ! "$node_bin" -e 'process.exit(Number(+process.versions.node.split(".")[0] < 24))'; then
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "Install Node.js 24+ for this architecture" >&2; exit 1 ;; esac
  node_bin="$base/node/bin/node"
  if [[ ! -x $node_bin ]]; then
    download=$(mktemp -d)
    (
      trap 'rm -rf "$download"' EXIT
      cd "$download"
      upstream=https://nodejs.org/dist/latest-v24.x
      curl --connect-timeout 10 --max-time 120 -fsS "$upstream/SHASUMS256.txt" -o SHASUMS256.txt
      grep -E "^[a-f0-9]{64}  node-v24\.[0-9]+\.[0-9]+-linux-$arch\.tar\.xz$" SHASUMS256.txt > selected.sha256
      package=$(awk '{print $2}' selected.sha256)
      curl --connect-timeout 10 --max-time 120 -fsS "$upstream/$package" -o "$package"
      sha256sum -c selected.sha256
      mkdir -p "$base/node"
      tar -xJf "$package" --strip-components=1 -C "$base/node"
    )
  fi
  chmod -R a+rX "$base/node"
fi
chmod 755 "$base"
id weskills >/dev/null 2>&1 || useradd --system --user-group --home-dir "$data" --shell /usr/sbin/nologin weskills
install -d -o weskills -g weskills -m 0700 "$data"
install -d -m 0700 "$config"
install -d -m 0755 "$base/releases"
env_file="$config/server.env"
if [[ ! -e $env_file ]]; then
  {
    printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'SETUP_TOKEN=%s\n' "$(openssl rand -hex 24)"
    printf 'DATA_DIR=%s\nPORT=%s\nHOST=127.0.0.1\n' "$data" "$port"
    if [[ -n $domain ]]; then printf 'PUBLIC_ORIGIN=https://%s\n' "$domain"
    else printf 'PUBLIC_ORIGIN=http://127.0.0.1:%s\n' "$port"; fi
  } > "$env_file"
elif ! grep -qx "PORT=$port" "$env_file" ||
     ! grep -Fxq "PUBLIC_ORIGIN=${domain:+https://$domain}" "$env_file" &&
     ! { [[ -z $domain ]] && grep -Fxq "PUBLIC_ORIGIN=http://127.0.0.1:$port" "$env_file"; }; then
  echo "The deployed origin or port differs from the request" >&2
  exit 1
fi
previous=$(readlink "$base/current" || true)
release=$(mktemp -d "$base/releases/release.XXXXXXXX")
backups=$(mktemp -d)
[[ ! -f $unit ]] || cp -a "$unit" "$backups/unit"
if [[ -n $domain && -f $site ]]; then cp -a "$site" "$backups/site"; fi
activated=0
site_changed=0
rollback() {
  local status=$?
  if (( status != 0 )); then
    if (( site_changed )); then
      if [[ -f $backups/site ]]; then cp -a "$backups/site" "$site"; else rm -f "$site"; fi
      "${nginx[@]}" -t && "${nginx[@]}" -s reload || true
    fi
    if (( activated )); then
      if [[ -n $previous ]]; then ln -sfn "$previous" "$base/current"; else rm -f "$base/current"; fi
      if [[ -f $backups/unit ]]; then cp -a "$backups/unit" "$unit"; else systemctl disable --now weskills || true; rm -f "$unit"; fi
      systemctl daemon-reload
      [[ -z $previous ]] || systemctl restart weskills || true
    fi
  fi
  rm -rf "$backups"
}
trap rollback EXIT
tar -xzf "$archive" -C "$release" --no-same-owner
chmod -R a+rX "$release"
cat > "$unit" <<UNIT
# Managed by WeSkills
[Unit]
Description=WeSkills registry
After=network.target

[Service]
Type=simple
User=weskills
Group=weskills
WorkingDirectory=$base/current
EnvironmentFile=$env_file
ExecStart=$node_bin $base/current/dist/server.cjs
Restart=on-failure
RestartSec=2
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$data

[Install]
WantedBy=multi-user.target
UNIT
chmod 644 "$unit"
activated=1
ln -sfn "$release" "$base/current"
systemctl daemon-reload
systemctl enable weskills
systemctl restart weskills
curl --noproxy "*" --max-time 10 -fsS --retry 10 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$port/healthz" >/dev/null

if [[ -n $domain ]]; then
  acme="$base/acme"
  install -d -m 0755 "$acme"
  certificate="/etc/letsencrypt/live/$domain"
  if [[ ! -s $certificate/fullchain.pem ]]; then
    site_changed=1
    cat > "$site" <<NGINX
# Managed by WeSkills
server {
    listen 80;
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ { root $acme; }
    location / { return 404; }
}
NGINX
    "${nginx[@]}" -t && "${nginx[@]}" -s reload
    certbot certonly --webroot -w "$acme" -d "$domain" --cert-name "$domain" --agree-tos --register-unsafely-without-email --non-interactive
  fi
  site_changed=1
  cat > "$site" <<NGINX
# Managed by WeSkills
server {
    listen 80;
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ { root $acme; }
    location / { return 301 https://$domain\$request_uri; }
}
server {
    listen 443 ssl;
    server_name $domain;
    ssl_certificate $certificate/fullchain.pem;
    ssl_certificate_key $certificate/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 3m;
    location / {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
NGINX
  "${nginx[@]}" -t && "${nginx[@]}" -s reload
  curl --noproxy "*" --max-time 10 -fsS --retry 8 --retry-all-errors --retry-delay 1 --resolve "$domain:443:127.0.0.1" "https://$domain/healthz" >/dev/null
  renewal=/etc/letsencrypt/renewal-hooks/deploy/weskills-$domain
  mkdir -p "$(dirname "$renewal")"
  {
    printf '#!/bin/bash\n'
    printf '[[ ${RENEWED_LINEAGE:-} == %q ]] || exit 0\n' "$certificate"
    printf '%q ' "${nginx[@]}" -t
    printf '&& '
    printf '%q ' "${nginx[@]}" -s reload
    printf '\n'
  } > "$renewal"
  chmod 755 "$renewal"
fi
echo "Deployed WeSkills. Retrieve the one-time bootstrap token from $env_file over SSH."
