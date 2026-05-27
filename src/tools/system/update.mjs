/**
 * 系统自更新 tool
 *
 * 让 AI agent 可以通过文本理解，执行脚本完成 MCP 服务的更新。
 * 不走 dws CLI，直接执行本地更新脚本。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WRITE_IDEMPOTENT } from "../../framework/annotations.mjs";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const SCRIPTS_DIR = resolve(PROJECT_ROOT, "scripts");
const UPDATE_TIMEOUT_MS = 120_000; // 更新超时 2 分钟

/**
 * 检测当前操作系统并返回对应的更新脚本路径和执行命令
 */
function getUpdateCommand(options = {}) {
  const isWindows = process.platform === "win32";
  const args = [];

  if (isWindows) {
    const script = resolve(SCRIPTS_DIR, "update.ps1");
    const cmd = "powershell";
    const cmdArgs = ["-ExecutionPolicy", "Bypass", "-File", script];
    if (options.upgradeDws) cmdArgs.push("-UpgradeDws");
    if (options.force) cmdArgs.push("-Force");
    return { cmd, args: cmdArgs, script };
  } else {
    const script = resolve(SCRIPTS_DIR, "update.sh");
    const cmd = "bash";
    const cmdArgs = [script];
    if (options.upgradeDws) cmdArgs.push("--upgrade-dws");
    if (options.force) cmdArgs.push("--force");
    return { cmd, args: cmdArgs, script };
  }
}

/**
 * 获取当前版本信息（git commit + branch）
 */
async function getVersionInfo() {
  try {
    const { stdout: branch } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    });
    const { stdout: commit } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    });
    const { stdout: log } = await execFileAsync("git", ["log", "--oneline", "-5"], {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    });
    return {
      branch: branch.trim(),
      commit: commit.trim(),
      recentCommits: log.trim(),
    };
  } catch {
    return { branch: "unknown", commit: "unknown", recentCommits: "" };
  }
}

export default [
  // ─── 检查更新状态 ──────────────────────────────────────
  {
    name: "dingtalk_check_update",
    description:
      "检查 quick-dingtalk-mcp 是否有可用更新。显示当前版本、分支、最近提交，以及远程是否有新提交。",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {},
    },
    // 自定义执行（不走 dws CLI）
    _customExecutor: true,
    async execute() {
      const versionInfo = await getVersionInfo();

      // 检查远程是否有更新
      let updateAvailable = "unknown";
      let behindCount = 0;
      try {
        await execFileAsync("git", ["fetch", "origin", "--dry-run"], {
          cwd: PROJECT_ROOT,
          timeout: 15000,
        });
        const { stdout } = await execFileAsync(
          "git",
          ["rev-list", "--count", `HEAD..origin/${versionInfo.branch}`],
          { cwd: PROJECT_ROOT, timeout: 5000 }
        );
        behindCount = parseInt(stdout.trim(), 10) || 0;
        updateAvailable = behindCount > 0 ? "yes" : "no";
      } catch {
        updateAvailable = "check_failed";
      }

      const lines = [
        `quick-dingtalk-mcp 版本信息`,
        ``,
        `分支: ${versionInfo.branch}`,
        `当前提交: ${versionInfo.commit}`,
        ``,
        `最近提交:`,
        versionInfo.recentCommits,
        ``,
        `有可用更新: ${updateAvailable === "yes" ? `是（落后 ${behindCount} 个提交）` : updateAvailable === "no" ? "否（已是最新）" : "检查失败"}`,
      ];

      if (updateAvailable === "yes") {
        lines.push(``, `使用 dingtalk_self_update 工具执行更新。`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  },

  // ─── 执行自我更新 ──────────────────────────────────────
  {
    name: "dingtalk_self_update",
    description:
      "更新 quick-dingtalk-mcp 到最新版本。执行 git pull + npm install，可选同时升级 dws CLI。更新后需重启 MCP 服务才能加载新代码。",
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: "object",
      properties: {
        upgrade_dws: {
          type: "boolean",
          description: "是否同时升级 dws CLI（默认 false）",
        },
        force: {
          type: "boolean",
          description: "是否强制重置到远程最新版本（丢弃本地修改，默认 false）",
        },
      },
    },
    // 自定义执行（不走 dws CLI）
    _customExecutor: true,
    async execute(args = {}) {
      const options = {
        upgradeDws: args.upgrade_dws === true,
        force: args.force === true,
      };

      const { cmd, args: cmdArgs, script } = getUpdateCommand(options);

      // 检查脚本是否存在
      if (!existsSync(script)) {
        return {
          content: [{ type: "text", text: `Error: 更新脚本不存在: ${script}\n请确保项目完整。` }],
          isError: true,
        };
      }

      try {
        const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
          cwd: PROJECT_ROOT,
          timeout: UPDATE_TIMEOUT_MS,
          maxBuffer: 5 * 1024 * 1024,
          env: { ...process.env, FORCE_COLOR: "0" }, // 禁用颜色码，避免乱码
        });

        const output = (stdout || "").trim() + "\n" + (stderr || "").trim();
        return { content: [{ type: "text", text: output.trim() }] };
      } catch (err) {
        const parts = [`更新执行失败: ${err.message}`];
        if (err.stdout) parts.push(`stdout: ${err.stdout.trim()}`);
        if (err.stderr) parts.push(`stderr: ${err.stderr.trim()}`);
        return {
          content: [{ type: "text", text: parts.join("\n") }],
          isError: true,
        };
      }
    },
  },
];
