#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "Usage: ./deploy/ssh.sh HOST USER SSH_KEY [DOMAIN]" >&2
  exit 2
fi
host=$1
user=$2
key=$3
domain=${4:-}
port=${WESKILLS_PORT:-8787}
[[ $host =~ ^[[:alnum:].:-]+$ && $user =~ ^[[:alnum:]_-]+$ ]] || { echo "Invalid SSH destination" >&2; exit 2; }
[[ -f $key && ( -z $domain || $domain =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$ ) ]] || {
  echo "Provide an existing SSH key and a valid DNS name" >&2; exit 2;
}
[[ $port =~ ^[0-9]{2,5}$ ]] && (( 10#$port >= 1024 && 10#$port <= 65535 )) || { echo "Invalid service port" >&2; exit 2; }
port=$((10#$port))
cd "$(dirname "$0")/.."
if [[ ! -d node_modules ]]; then npm ci; fi
npm run build

stage=$(mktemp -d)
ssh_cmd=(ssh -i "$key" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12 "$user@$host")
remote_stage=$("${ssh_cmd[@]}" 'mktemp -d /tmp/weskills-release.XXXXXXXX')
[[ $remote_stage =~ ^/tmp/weskills-release\.[[:alnum:]]+$ ]] || exit 1
cleanup() {
  rm -rf "$stage"
  "${ssh_cmd[@]}" "rm -rf -- '$remote_stage'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$stage"/{dist,public,migrations}
cp dist/server.cjs "$stage/dist/"
cp public/{logo.png,favicon.png,apple-touch-icon.png} "$stage/public/"
cp -R public/assets "$stage/public/"
cp migrations/*.sql "$stage/migrations/"
tar_options=()
if [[ $(uname -s) == Darwin ]]; then tar_options=(--no-xattrs --no-mac-metadata); fi
COPYFILE_DISABLE=1 tar "${tar_options[@]}" -C "$stage" -czf "$stage/release.tar.gz" dist public migrations
"${ssh_cmd[@]}" "cat > '$remote_stage/release.tar.gz'" < "$stage/release.tar.gz"
"${ssh_cmd[@]}" "cat > '$remote_stage/install.sh'" < deploy/install.sh
"${ssh_cmd[@]}" "if [ \$(id -u) -eq 0 ]; then bash '$remote_stage/install.sh' '$remote_stage/release.tar.gz' '$port' '$domain'; else sudo -n bash '$remote_stage/install.sh' '$remote_stage/release.tar.gz' '$port' '$domain'; fi"
if [[ -z $domain ]]; then
  printf 'Open an SSH tunnel with local port %s to server port %s, then use http://127.0.0.1:%s/setup\n' "$port" "$port" "$port"
else
  curl --max-time 10 --fail --silent --show-error --retry 3 --retry-all-errors "https://$domain/healthz"
  printf '\nOpen https://%s/setup to initialize WeSkills.\n' "$domain"
fi
