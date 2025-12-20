#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
用法: scripts/manage.sh [stop|restart|rebuild]
  stop     关闭 NapCat 与 Bot 容器
  restart  启动/重启全部服务 (docker compose up -d)
  rebuild  重新构建镜像并重启 (docker compose up -d --build)
  napcat-logs  实时查看 NapCat 日志 (docker compose logs -f napcat)
  bot-logs    实时查看 Bot 日志 (docker compose logs -f bot)
EOF
}

cmd="${1:-}"
case "$cmd" in
  stop)
    docker compose down
    ;;
  restart)
    docker compose up -d
    ;;
  rebuild)
    docker compose up -d --build
    ;;
  napcat-logs)
    docker compose logs -f napcat
    ;;
  bot-logs)
    docker compose logs -f bot
    ;;
  *)
    usage
    exit 1
    ;;
esac
