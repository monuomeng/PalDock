import { z } from 'zod';
import type { McpToolDefinition } from './ipc.js';
import { MAX_PLAN_NODES, PlanNodeInput } from './plans.js';
import type { AgentRole } from './states.js';

const SPECIALISTS: readonly AgentRole[] = ['developer', 'tester', 'reviewer', 'docs', 'researcher'];
const COORDINATOR: readonly AgentRole[] = ['coordinator'];
const REVIEWER: readonly AgentRole[] = ['reviewer'];

/**
 * PalDock MCP 桥的工具：名字、哪些角色能用、参数。服务端按调用者令牌对应的角色校验，不信模型自报身份。
 * 这里只放已有后端的工具；跟进、取消、汇总等协调工具随主会话（P3-07）加入。
 * 工具都不写文件：MCP 服务进程在执行器沙箱外，能写文件就绕开了只读限制（P3-00 实测）。
 */
export const MCP_TOOLS = {
  get_task: {
    roles: SPECIALISTS,
    description: '读取当前子任务：任务目标、你的职责、交付范围、检查命令。开始工作前先调用一次。',
    args: z.object({}).strict(),
  },
  submit_result: {
    roles: SPECIALISTS,
    description: '提交这次的交接记录：做了什么、怎么验证的、还剩什么。每次 Run 只能提交一次；提交后由 PalDock 核对检查与交付范围。',
    args: z
      .object({
        summary: z.string().trim().min(1).max(4000).describe('做了什么、结果如何'),
        notes: z.string().trim().max(8000).optional().describe('给下游或审阅的补充：验证方式、已知问题、遗留事项'),
      })
      .strict(),
  },
  submit_review: {
    roles: REVIEWER,
    description: '审阅结束时交结论：accept 通过，或 rework 退回并写明要改什么。只有审阅这次交付的 Run 能交，每次只能交一份。',
    args: z
      .object({
        decision: z.enum(['accept', 'rework']).describe('accept 通过；rework 退回重做'),
        reason: z.string().trim().max(4000).optional().describe('退回时必填：要改什么、为什么'),
      })
      .strict()
      .refine((v) => v.decision === 'accept' || (v.reason?.length ?? 0) > 0, { message: '退回时要写明理由' }),
  },
  notify_user: {
    roles: COORDINATOR,
    description:
      '给用户发一条消息：汇报进展，或问一个需要用户决定的问题。先出现在桌面；用户没在电脑前时会发到已绑定的飞书或 Telegram 单聊。返回编号（例如 Q12），问题请让用户回复时带上编号。',
    args: z
      .object({
        message: z.string().trim().min(1).max(2000).describe('要告诉用户的话，简洁、说清楚需要用户做什么'),
        question: z.boolean().default(false).describe('需要用户回答时为 true'),
      })
      .strict(),
  },
  decide_approval: {
    roles: COORDINATOR,
    description:
      '处理交给你判断的审批：专业助手要读项目外的文件（只读，不含 shell）。看路径和它的理由，和当前任务相关、不涉及隐私就 allow，' +
      '明显无关或可疑就 deny，拿不准就 unsure（交给用户）。敏感路径和写入类的请求不会交给你。',
    args: z
      .object({
        approvalId: z.string().min(1).max(100).describe('唤醒消息里给的审批编号'),
        decision: z.enum(['allow', 'deny', 'unsure']),
        reason: z.string().trim().min(1).max(500).describe('一句话说明为什么'),
      })
      .strict(),
  },
  suggest_decision: {
    roles: COORDINATOR,
    description:
      '在这个对话里问用户一个需要他决定的问题（审批或 Git 卡片），登记你的明确建议；问题下面会出现按钮。一次只问一件事；' +
      '推送、合并、敏感路径、项目外写入要在 text 里写明目标。对话里已经有问题在等回答时，只能在回应用户的这一轮里把它改成范围更小的版本。',
    args: z
      .object({
        text: z.string().trim().min(1).max(1000).describe('给用户的一两句话：哪个助手在做什么、为什么需要他决定、你建议怎么处理'),
        items: z
          .array(
            z
              .object({
                ref: z.string().min(1).max(100).describe('审批编号或 Git 卡片编号'),
                decision: z.enum(['allow', 'deny', 'confirm', 'cancel']).describe('你的建议：审批 allow / deny，Git 卡片 confirm / cancel'),
                hunkIds: z.array(z.string().min(1).max(40)).max(200).optional().describe('提交卡片：要提交的改动块'),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict(),
  },
  resolve_approvals: {
    roles: COORDINATOR,
    description:
      '用户在这个对话里回答了你的问题时，把他的决定交给 PalDock 执行。读懂整句再交：提问、带否定或还没决定的话不算同意，先追问。' +
      '可以只处理问题里的一部分（例如「第一张可以」只放行第一张）；问题之外的事项不能顺带处理。',
    args: z
      .object({
        questionId: z.string().min(1).max(100),
        items: z
          .array(
            z
              .object({
                ref: z.string().min(1).max(100),
                decision: z.enum(['allow', 'deny', 'confirm', 'cancel']),
                hunkIds: z.array(z.string().min(1).max(40)).max(200).optional().describe('提交卡片：用户说要提交的块'),
              })
              .strict(),
          )
          .min(1)
          .max(20),
        userMessageId: z.number().int().positive().describe('用户这条回复的消息编号（唤醒里给出）'),
        decisionQuote: z.string().trim().min(1).max(500).describe('用户那条消息里表示决定的原话（原样引用）'),
      })
      .strict(),
  },
  write_summary: {
    roles: [...COORDINATOR, ...SPECIALISTS],
    description:
      '写这个会话的摘要，PalDock 提示时调用。协调助手：到目前为止的目标、已定的事、进行中的任务、待用户决定的问题。' +
      '专业助手：这个项目的约定、常用命令、踩过的坑（换新会话时交给接手的会话）。',
    args: z.object({ summary: z.string().trim().min(1).max(8000).describe('摘要正文') }).strict(),
  },
  get_status: {
    roles: COORDINATOR,
    description: '列出最近的任务及其状态。',
    args: z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict(),
  },
  propose_plan: {
    roles: COORDINATOR,
    description:
      '把一个目标拆成带依赖的子任务计划，交给用户确认；确认前不会执行。没带 taskId 时新建任务；带 taskId 时给这个还在等确认的任务提新一版。',
    args: z
      .object({
        taskId: z.string().min(1).max(100).optional().describe('给已有的草稿任务提新一版时填写'),
        title: z.string().trim().min(1).max(80).describe('任务标题'),
        goal: z.string().trim().min(1).max(8000).describe('整个任务的目标'),
        nodes: z.array(PlanNodeInput).min(1).max(MAX_PLAN_NODES).describe(`子任务，最多 ${MAX_PLAN_NODES} 个`),
      })
      .strict(),
  },
  propose_commit: {
    roles: COORDINATOR,
    description:
      '用户说「提交」时用：提出一张提交卡片，只列这个对话发起的任务（或 taskId 指定的那个任务）还没提交的改动块，' +
      '每一行都能和助手的写入记录核对上的块默认勾选；用户在桌面上勾选、确认后由 PalDock 提交到当前分支。' +
      '用户说「只提交某个任务」时填 taskId；只有用户明确说要看整个项目的改动时才填 wholeProject。只在「当前工作区」方式的项目里可用。不要自己运行 git commit。',
    args: z
      .object({
        message: z.string().trim().min(1).max(2000).describe('提交说明'),
        taskId: z.string().min(1).max(100).optional().describe('只提交这个任务的改动（必须是这个对话发起的任务）'),
        wholeProject: z.boolean().optional().describe('用户明确要求看整个项目的改动时才填 true'),
      })
      .strict(),
  },
  propose_push: {
    roles: COORDINATOR,
    description:
      '用户说「推送」时用：提出一张推送卡片（实际推送地址、远端分支、要推的提交），用户确认后由 PalDock 推送预览时的那个提交，远端变了就作废，不强推。不要自己运行 git push。',
    args: z
      .object({
        remote: z.string().trim().min(1).max(100).optional().describe('远端名，缺省为当前分支的上游远端或 origin'),
        branch: z.string().trim().min(1).max(200).optional().describe('远端分支名，缺省为上游分支或同名分支'),
      })
      .strict(),
  },
  propose_merge: {
    roles: COORDINATOR,
    description: '用户说「合并」时用：提出一张本地合并卡片（源分支 → 目标分支），用户确认后由 PalDock 合并；冲突时不落地。不要自己运行 git merge。',
    args: z
      .object({
        source: z.string().trim().min(1).max(200).describe('源分支'),
        target: z.string().trim().min(1).max(200).describe('目标分支'),
      })
      .strict(),
  },
} as const;

export type McpToolName = keyof typeof MCP_TOOLS;
export type McpToolArgs<N extends McpToolName> = z.output<(typeof MCP_TOOLS)[N]['args']>;

export const isMcpTool = (name: string): name is McpToolName => Object.hasOwn(MCP_TOOLS, name);

/** 某个角色能看到的工具（MCP tools/list）。 */
export function mcpToolsFor(role: AgentRole): McpToolDefinition[] {
  return Object.entries(MCP_TOOLS)
    .filter(([, tool]) => tool.roles.includes(role))
    .map(([name, tool]) => ({ name, description: tool.description, inputSchema: z.toJSONSchema(tool.args, { io: 'input' }) as Record<string, unknown> }));
}
