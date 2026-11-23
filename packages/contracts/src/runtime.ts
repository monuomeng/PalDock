/**
 * 执行器适配器契约。供应商差异（Codex JSON-RPC、Claude stream-json）在适配器内转换，
 * 应用层只看这里的类型。
 */

/**
 * 执行器显式报告的能力。派单前按角色需要逐项检查，缺失则拒绝启动并提示，
 * 不伪装成功（02「适配器契约」）。
 */
export interface RuntimeCapabilities {
  resume: boolean;
  streaming: boolean;
  approvals: boolean;
  cancel: boolean;
  workingDirectoryRestriction: boolean;
  attachments: boolean;
}

export interface RuntimeDiscovery {
  runtime: string;
  available: boolean;
  version?: string;
  /** 不可用时的原因，例如未安装、未登录。 */
  reason?: string;
  capabilities: RuntimeCapabilities;
}

export interface RunStartRequest {
  runId: string;
  /** 已规范化的工作目录（worktree）；执行器的写入限制在这里。 */
  cwd: string;
  prompt: string;
  /**
   * 要续做的原生会话 ID；有值时只尝试恢复，失败即报错，不静默新建会话
   * （上下文和审批边界会因此改变）。是否改为新建由用户决定，新建时开新的 Run。
   */
  resumeThreadId?: string;
}

export interface RuntimeApprovalRequest {
  /** 执行器侧的请求 ID，回复审批时原样带回。 */
  nativeRequestId: string;
  kind: 'command' | 'file_change' | 'permissions';
  /** 一行摘要，例如命令本身或「修改 3 个文件」。 */
  summary: string;
  /** 展示用的细节：完整命令、文件列表、请求的权限。 */
  detail?: string;
  cwd?: string;
  /** 文件改动涉及的路径（file_change），供策略引擎判断是否在 worktree 内。 */
  paths?: string[];
  command?: string;
  /** 执行器给出的理由，仅供展示，不参与风险判定。 */
  reason?: string;
}

/** 「本会话允许」P1 不开放；`cancel` 用于审批过期、任务取消或 Run 结束时收尾。 */
export type RuntimeApprovalDecision = 'allow_once' | 'deny' | 'cancel';

export type RuntimeEvent =
  | { type: 'thread'; threadId: string }
  /** turn/start 的响应里就有 turn ID，先于 turn/started 通知送达，便于尽早记录。 */
  | { type: 'turn'; turnId: string }
  | { type: 'output_delta'; text: string }
  | { type: 'approval_request'; request: RuntimeApprovalRequest }
  /** 执行器自己收回了挂起的请求（例如 turn 已结束），对应的审批应取消。 */
  | { type: 'approval_withdrawn'; nativeRequestId: string }
  /** 执行器发来未识别的请求，适配器已回复错误（等同拒绝），只需记录。 */
  | { type: 'notice'; code: 'unknown_request'; detail: string }
  | { type: 'completed'; finalMessage: string | null }
  | { type: 'failed'; message: string }
  | { type: 'interrupted' }
  /** 与执行器的连接意外断开：结果未知，交给应用层核对。 */
  | { type: 'disconnected'; message: string };

/** 一次 Run 的控制句柄。事件经 start 时传入的回调按顺序送达。 */
export interface RuntimeRun {
  /** 取消：turn 已开始则中断，否则等到开始或超时后结束进程树。 */
  cancel(): Promise<void>;
  respondApproval(nativeRequestId: string, decision: RuntimeApprovalDecision): void;
  /** 结束执行器进程（整个进程树）。 */
  dispose(): Promise<void>;
}

/** 核对某个 turn 的结果：只认这个 turn，不拿同一 thread 里别的 turn 顶替。 */
export type TurnCheck =
  | { status: 'completed'; finalMessage: string | null }
  | { status: 'failed'; message: string }
  | { status: 'interrupted' }
  | { status: 'in_progress' }
  | { status: 'not_found' };

export interface RuntimeAdapter {
  readonly name: string;
  discover(): Promise<RuntimeDiscovery>;
  /** 启动失败（找不到执行器、恢复失败）时拒绝 Promise，不发事件。 */
  start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void): Promise<RuntimeRun>;
  checkTurn(threadId: string, turnId: string): Promise<TurnCheck>;
}
