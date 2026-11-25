import { z } from 'zod';
import type { AgentRole, Executor, SubtaskStatus } from './states.js';
import { CheckCommand, type RunDetail, type RunResultRecord, type RunReviewRecord, type SubtaskRecord, type TaskActions } from './records.js';

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
    check: CheckCommand.optional().describe('交付后在 worktree 里跑的检查命令（可执行文件 + 参数，不经 shell）；随计划一起由用户确认'),
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
  checkCommand: CheckCommand | null;
  /** 确认前可改；null 表示按角色在项目里的执行器。 */
  executor: Executor | null;
}

/** 确认前对计划节点的一处修改。 */
export type PlanNodeEdit =
  | { kind: 'executor'; nodeKey: string; executor: Executor | null }
  | { kind: 'check'; nodeKey: string; check: CheckCommand | null }
  | { kind: 'remove'; nodeKey: string };

/**
 * 项目的自动处理设置（默认全关，只在桌面改）。没有「跳过计划确认」：P3 的每个计划都要用户确认
 * （2026-11-25 用户确定，替代 11-20「简单任务可跳过确认」的说法）。
 */
export interface AutoPolicy {
  /** 这些角色的节点交付在范围内且检查通过后不送审阅，直接合并。 */
  skipReviewRoles: AgentRole[];
}

/**
 * 没经过用户的决定：跳过审阅、审阅助手放行 / 退回、任务事件唤醒被跳过、唤醒因请求上限被中断；
 * auto_approve（按远程审批等级自动批准）P3 还没有，先留着。
 */
export const AUTO_DECISION_KINDS = ['skip_review', 'review_passed', 'review_rework', 'wake_dropped', 'wake_aborted', 'auto_approve'] as const;
export const AutoDecisionKind = z.enum(AUTO_DECISION_KINDS);
export type AutoDecisionKind = z.infer<typeof AutoDecisionKind>;

/** 没经过用户的一个决定（自动处理记录单的一行）。 */
export interface AutoDecisionRecord {
  id: number;
  workspaceId: string;
  taskId: string;
  planId: string | null;
  subtaskId: string | null;
  kind: AutoDecisionKind;
  reason: string;
  createdAt: string;
}

/** 子任务在 review 内的闸门阶段：审阅中、交给人；null 表示刚交付或不在 review。 */
export const GATE_STAGES = ['review', 'human'] as const;
export const GateStage = z.enum(GATE_STAGES);
export type GateStage = z.infer<typeof GateStage>;

/** 重启恢复的类别。 */
export const RECOVERY_KINDS = ['run', 'queued', 'review', 'merge', 'wake', 'notice', 'schedule'] as const;
export const RecoveryKind = z.enum(RECOVERY_KINDS);
export type RecoveryKind = z.infer<typeof RecoveryKind>;

/** 这次启动恢复的一项（桌面「待我处理」顶部列出）。 */
export interface RecoveryItem {
  kind: RecoveryKind;
  /** 子任务、合并操作、会话等的 ID。 */
  targetId: string;
  outcome: string;
  detail: string | null;
  at: string;
}

export const MERGE_PHASES = ['started', 'candidate', 'done', 'conflict', 'check_failed'] as const;
export const MergePhase = z.enum(MERGE_PHASES);
export type MergePhase = z.infer<typeof MergePhase>;

/** 把一个节点合进任务集成分支的一次操作（先写后做，重启时据此恢复）。 */
export interface MergeOpRecord {
  id: string;
  taskId: string;
  subtaskId: string;
  sourceSha: string;
  targetOld: string;
  candidateSha: string | null;
  phase: MergePhase;
  conflictFiles: string[] | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 节点最近一次交付的闸门情况：检查（SHA、检查结果、越界文件）和各轮审阅结论。 */
export interface NodeGateView {
  result: RunResultRecord | null;
  reviews: RunReviewRecord[];
}

/** 任务详情里的一个计划节点：确认后带上物化出的子任务和它当前允许的操作。 */
export interface PlanNodeView {
  node: PlanNodeRecord;
  subtask: SubtaskRecord | null;
  actions: TaskActions | null;
  gate: NodeGateView | null;
  /** 最近一次合并进集成分支的操作；冲突时桌面据此给出「交回重做」和「重试合并」。 */
  merge: MergeOpRecord | null;
  /** 这个节点实际会用的执行器（节点上指定的，否则按角色设置）。 */
  executor: string;
  /** 这个节点的各次 Run（工作与审阅），按 attempt 升序；不含输出正文。 */
  runs: RunDetail[];
}

export interface PlanDetail {
  plan: PlanRecord;
  nodes: PlanNodeView[];
  /** edit：计划还在等确认时可以改执行器、检查命令或删节点。 */
  actions: { confirm: boolean; reject: boolean; edit: boolean };
  /** 当前在执行的那一版（这一版是运行中提出的新一版时才和 plan 不同）。 */
  confirmedRevision: number | null;
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
