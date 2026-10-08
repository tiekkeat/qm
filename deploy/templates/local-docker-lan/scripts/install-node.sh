#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
if command -v node >/dev/null && command -v npm >/dev/null && node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>24||major===24&&minor>=15?0:1)' && npm --version | awk -F. '{exit !($1>11 || ($1==11 && $2>=10))}'; then
    echo "Using Node $(node --version), npm $(npm --version)."
    exit 0
fi
[[ "$(uname -m)" == x86_64 ]] || { echo 'This installer supports Linux x86_64.' >&2; exit 1; }
node_version=24.21.0
archive="node-v${node_version}-linux-x64.tar.xz"
cache_dir="$HOME/.cache/qm-installer"
node_dir="$HOME/.local/lib/node-v${node_version}-linux-x64"
mkdir -p "$cache_dir" "$HOME/.local/lib" "$HOME/.local/bin"
curl --fail --silent --show-error --location "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$cache_dir/SHASUMS256.txt"
curl --fail --silent --show-error --location "https://nodejs.org/dist/v${node_version}/$archive" -o "$cache_dir/$archive"
(cd "$cache_dir" && awk -v name="$archive" '$2==name {print}' SHASUMS256.txt | sha256sum --check --strict -)
tar -xJf "$cache_dir/$archive" -C "$HOME/.local/lib"
for executable in node npm npx; do
    target="$HOME/.local/bin/$executable"
    if [[ -e "$target" || -L "$target" ]]; then
        [[ -L "$target" && "$(readlink "$target")" == "$HOME/.local/lib/node-"*"/bin/$executable" ]] || {
            echo "Refusing to replace unmanaged executable $target." >&2
            exit 1
        }
    fi
    ln -sfn "$node_dir/bin/$executable" "$target"
done
node --version
npm --version
