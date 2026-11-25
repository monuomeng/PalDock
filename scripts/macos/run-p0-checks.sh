#!/usr/bin/env bash
# PalDock P0 macOS 检查：在仓库根目录运行 `bash scripts/macos/run-p0-checks.sh`。
# 自动部分不需要任何账号，也不调用模型；结束时把结果打包为 p0-macos-results.zip。
# 加 --skip-manual 跳过需要人操作的锁屏 / 空闲步骤（例如由 AI 代理独立运行时）。
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
OUT="$ROOT/p0-macos-results"
SKIP_MANUAL=0
[ "${1:-}" = "--skip-manual" ] && SKIP_MANUAL=1
rm -rf "$OUT" && mkdir -p "$OUT"

step() { printf '\n==== %s ====\n' "$1" | tee -a "$OUT/run.log"; }
run() { # 记录命令、输出和退出码，失败不中断后续步骤
  echo "\$ $*" >> "$OUT/run.log"
  "$@" >> "$OUT/run.log" 2>&1
  local code=$?
  echo "exit=$code" | tee -a "$OUT/run.log"
  return $code
}

step "1. 环境"
{
  echo "date: $(date -u +%FT%TZ)"
  echo "macOS: $(sw_vers -productVersion) ($(uname -m))"
  echo "node: $(node -v 2>&1)"
  echo "pnpm: $(pnpm -v 2>&1)"
  echo "git: $(git --version 2>&1)"
  echo "commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'not a git checkout')"
  diskutil info / 2>/dev/null | grep -E 'File System Personality|Name \(User Visible\)'
} | tee "$OUT/environment.txt"

step "2. 安装依赖并预先下载 Electron 二进制"
run pnpm install --frozen-lockfile
# Electron 45 只在首次运行时下载二进制，下载失败会让第 5 步直接报错（Mac 首轮实测）。
# 这里提前下载并重试；网络慢时可先 export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ELECTRON_PKG="$(node -e "console.log(require('path').dirname(require.resolve('electron/package.json', { paths: ['apps/desktop'] })))")"
for attempt in 1 2 3; do
  run node "$ELECTRON_PKG/install.js" && break
  echo "Electron 下载第 $attempt 次失败，重试" | tee -a "$OUT/run.log"
  sleep 5
done

step "3. 构建与单元测试"
run pnpm build
run pnpm test

step "4. 本地服务进程（fork 方式）"
run node scripts/p0/fork-check.mjs "$ROOT"

step "5. Electron 窗口实机检查（会弹出窗口，约两分钟后自动关闭；用离线模拟执行器，不耗额度）"
run node scripts/p1/e2e-check.mjs
[ -f p1-e2e-check.json ] && cp p1-e2e-check.json "$OUT/"

step "6. git worktree 与大小写"
run node scripts/p0/worktree-check.mjs
[ -f p0-worktree-check.json ] && cp p0-worktree-check.json "$OUT/"

step "7. 执行器发现（零成本，只读版本和登录状态；未安装时会如实报告）"
# 直接重定向到结果文件（不经 run，否则输出会写进 run.log）
node packages/runtime-codex/dist/probe.js > "$OUT/codex-discovery.json" 2>&1 || true
node packages/runtime-claude/dist/probe.js > "$OUT/claude-discovery.json" 2>&1 || true
cat "$OUT/codex-discovery.json" "$OUT/claude-discovery.json" >> "$OUT/run.log"

step "7b. 系统钥匙串读写（P2 渠道凭据；只用随机假秘密，结束时删除）"
run node scripts/p2/credential-check.mjs
[ -f p2-credential-check.json ] && cp p2-credential-check.json "$OUT/"

if [ "$SKIP_MANUAL" -eq 0 ]; then
  step "8. 电源与空闲事件（需要人操作）"
  DATA="$(mktemp -d -t pd-power)"
  ELECTRON="$(node -e "console.log(require(require.resolve('electron', { paths: ['apps/desktop'] })))")"
  PALDOCK_DATA_ROOT="$DATA" PALDOCK_DIAGNOSTICS=1 "$ELECTRON" apps/desktop > "$OUT/power-app.log" 2>&1 &
  APP=$!
  echo "PalDock 窗口已打开。请依次："
  echo "  a) 按 Control+Command+Q 锁屏，等 30 秒后解锁；"
  echo "  b) 不碰鼠标键盘 90 秒（让系统进入空闲）；"
  echo "  c) 可选：合上盖子或选择「睡眠」，1 分钟后唤醒。"
  read -r -p "全部完成后按回车继续…" _
  kill "$APP" 2>/dev/null; sleep 3
  cp "$DATA/diagnostics.log" "$OUT/power-diagnostics.log" 2>/dev/null || echo "没有生成 diagnostics.log" | tee -a "$OUT/run.log"
else
  echo "跳过第 8 步（--skip-manual）" | tee -a "$OUT/run.log"
fi

rm -f "$ROOT/p0-macos-results.zip"
(cd "$ROOT" && zip -qr p0-macos-results.zip p0-macos-results)
step "完成：请把 $ROOT/p0-macos-results.zip 发回给 PalDock 开发者"
