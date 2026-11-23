import type { RiskLevel } from './states.js';

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
  cwd: string;
  prompt: string;
  /**
   * 要恢复的原生会话 ID；有值时只尝试恢复，失败即报错，不静默新建会话
   * （上下文和审批边界会因此改变）。是否改为新建由用户决定，新建时开新的 Run。
   */
  nativeSessionId?: string;
}

export interface RuntimeApprovalRequest {
  runId: string;
  /** 执行器侧的请求 ID，回复审批时原样带回。 */
  nativeRequestId: string;
  kind: 'command' | 'file_change' | 'permissions' | 'other';
  summary: string;
  cwd?: string;
  /** 由策略引擎判定，不采信执行器或模型自报。 */
  riskLevel?: RiskLevel;
}

export type RuntimeApprovalDecision = 'allow_once' | 'allow_for_session' | 'deny' | 'cancel';

export type RuntimeEvent =
  | { type: 'session'; runId: string; nativeSessionId: string }
  | { type: 'output_delta'; runId: string; text: string }
  | { type: 'approval_request'; request: RuntimeApprovalRequest }
  | { type: 'completed'; runId: string }
  | { type: 'failed'; runId: string; message: string }
  | { type: 'interrupted'; runId: string }
  | { type: 'disconnected'; runId: string };

export interface RuntimeAdapter {
  readonly name: string;
  discover(): Promise<RuntimeDiscovery>;
  start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void): Promise<void>;
  cancel(runId: string): Promise<void>;
  respondApproval(request: RuntimeApprovalRequest, decision: RuntimeApprovalDecision): Promise<void>;
  dispose(): Promise<void>;
}
