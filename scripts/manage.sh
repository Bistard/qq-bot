#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
用法: scripts/manage.sh [stop|restart|rebuild|restart-all|rebuild-all|napcat-logs|bot-logs]
  stop           关闭 NapCat 与 Bot 容器
  restart        只重启 Bot，不动 NapCat (docker compose up -d --force-recreate bot)
  rebuild        只重建 Bot 镜像并重启，不动 NapCat (docker compose up -d --build --force-recreate bot)
  restart-all    停止并重启全部服务 (docker compose down && docker compose up -d)
  rebuild-all    停止 -> 重新构建全部镜像 -> 启动 (docker compose down && docker compose up -d --build)
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
    docker compose up -d --force-recreate bot
    ;;
  rebuild)
    docker compose up -d --build --force-recreate bot
    ;;
  restart-all)
    docker compose down
    docker compose up -d
    ;;
  rebuild-all)
    docker compose down
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
