/**
 * Safety Guard 中间件
 *
 * 在 tool 执行前进行安全检查，提供以下防护：
 * 1. @all 限制 — 禁止或限制 @所有人
 * 2. 频率限制 — 防止短时间内大量发送消息/DING
 * 3. 时间窗口保护 — 非工作时间禁止发送消息/DING（防止半夜打扰）
 * 4. 确认回显 — 写操作返回即将执行的摘要（dry-run 预览）
 *
 * 配置通过环境变量控制：
 * - SAFETY_GUARD=off          关闭所有防护（默认 on）
 * - SAFETY_ALLOW_AT_ALL=true  允许 @所有人（默认 false）
 * - SAFETY_RATE_LIMIT=10      每分钟最大写操作次数（默认 10）
 * - SAFETY_WORK_HOURS=9-21    工作时间范围（24h 格式，默认 8-22）
 * - SAFETY_TIMEZONE=+08:00    时区偏移（默认 +08:00）
 * - SAFETY_DRY_RUN=true       所有写操作强制 dry-run（默认 false）
 */

// ─── 配置 ─────────────────────────────────────────────

const ENABLED = (process.env.SAFETY_GUARD || "on") !== "off";
const ALLOW_AT_ALL = process.env.SAFETY_ALLOW_AT_ALL === "true";
const RATE_LIMIT = Number(process.env.SAFETY_RATE_LIMIT) || 10;
const WORK_HOURS = parseWorkHours(process.env.SAFETY_WORK_HOURS || "8-22");
const TIMEZONE_OFFSET = parseTimezoneOffset(process.env.SAFETY_TIMEZONE || "+08:00");
const FORCE_DRY_RUN = process.env.SAFETY_DRY_RUN === "true";

// ─── 频率限制状态 ─────────────────────────────────────

const writeLog = []; // timestamps of recent write operations
const RATE_WINDOW_MS = 60_000; // 1 minute window

// ─── 需要消息发送保护的 tools ─────────────────────────

const MESSAGE_TOOLS = new Set([
  "dingtalk_send_message",
  "dingtalk_send_ding",
  "dingtalk_send_mail",
  "dingtalk_reply_message",
  "dingtalk_forward_message",
  "dingtalk_send_card",
]);

// ─── 所有写操作类 tools 的前缀 ────────────────────────

const WRITE_PREFIXES = ["send", "create", "add", "update", "reply", "forward", "rename", "done"];

/**
 * 安全检查入口
 * @param {object} tool - tool 定义对象
 * @param {object} args - 用户传入的参数
 * @returns {{ allowed: boolean, reason?: string, warning?: string }}
 */
export function checkSafety(tool, args) {
  if (!ENABLED) return { allowed: true };

  const checks = [
    checkAtAll(tool, args),
    checkRateLimit(tool),
    checkWorkHours(tool),
  ];

  for (const result of checks) {
    if (!result.allowed) return result;
  }

  // 收集警告信息
  const warnings = checks.map((r) => r.warning).filter(Boolean);
  return { allowed: true, warning: warnings.join("; ") || undefined };
}

/**
 * 是否需要 dry-run 预览
 * @param {object} tool - tool 定义对象
 * @returns {boolean}
 */
export function shouldDryRun(tool) {
  if (!ENABLED || !FORCE_DRY_RUN) return false;
  // 只对写操作强制 dry-run
  return isWriteTool(tool);
}

/**
 * 记录一次写操作（用于频率限制统计）
 */
export function recordWrite() {
  writeLog.push(Date.now());
  // 清理过期记录
  const cutoff = Date.now() - RATE_WINDOW_MS;
  while (writeLog.length > 0 && writeLog[0] < cutoff) {
    writeLog.shift();
  }
}

/**
 * 生成确认回显摘要
 * @param {object} tool - tool 定义对象
 * @param {object} args - 用户传入的参数
 * @returns {string} 人可读的操作摘要
 */
export function buildConfirmSummary(tool, args) {
  const name = tool.name;
  const parts = [`⚠️ 即将执行: ${tool.description || name}`];

  if (args.chat_id) parts.push(`  群: ${args.chat_id}`);
  if (args.user_id) parts.push(`  用户: ${args.user_id}`);
  if (args.users) parts.push(`  目标用户: ${args.users}`);
  if (args.title) parts.push(`  标题: ${args.title}`);
  if (args.text) parts.push(`  内容: ${truncate(args.text, 100)}`);
  if (args.content) parts.push(`  内容: ${truncate(args.content, 100)}`);
  if (args.at_all) parts.push(`  ⚠️ @所有人`);

  return parts.join("\n");
}

// ─── 内部检查函数 ─────────────────────────────────────

/**
 * 检查 @all 限制
 */
function checkAtAll(tool, args) {
  if (ALLOW_AT_ALL) return { allowed: true };

  if (tool.name === "dingtalk_send_message" && args.at_all) {
    return {
      allowed: false,
      reason:
        "🚫 安全提示：「@所有人」不支持通过 AI 执行\n\n" +
        "📱 请手动操作：\n" +
        "   在钉钉 App 中打开群聊 → 输入框中 @所有人 → 发送\n\n" +
        "💡 原因：@所有人 会打扰群内全部成员，为避免误操作已禁用。\n" +
        "   如确需允许，请设置环境变量 SAFETY_ALLOW_AT_ALL=true",
    };
  }

  return { allowed: true };
}

/**
 * 检查频率限制
 */
function checkRateLimit(tool) {
  if (!isWriteTool(tool)) return { allowed: true };

  // 清理过期记录
  const cutoff = Date.now() - RATE_WINDOW_MS;
  while (writeLog.length > 0 && writeLog[0] < cutoff) {
    writeLog.shift();
  }

  if (writeLog.length >= RATE_LIMIT) {
    return {
      allowed: false,
      reason: `🚫 频率限制：每分钟最多 ${RATE_LIMIT} 次写操作（当前已 ${writeLog.length} 次）。请稍后再试。`,
    };
  }

  // 接近限制时给出警告
  if (writeLog.length >= RATE_LIMIT * 0.8) {
    return {
      allowed: true,
      warning: `⚠️ 接近频率限制（${writeLog.length}/${RATE_LIMIT} 次/分钟）`,
    };
  }

  return { allowed: true };
}

/**
 * 检查工作时间窗口
 */
function checkWorkHours(tool) {
  if (!MESSAGE_TOOLS.has(tool.name)) return { allowed: true };

  const now = new Date();
  const localHour = getLocalHour(now, TIMEZONE_OFFSET);

  if (localHour < WORK_HOURS.start || localHour >= WORK_HOURS.end) {
    return {
      allowed: false,
      reason:
        `🚫 时间保护：当前为非工作时间（${String(localHour).padStart(2, "0")}:00）\n\n` +
        `📱 消息发送仅允许在 ${WORK_HOURS.start}:00-${WORK_HOURS.end}:00 之间。\n\n` +
        `💡 如需在非工作时间发送，请在钉钉 App 中手动操作，避免打扰他人。\n` +
        `   或设置环境变量 SAFETY_WORK_HOURS=0-24 取消时间限制。`,
    };
  }

  return { allowed: true };
}

// ─── 工具函数 ─────────────────────────────────────────

function isWriteTool(tool) {
  if (tool.annotations && tool.annotations.readOnlyHint === true) return false;
  const n = tool.name.toLowerCase();
  return WRITE_PREFIXES.some((prefix) => n.includes(prefix));
}

function parseWorkHours(str) {
  const [start, end] = str.split("-").map(Number);
  return { start: start || 8, end: end || 22 };
}

function parseTimezoneOffset(str) {
  const match = str.match(/^([+-])(\d{1,2}):?(\d{2})?$/);
  if (!match) return 8 * 60; // default +08:00
  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || 0);
  return sign * (hours * 60 + minutes);
}

function getLocalHour(date, offsetMinutes) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60_000;
  const localMs = utcMs + offsetMinutes * 60_000;
  return new Date(localMs).getHours();
}

function truncate(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}
