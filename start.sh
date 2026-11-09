#!/usr/bin/env bash
# Starts camlib-ui: checks it's installed and its interface is built, then serves it.
#
#   ./start.sh                                  this machine only, http://127.0.0.1:8765
#   ./start.sh --lan                            on this machine's LAN address too
#   ./start.sh --projects ~/cam --port 9000     another projects folder and port
#   ./start.sh --build                          rebuild the interface first (after pulling changes)
#
# Run ./start.sh --help for every option. Install first: see README.md, Install.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

projects="${CAMLIB_UI_PROJECTS:-$ROOT/camlib-projects}"
host="127.0.0.1"
port="8765"
posts="${CAMLIB_POSTS:-}"
timeout="900"
build="no"
venv="${CAMLIB_UI_VENV:-$ROOT/.venv}"

usage() {
  cat <<EOF
Usage: ./start.sh [options]

Starts camlib-ui and prints the address to open.

Options:
  -p, --projects DIR     the projects folder (default: ./camlib-projects, or \$CAMLIB_UI_PROJECTS).
                         An empty or new folder is given the plate example.
      --host ADDRESS     the address to listen on (default: 127.0.0.1, this machine only)
      --lan              listen on this machine's LAN address, so other computers can open it
  -P, --port PORT        the port (default: 8765)
      --posts DIR        camlib's controller posts: a camlib checkout's examples/ folder
                         (default: \$CAMLIB_POSTS, else ../camlib/examples when it exists;
                         without them only the LinuxCNC post is available)
      --timeout SECONDS  a build's time limit (default: 900)
      --build            rebuild the interface before starting (after pulling changes)
      --venv DIR         the Python environment camlib-ui is installed in (default: ./.venv)
  -h, --help             show this help

camlib-ui runs your projects' Python code on this machine. --lan lets anyone on your
network open it: use it only on a network you trust.
EOF
}

die() { echo "start.sh: $*" >&2; exit 1; }
need() { [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || die "$1 needs a value (see --help)"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--projects) need "$@"; projects="$2"; shift 2 ;;
    --projects=*) projects="${1#*=}"; shift ;;
    --host) need "$@"; host="$2"; shift 2 ;;
    --host=*) host="${1#*=}"; shift ;;
    --lan) host="lan"; shift ;;
    -P|--port) need "$@"; port="$2"; shift 2 ;;
    --port=*) port="${1#*=}"; shift ;;
    --posts|--camlib-posts) need "$@"; posts="$2"; shift 2 ;;
    --posts=*|--camlib-posts=*) posts="${1#*=}"; shift ;;
    --timeout) need "$@"; timeout="$2"; shift 2 ;;
    --timeout=*) timeout="${1#*=}"; shift ;;
    --build) build="yes"; shift ;;
    --venv) need "$@"; venv="$2"; shift 2 ;;
    --venv=*) venv="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || die "--port must be a number from 1 to 65535, not '$port'"
[[ "$timeout" =~ ^[0-9]+$ ]] && (( timeout >= 1 )) || die "--timeout must be a whole number of seconds, not '$timeout'"

# The LAN address: the one this machine reaches the network from.
if [[ "$host" == "lan" ]]; then
  host="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  [[ -n "$host" ]] || host="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "$host" ]] || die "couldn't find this machine's LAN address: pass --host ADDRESS instead"
fi

# camlib-ui and camlib, installed (README.md, Install).
python="$venv/bin/python"
[[ -x "$python" ]] || die "no Python environment at $venv: install camlib-ui first (README.md, Install), or pass --venv DIR"
"$python" -c "import camlib_ui" 2>/dev/null || die "camlib-ui isn't installed in $venv: run  $venv/bin/pip install -e .  (README.md, Install)"
"$python" -c "import camlib.operations" 2>/dev/null \
  || die "camlib isn't installed in $venv (or it's PyPI's unrelated 'camlib'): install it from https://github.com/stevecad/camlib (README.md, Install)"

# The interface, built (npm run build writes it into camlib_ui/web/).
if [[ "$build" == "yes" || ! -f "$ROOT/camlib_ui/web/index.html" ]]; then
  command -v npm >/dev/null || die "the interface isn't built and npm isn't installed: install Node 22.18 or newer (README.md, Install)"
  echo "Building the interface…"
  if [[ ! -d "$ROOT/web/node_modules" ]]; then (cd "$ROOT/web" && npm ci --no-audit --no-fund); fi
  (cd "$ROOT/web" && npm run build)
fi

# camlib's posts: the option, else a camlib checkout beside this one.
if [[ -z "$posts" && -d "$ROOT/../camlib/examples" ]]; then posts="$ROOT/../camlib/examples"; fi
[[ -z "$posts" || -d "$posts" ]] || die "--posts: no such folder: $posts"

args=(--projects "$projects" --host "$host" --port "$port" --timeout "$timeout")
[[ -n "$posts" ]] && args+=(--camlib-posts "$posts")

if [[ "$host" != "127.0.0.1" && "$host" != "localhost" ]]; then
  echo "Note: listening on $host, so others on that network can open it, and it runs projects' code on this machine."
fi
echo "Open http://$host:$port  (Ctrl+C stops it)"
exec "$python" -m camlib_ui "${args[@]}"
