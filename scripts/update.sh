#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# quick-dingtalk-mcp 更新脚本 (macOS / Linux)
#
# 用法:
#   bash scripts/update.sh
#   或通过 MCP tool (dingtalk_self_update) 由 agent 调用
#
# 自动完成:
#   1. 拉取远程最新代码（当前分支）
#   2. 安装/更新项目依赖
#   3. 升级 dws CLI（可选）
#   4. 输出更新结果摘要
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── 配色 ───────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()    { echo -e "${GREEN}✓ $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $1${NC}"; }
err()   { echo -e "${RED}✗ $1${NC}"; }
info()  { echo -e "${CYAN}→ $1${NC}"; }

# ─── 参数解析 ───────────────────────────────────────────────────────
UPGRADE_DWS=false
FORCE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --upgrade-dws) UPGRADE_DWS=true; shift ;;
        --force)       FORCE=true; shift ;;
        -h|--help)
            echo "用法: bash scripts/update.sh [选项]"
            echo ""
            echo "选项:"
            echo "  --upgrade-dws   同时升级 dws CLI"
            echo "  --force         强制重置到远程最新（丢弃本地修改）"
            echo "  -h, --help      显示帮助"
            exit 0
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

# ─── 定位项目根目录 ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo ""
info "quick-dingtalk-mcp 更新开始"
echo "   项目路径: $PROJECT_DIR"
echo ""

# ═══════════════════════════════════════════════════════════════════════
# Step 1: 记录当前版本
# ═══════════════════════════════════════════════════════════════════════
info "Step 1: 检查当前状态"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
CURRENT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
echo "   当前分支: $CURRENT_BRANCH"
echo "   当前提交: $CURRENT_COMMIT"

# ═══════════════════════════════════════════════════════════════════════
# Step 2: 拉取最新代码
# ═══════════════════════════════════════════════════════════════════════
info "Step 2: 拉取最新代码"

if [ "$FORCE" = true ]; then
    warn "强制模式：重置到远程最新状态"
    git fetch origin
    git reset --hard "origin/$CURRENT_BRANCH"
else
    # 检查是否有未提交的修改
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
        warn "检测到本地未提交的修改，暂存中..."
        git stash push -m "auto-stash before update $(date +%Y%m%d-%H%M%S)"
        STASHED=true
    else
        STASHED=false
    fi

    # 拉取
    if git pull origin "$CURRENT_BRANCH" 2>/dev/null; then
        ok "代码拉取成功"
    else
        err "代码拉取失败（可能有冲突），尝试 --force 参数"
        if [ "$STASHED" = true ]; then
            git stash pop 2>/dev/null || true
        fi
        exit 1
    fi

    # 恢复暂存
    if [ "$STASHED" = true ]; then
        if git stash pop 2>/dev/null; then
            ok "本地修改已恢复"
        else
            warn "恢复暂存时有冲突，请手动处理: git stash pop"
        fi
    fi
fi

NEW_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# ═══════════════════════════════════════════════════════════════════════
# Step 3: 更新项目依赖
# ═══════════════════════════════════════════════════════════════════════
info "Step 3: 更新项目依赖"

if npm install 2>&1 | tail -3; then
    ok "依赖更新完成"
else
    err "npm install 失败"
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 4: 升级 dws（可选）
# ═══════════════════════════════════════════════════════════════════════
if [ "$UPGRADE_DWS" = true ]; then
    info "Step 4: 升级 dws CLI"

    if command -v dws &>/dev/null; then
        DWS_VER_BEFORE=$(dws --version 2>&1 | head -1)
        if dws upgrade 2>/dev/null; then
            DWS_VER_AFTER=$(dws --version 2>&1 | head -1)
            ok "dws 升级完成: $DWS_VER_BEFORE → $DWS_VER_AFTER"
        else
            warn "dws upgrade 失败，尝试 npm 方式..."
            npm update -g dingtalk-workspace-cli 2>/dev/null || true
        fi
    else
        warn "dws 未安装，跳过升级"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════
# 输出更新摘要
# ═══════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✅ 更新完成${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "   分支:  $CURRENT_BRANCH"
echo "   提交:  $CURRENT_COMMIT → $NEW_COMMIT"

if [ "$CURRENT_COMMIT" = "$NEW_COMMIT" ]; then
    echo "   状态:  已是最新版本，无更新"
else
    echo "   状态:  已更新到最新版本"
    echo ""
    echo "   更新内容:"
    git log --oneline "$CURRENT_COMMIT..$NEW_COMMIT" 2>/dev/null | head -10 | sed 's/^/     /'
fi

echo ""
echo "   ⚠ 注意: MCP 服务需要重启才能加载新代码"
echo "   重启方式: 在 MCP Host 中断开并重新连接"
echo ""
