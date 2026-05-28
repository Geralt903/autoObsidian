#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
NODE_BIN="${NODE_BIN:-node}"
LOCAL_CONFIG="${ROOT_DIR}/local.config.sh"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "error: ${PYTHON_BIN} not found" >&2
  exit 1
fi

if ! command -v "${NODE_BIN}" >/dev/null 2>&1; then
  echo "error: ${NODE_BIN} not found" >&2
  exit 1
fi

cd "${ROOT_DIR}"
if [[ -f "${LOCAL_CONFIG}" ]]; then
  # shellcheck disable=SC1090
  source "${LOCAL_CONFIG}"
fi
"${PYTHON_BIN}" -m pip install --user -r requirements.txt
npm install

if [[ -z "${FNS_TOKEN:-}" ]]; then
  echo "error: FNS_TOKEN is not set" >&2
  exit 1
fi

if [[ -z "${FNS_BASE_URL:-}" ]]; then
  export FNS_BASE_URL="http://127.0.0.1:9000"
fi

if [[ -z "${FNS_DEFAULT_VAULT:-}" ]]; then
  export FNS_DEFAULT_VAULT="Life-Learing"
fi

echo "Bridge files ready in ${ROOT_DIR}"
echo
echo "1) Add Codex MCP server if not already added:"
echo "   codex mcp add fns-local -- ${PYTHON_BIN} ${ROOT_DIR}/server.py"
echo
echo "2) Start the mobile web app:"
echo "   npm run web"
echo
echo "Web app will be on:"
echo "   http://127.0.0.1:8000"
