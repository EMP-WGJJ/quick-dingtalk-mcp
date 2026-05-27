<#
.SYNOPSIS
    quick-dingtalk-mcp 更新脚本 (Windows PowerShell)
.DESCRIPTION
    自动完成以下步骤:
    1. 拉取远程最新代码（当前分支）
    2. 安装/更新项目依赖
    3. 升级 dws CLI（可选）
    4. 输出更新结果摘要
.NOTES
    用法:
      powershell -ExecutionPolicy Bypass -File scripts/update.ps1
      powershell -ExecutionPolicy Bypass -File scripts/update.ps1 -UpgradeDws
      powershell -ExecutionPolicy Bypass -File scripts/update.ps1 -Force
#>

param(
    [switch]$UpgradeDws,
    [switch]$Force,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ─── 工具函数 ───────────────────────────────────────────────────────
function Write-OK   { param($msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "  ✗ $msg" -ForegroundColor Red }
function Write-Info { param($msg) Write-Host "  → $msg" -ForegroundColor Cyan }

# ─── 帮助 ───────────────────────────────────────────────────────────
if ($Help) {
    Write-Host "用法: powershell -File scripts/update.ps1 [选项]"
    Write-Host ""
    Write-Host "选项:"
    Write-Host "  -UpgradeDws   同时升级 dws CLI"
    Write-Host "  -Force        强制重置到远程最新（丢弃本地修改）"
    Write-Host "  -Help         显示帮助"
    exit 0
}

# ─── 定位项目根目录 ─────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

Write-Host ""
Write-Info "quick-dingtalk-mcp 更新开始"
Write-Host "   项目路径: $ProjectDir"
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# Step 1: 记录当前版本
# ═══════════════════════════════════════════════════════════════════════
Write-Info "Step 1: 检查当前状态"

$CurrentBranch = git rev-parse --abbrev-ref HEAD 2>$null
if (-not $CurrentBranch) { $CurrentBranch = "unknown" }
$CurrentCommit = git rev-parse --short HEAD 2>$null
if (-not $CurrentCommit) { $CurrentCommit = "unknown" }

Write-Host "   当前分支: $CurrentBranch"
Write-Host "   当前提交: $CurrentCommit"

# ═══════════════════════════════════════════════════════════════════════
# Step 2: 拉取最新代码
# ═══════════════════════════════════════════════════════════════════════
Write-Info "Step 2: 拉取最新代码"

if ($Force) {
    Write-Warn "强制模式：重置到远程最新状态"
    git fetch origin 2>$null
    git reset --hard "origin/$CurrentBranch"
} else {
    # 检查本地修改
    $diffStatus = git status --porcelain 2>$null
    $Stashed = $false

    if ($diffStatus) {
        Write-Warn "检测到本地未提交的修改，暂存中..."
        git stash push -m "auto-stash before update $(Get-Date -Format 'yyyyMMdd-HHmmss')"
        $Stashed = $true
    }

    # 拉取
    $pullResult = git pull origin $CurrentBranch 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-OK "代码拉取成功"
    } else {
        Write-Err "代码拉取失败（可能有冲突），尝试 -Force 参数"
        if ($Stashed) {
            git stash pop 2>$null
        }
        exit 1
    }

    # 恢复暂存
    if ($Stashed) {
        $popResult = git stash pop 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-OK "本地修改已恢复"
        } else {
            Write-Warn "恢复暂存时有冲突，请手动处理: git stash pop"
        }
    }
}

$NewCommit = git rev-parse --short HEAD 2>$null
if (-not $NewCommit) { $NewCommit = "unknown" }

# ═══════════════════════════════════════════════════════════════════════
# Step 3: 更新项目依赖
# ═══════════════════════════════════════════════════════════════════════
Write-Info "Step 3: 更新项目依赖"

npm install 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-OK "依赖更新完成"
} else {
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Err "npm install 失败"
        exit 1
    }
}

# ═══════════════════════════════════════════════════════════════════════
# Step 4: 升级 dws（可选）
# ═══════════════════════════════════════════════════════════════════════
if ($UpgradeDws) {
    Write-Info "Step 4: 升级 dws CLI"

    $dwsCmd = Get-Command dws -ErrorAction SilentlyContinue
    if ($dwsCmd) {
        $DwsVerBefore = (dws --version 2>&1) | Select-Object -First 1
        $upgradeResult = dws upgrade 2>&1
        if ($LASTEXITCODE -eq 0) {
            $DwsVerAfter = (dws --version 2>&1) | Select-Object -First 1
            Write-OK "dws 升级完成: $DwsVerBefore → $DwsVerAfter"
        } else {
            Write-Warn "dws upgrade 失败，尝试 npm 方式..."
            npm update -g dingtalk-workspace-cli 2>$null
        }
    } else {
        Write-Warn "dws 未安装，跳过升级"
    }
}

# ═══════════════════════════════════════════════════════════════════════
# 输出更新摘要
# ═══════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "  ✅ 更新完成" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
Write-Host "   分支:  $CurrentBranch"
Write-Host "   提交:  $CurrentCommit → $NewCommit"

if ($CurrentCommit -eq $NewCommit) {
    Write-Host "   状态:  已是最新版本，无更新"
} else {
    Write-Host "   状态:  已更新到最新版本"
    Write-Host ""
    Write-Host "   更新内容:"
    $logs = git log --oneline "$CurrentCommit..$NewCommit" 2>$null | Select-Object -First 10
    foreach ($line in $logs) {
        Write-Host "     $line"
    }
}

Write-Host ""
Write-Host "   ⚠ 注意: MCP 服务需要重启才能加载新代码" -ForegroundColor Yellow
Write-Host "   重启方式: 在 MCP Host 中断开并重新连接"
Write-Host ""
