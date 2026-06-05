#!/usr/bin/env bash
# autoObsidian Web 终端 — 后台启动脚本
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${ROOT_DIR}/local.config.sh"
PID_FILE="${ROOT_DIR}/web.pid"
LOG_FILE="${ROOT_DIR}/web.log"

if [[ -f "${PID_FILE}" ]]; then
  OLD_PID=$(cat "${PID_FILE}")
  if kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "Web 服务已在运行 (PID: ${OLD_PID})"
    echo "如需重启，先执行 ./stop-web.sh"
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

cd "${ROOT_DIR}"

# 加载配置
if [[ -f "${CONFIG_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${CONFIG_FILE}"
fi

if [[ -z "${FNS_TOKEN:-}" ]]; then
  echo "error: FNS_TOKEN 未设置" >&2
  exit 1
fi

# 后台启动
nohup bash -lc "cd ${ROOT_DIR} && source ${CONFIG_FILE} && node web-terminal.js" > "${LOG_FILE}" 2>&1 &
PID=$!
echo "${PID}" > "${PID_FILE}"

sleep 1
if kill -0 "${PID}" 2>/dev/null; then
  echo "Web 服务已启动"
  echo "  PID: ${PID}"
  echo "  地址: http://127.0.0.1:${WEB_TERMINAL_PORT:-8000}"
  echo "  日志: ${LOG_FILE}"
  echo "  停止: ./stop-web.sh"
else
  echo "启动失败，查看日志: ${LOG_FILE}"
  rm -f "${PID_FILE}"
  exit 1
fi
