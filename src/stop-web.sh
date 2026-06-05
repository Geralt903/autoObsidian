#!/usr/bin/env bash
# autoObsidian Web 终端 — 停止脚本
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${ROOT_DIR}/web.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "Web 服务未运行（无 PID 文件）"
  exit 0
fi

PID=$(cat "${PID_FILE}")

if kill -0 "${PID}" 2>/dev/null; then
  kill "${PID}"
  echo "Web 服务已停止 (PID: ${PID})"
else
  echo "进程已不存在 (PID: ${PID})"
fi

rm -f "${PID_FILE}"
