import { z } from 'zod';
import type { MessageRecord } from './records.js';

/**
 * 协调助手主会话（P3-07）：每个项目一个或多个，消息持久化；唤醒循环把你的消息和任务事件变成一次次 Run。
 */

export const TASK_KINDS = ['work', 'conversation'] as const;
export const TaskKind = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKind>;

export const WAKE_TRIGGERS = ['user_message', 'task_event'] as const;
export const WakeTrigger = z.enum(WAKE_TRIGGERS);
export type WakeTrigger = z.infer<typeof WakeTrigger>;

export const WAKE_STATUSES = ['pending', 'running', 'done', 'failed', 'dropped'] as const;
export const WakeStatus = z.enum(WAKE_STATUSES);
export type WakeStatus = z.infer<typeof WakeStatus>;

export const NOTICE_KINDS = ['info', 'question'] as const;
export const NoticeKind = z.enum(NOTICE_KINDS);
export type NoticeKind = z.infer<typeof NoticeKind>;

/** 一个主会话：会话 ID 是对外的标识；对话任务和协调助手子任务是 Run 的载体。 */
export interface MainSessionRecord {
  sessionId: string;
  taskId: string;
  subtaskId: string;
  workspaceId: string;
  title: string;
  createdAt: string;
}

export interface WakeRecord {
  id: number;
  sessionId: string;
  trigger: WakeTrigger;
  summary: string;
  status: WakeStatus;
  runId: string | null;
  /** 这次唤醒里协调助手调用 MCP 工具的次数（模型请求次数的近似）。 */
  requests: number;
  note: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** 协调助手发给你的通知；编号（Q + id）就是问题编号，外部回复时带上它。 */
export interface NoticeRecord {
  id: number;
  sessionId: string;
  runId: string | null;
  kind: NoticeKind;
  body: string;
  status: 'open' | 'read';
  escalatedAt: string | null;
  createdAt: string;
}

export const noticeRef = (id: number) => `Q${id}`;

/** 滚动摘要（每会话带版本号）。 */
export interface SummaryRecord {
  sessionId: string;
  version: number;
  body: string;
  runId: string | null;
  wakesDone: number;
  createdAt: string;
}

export interface ConversationDetail {
  session: MainSessionRecord;
  /** 最近的消息，按时间升序。 */
  messages: MessageRecord[];
  notices: NoticeRecord[];
  /** 最近几次唤醒，新的在前。 */
  wakes: WakeRecord[];
  summary: SummaryRecord | null;
}
