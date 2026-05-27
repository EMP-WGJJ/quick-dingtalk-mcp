/**
 * 安全引导模块
 *
 * 当 AI agent 尝试调用已被移除的危险操作时，返回友好的引导信息，
 * 告知用户该操作需要在钉钉客户端中手动完成，而非通过 AI 执行。
 *
 * 这样 AI 不会"寻找各种办法"绕过限制，而是直接引导用户。
 */

/**
 * 危险操作关键词到友好引导信息的映射
 */
const GUIDANCE_MAP = {
  // 群管理类
  dismiss: {
    action: "解散群聊",
    guide: "请在钉钉 App 中打开群聊 → 群设置 → 解散群聊",
  },
  mute: {
    action: "群全员禁言",
    guide: "请在钉钉 App 中打开群聊 → 群设置 → 群管理 → 全员禁言",
  },
  set_admin: {
    action: "设置群管理员",
    guide: "请在钉钉 App 中打开群聊 → 群设置 → 群管理 → 设置管理员",
  },

  // 消息类
  recall: {
    action: "撤回消息/DING",
    guide: "请在钉钉 App 中长按消息 → 撤回",
  },

  // 删除类
  delete: {
    action: "删除操作",
    guide: "请在钉钉 App 或钉钉网页版中手动执行删除",
  },
  remove: {
    action: "移除操作",
    guide: "请在钉钉 App 中进入对应管理页面手动移除",
  },

  // 审批类
  approve: {
    action: "审批同意",
    guide: "请在钉钉 App → 工作台 → OA审批 中处理审批",
  },
  reject: {
    action: "审批拒绝",
    guide: "请在钉钉 App → 工作台 → OA审批 中处理审批",
  },
  revoke: {
    action: "撤销审批",
    guide: "请在钉钉 App → 工作台 → OA审批 → 已发起 中撤销",
  },
};

/**
 * 危险 tool 名称模式匹配
 */
const DANGEROUS_NAME_PATTERNS = [
  /dismiss/i,
  /recall/i,
  /revoke/i,
  /delete/i,
  /remove_participant/i,
  /remove_member/i,
  /mute_group/i,
  /set_admin/i,
  /oa_approve/i,
  /oa_reject/i,
];

/**
 * 检查是否是被移除的危险操作，返回友好引导信息
 * @param {string} toolName - 尝试调用的 tool 名称
 * @returns {string|null} 引导信息（如果匹配），否则 null
 */
export function getDangerousToolGuidance(toolName) {
  const name = toolName.toLowerCase();

  // 检查是否匹配危险模式
  const isBlocked = DANGEROUS_NAME_PATTERNS.some((pattern) => pattern.test(name));
  if (!isBlocked) return null;

  // 找到最匹配的引导信息
  for (const [keyword, info] of Object.entries(GUIDANCE_MAP)) {
    if (name.includes(keyword)) {
      return formatGuidance(info.action, info.guide);
    }
  }

  // 通用引导
  return formatGuidance(
    "危险操作",
    "该操作出于安全考虑已被禁用。请在钉钉 App 中手动完成此操作。"
  );
}

/**
 * 格式化引导信息
 */
function formatGuidance(action, guide) {
  return [
    `🚫 安全提示：「${action}」不支持通过 AI 执行`,
    "",
    `📱 请手动操作：`,
    `   ${guide}`,
    "",
    `💡 原因：此类操作具有不可逆性或重大影响，为保护您的数据安全，`,
    `   仅允许在钉钉客户端中由本人确认后执行。`,
    "",
    `如需帮助，我可以：`,
    `  • 查询相关信息（如群成员列表、审批详情等）`,
    `  • 帮你准备操作所需的 ID 和参数`,
    `  • 提供操作步骤指引`,
  ].join("\n");
}
