#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "error: ${PYTHON_BIN} not found" >&2
  exit 1
fi

"${PYTHON_BIN}" -m pip install --user -r "${ROOT_DIR}/requirements.txt"
chmod +x "${ROOT_DIR}/server.py"

cat <<EOF
Installed bridge files in:
  ${ROOT_DIR}

Next steps:
  export FNS_BASE_URL=http://127.0.0.1:9000
  export FNS_TOKEN='your-real-token'
  export FNS_DEFAULT_VAULT='Life-Learing'

  codex mcp add fns-local -- ${PYTHON_BIN} ${ROOT_DIR}/server.py
EOF
