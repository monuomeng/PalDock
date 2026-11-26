import type { Change } from './storage.js';

/**
 * 协调助手在发起的对话里找你批（2026-11-26 你同意，0.3.8）：「正在问你的问题」。
 * 每个对话同一时刻只有一个；问题没解决时新事项排在后面。宿主把问题绑定到来源会话、各项的编号和版本，
 * 文字回复、按钮、外部渠道的重投共用同一次决定。
 */

/** 问题里的一项：一条审批，或一张 Git 卡片。 */
export interface QuestionItem {
  /** 审批编号或 Git 卡片编号。 */
  ref: string;
  kind: 'approval' | 'gitop';
  /** 提出问题时这一项的版本（执行时核对，先到者为准）。 */
  version: number;
  /** 建议的决定：审批 allow / deny；Git 卡片 confirm / cancel。 */
  decision: 'allow' | 'deny' | 'confirm' | 'cancel';
  /** 提交卡片：要提交的改动块（你看到的那些）；只提交它们，不退回默认勾选。 */
  hunkIds?: string[];
  /** 一行说明（工具和目标），用于按钮和记录。 */
  label: string;
  /** 高影响操作的目标（推送：提交和远端分支；合并：源和目标；敏感读取：路径）；问题原文里必须写明。 */
  target: string | null;
  /** 推送、合并、敏感路径的读取、项目外写入、其余权限扩展。 */
  highImpact: boolean;
  /** 敏感路径：外部渠道只提示到电脑上确认，不写路径、不能在外部批。 */
  sensitive: boolean;
}

export type QuestionStatus = 'open' | 'replaced' | 'done' | 'void';
/** desktop：桌面对话；pending / sent / failed：外部会话里投递中、已送达、投递失败。 */
export type QuestionDelivery = 'desktop' | 'pending' | 'sent' | 'failed';

export interface QuestionRecord {
  id: string;
  sessionId: string;
  /** 登记问题的协调助手 Run；宿主代发的为 null。 */
  runId: string | null;
  /** 问题那条消息（对话里显示、按钮挂在它下面）。 */
  messageId: number | null;
  author: 'coordinator' | 'host';
  text: string;
  items: QuestionItem[];
  status: QuestionStatus;
  delivery: QuestionDelivery;
  /** 桌面对话的问题，你不在电脑前时外发提醒的时间。 */
  escalatedAt: string | null;
  /** 怎么结束的（已执行哪些、为什么作废）。 */
  result: string | null;
  version: number;
  createdAt: string;
  closedAt: string | null;
}

export interface QuestionStorePort {
  /** 登记问题；同一事务把问题里的审批标上 question_id。 */
  create(input: Omit<QuestionRecord, 'id' | 'status' | 'escalatedAt' | 'result' | 'version' | 'createdAt' | 'closedAt'>): Change<QuestionRecord>;
  get(id: string): QuestionRecord | undefined;
  /** 这个会话里正在问的问题。 */
  openOf(sessionId: string): QuestionRecord | undefined;
  byMessage(messageId: number): QuestionRecord | undefined;
  ofSession(sessionId: string, limit: number): QuestionRecord[];
  /** 还开着的问题（全部会话）。 */
  allOpen(): QuestionRecord[];
  /** 结束问题（带版本，先到者为准）；同一事务清掉没有执行的审批上的 question_id（它们回到队列）。 */
  close(id: string, expectedVersion: number, status: Exclude<QuestionStatus, 'open'>, result: string | null, decidedRefs: readonly string[]): Change<QuestionRecord>;
  setDelivery(id: string, delivery: QuestionDelivery): void;
  markEscalated(id: string): boolean;
}
