export function workflowIssueTitle(number: number, summary: string) {
  const text = summary.trim().replace(/^[#＃]\d+\s*[:：]?\s*/u, "")
    .replace(/^(?:(?:处理\s*)?(?:反馈|工单)\s*[#＃]?\s*\d+\s*[:：·|—-]?\s*|反馈\s*[:：]\s*)+/u, "").trim();
  if (!text) throw Error("请填写事项总结作为标题");
  return `#${number} ${text}`.slice(0, 120);
}
