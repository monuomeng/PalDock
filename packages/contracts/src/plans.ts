import { z } from 'zod';
import type { AgentRole, SubtaskStatus } from './states.js';
import type { SubtaskRecord, TaskActions } from './records.js';

/** 一份计划最多几个节点（02「上限与护栏」：每任务最多 8 个子任务）；domain 校验与 MCP 参数共用。 */
export const MAX_PLAN_NODES = 8;

/** 节点键：小写字母开头，用于依赖引用、worktree 目录和分支名。 */
export const NODE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/** 协调助手提出的一个计划节点；校验（角色、无环、路径）在 domain 的 validatePlan。 */
export const PlanNodeInput = z
  .object({
    key: z.string().regex(NODE_KEY_PATTERN, '节点键只能用小写字母、数字和连字符，且以字母开头（最多 24 个字符）').describe('节点键，例如 dev、test'),
    role: z.string().min(1).max(32).describe('专业助手角色：developer、tester、reviewer、docs、researcher'),
    title: z.string().trim().min(1).max(80).describe('一句话标题'),
    goal: z.string().trim().min(1).max(4000).describe('这个子任务要做什么、做到什么程度算完成'),
    paths: z.array(z.string().min(1).max(200)).max(20).default([]).describe('相关的文件或目录（项目内相对路径）'),
    dependsOn: z.array(z.string().min(1).max(24)).max(MAX_PLAN_NODES).default([]).describe('依赖的节点键；依赖都完成后才开始'),
  })
  .strict();
export type PlanNodeInput = z.output<typeof PlanNodeInput>;

export const PLAN_STATUSES = ['proposed', 'confirmed', 'rejected', 'superseded'] as const;
export const PlanStatus = z.enum(PLAN_STATUSES);
export type PlanStatus = z.infer<typeof PlanStatus>;

export interface PlanRecord {
  id: string;
  taskId: string;
  /** 第几版（任务内从 1 递增）。 */
  revision: number;
  status: PlanStatus;
  proposedByRunId: string | null;
  /** 退回或作废的原因。 */
  decisionNote: string | null;
  /** 乐观锁，确认 / 退回都带它。 */
  version: number;
  createdAt: string;
  decidedAt: string | null;
}

export interface PlanNodeRecord {
  planId: string;
  position: number;
  key: string;
  role: AgentRole | string;
  title: string;
  goal: string;
  paths: string[];
  dependsOn: string[];
}

/** 任务详情里的一个计划节点：确认后带上物化出的子任务和它当前允许的操作。 */
export interface PlanNodeView {
  node: PlanNodeRecord;
  subtask: SubtaskRecord | null;
  actions: TaskActions | null;
}

export interface PlanDetail {
  plan: PlanRecord;
  nodes: PlanNodeView[];
  actions: { confirm: boolean; reject: boolean };
}

/** 调度器读的任务图：子任务及其依赖（子任务 ID）。 */
export interface GraphNode {
  id: string;
  title: string;
  status: SubtaskStatus;
  statusReason: string | null;
  version: number;
  dependsOn: string[];
}
