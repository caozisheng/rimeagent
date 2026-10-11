# rimeagent 设计式样：长程能力（Durable Agent Runtime）实施计划

> **Status**: Accepted — 2026-10-08 · Rev3 2026-10-11（排期重排：VercelAIBackend 前置 Phase 1；runner 顺延 Phase 2–6；NativeLLMBackend 移出排期转附录 C）
> **基线**: rimeagent `v0.1.0` @ `f30d9cb`（17 文件 / 1,398 行，源码核对）
> **实施进度（2026-10-11）**：Phase 0 + Phase 1 引擎侧已实施，包版本准备为 `0.3.0`（未发布、未打 tag）。`bun test` 100 项通过，`bun run typecheck` 与 `npm run build` 通过；本地真实 HTTP/SSE 冒烟覆盖基线及 AI SDK 5.0.273 / 6.0.303 / 7.0.137 的文本、工具调用、usage，额外验证提前关闭 generator 取消 HTTP 响应和截断工具参数返回 tool_failure。隔离环境未安装 `ai` 时核心编译、包主入口 import 与浏览器 bundle 通过。Phase 2–8 未实施；NativeLLMBackend 明确不做。宿主 re-pin 与真实编辑任务验收未执行。
> **上游决策**:
> - `rimecut-public/docs/rimecut-feature-dev-rimeagent-design.md` §12（Durable Agent Runtime 决策版，2026-10-08）
> - `rimecut-public/docs/rimecut-cli-for-agent.md` v3（§D5/D6：内置 agent 快路径、harness 方法、parity 已验收项）
> - rimecut 宿主侧 agent harness 替换评估（2026-10-11）：GPL-3 harness（tinyagents）与「整层替换 / 工具回调往返」方案均否决；rig-core 原生方案收缩为 **LLMBackend 传输适配器**（本仓 §5.11 / D12；Rust crate 归 rimecut 仓持有）。槽位决策（Rev2）：内置双 backend 归并为 **RimeAgentBackend**（web/tauri 同一套基线）。Rev3 排期（2026-10-11）：VercelAIBackend 前置为 Phase 1，runner（原 Phase 1–4）顺延为 Phase 2–6，NativeLLMBackend 移出排期（附录 C 条件触发）
>
> **决策**: 不迁移到 Pi、LangGraph、Mastra 或 OpenChatCut Runner。以当前 rimeagent 为基础演进为 Web/Tauri/rimecraft 共用的 Durable Agent Runtime；传输层可由宿主以原生 backend 增强（§5.11），但循环、持久化、审批语义唯一归属本 runtime。本文档是引擎仓侧的设计式样与实施计划；宿主（RimeCut）侧的集成与人力预算见上游文档 §12.9–12.10，本文不复制。

---

## 目录

1. 文档定位
2. 现状基线与长程缺口
3. 目标、非目标与硬约束
4. 目标架构
5. 核心契约
6. 关键设计决策
7. 实施计划（Phase 0–7）
8. 验收与质量门禁
9. 风险与缓解
10. 与上游文档的可追溯映射
- 附录 A：`index.ts` 导出增量
- 附录 B：规模与依赖预算

---

## 1. 文档定位

本文回答一个问题：**rimeagent 从一个 1.4K 行的无状态 engine，如何演进为承载小时级、可中断、可恢复的长程视频剪辑任务的 Durable Agent Runtime。**

读者假设：熟悉 TypeScript async generator 与 OpenAI function-calling，不知道 RimeCut 领域。宿主上下文（RimeCut 的 33 tools / 13 skills / RAG / ProjectCommand）只在必要处摘要，详见上游文档。

rimeagent 当前唯一消费者是 RimeCut（`github:caozisheng/rimeagent#5898430` pin commit，全仓 66 处 import）；rimecraft 计划后续接入。所有 Phase 的兼容承诺以 RimeCut 现有消费面（§2.1 列出）为基线。

---

## 2. 现状基线与长程缺口

### 2.1 现有模块（源码核对 @ f30d9cb）

| 模块 | 符号 | 职责 | 长程相关性 |
|---|---|---|---|
| `types.ts` | `AgentMessage` / `AgentEvent` / `TokenUsage` / `AgentLLMConfig` | 消息、流式事件、用量 | 事件无版本、无 runId；usage 无 cost/cache |
| `tool-types.ts` | `AgentTool` / `AgentToolResult` | 工具接口 | 仅有 `requiresConfirmation?: boolean`，无并发/幂等/破坏性元数据 |
| `tool-registry.ts` | `createToolRegistry()` / `executeToolCall()` | 注册 + 执行兜底（JSON 解析失败 / 未知工具 / execute 抛错三类统一返回 `{success:false}`） | 执行无策略：顺序、无审批、无 ledger |
| `skills.ts` / `expert-roles.ts` / `prompt-builder.ts` | `SkillRegistry` / `ExpertRoleRegistry` / `buildSystemPrompt()` | 领域注册表 + P0–P50 分层 prompt | **保持不变**，runtime 直接复用 |
| `service.ts` | `runAgentLoop()` | 单轮：buildSystemPrompt → `streamChatCompletion` → yield 事件 | 引擎不执行工具（`tool_calls_complete` 通知宿主）——此边界保留 |
| `session.ts` | `runAgentSession()` | 多轮循环：`allMessages = [...params.messages]` 纯内存，失败注入 ragContext，`maxIterations` 上限 | **长程缺口主所在**（见 2.2） |
| `llm-backend.ts` / `anthropic-*.ts` / `llm-client.ts` | `LLMBackend` / `CloudLLMBackend` / `AnthropicLLMBackend` / `streamChatCompletion()` | provider 路由 + SSE 解析 | 错误未归一为类别；`registerLLMBackend` 为单槽（最后注册者胜）——多 backend 并存前必须多槽化（任务 0.4）；Phase 1 归并导出 `RimeAgentBackend`（内部保留 OpenAI-compat / Anthropic 两线，任务 1.3 / D13） |
| `mcp.ts` | `MCPRegistry` | 预留扩展点 | 未激活 |
| `rag-types.ts` | `RagBuilder` / `ErrorRecoveryBuilder` | RAG 契约 | 迁移为 ContextManager hook（§5.7） |

RimeCut 宿主现状（上游文档 §3.3/§9）：`agent-store` **直接消费底层 `runAgentLoop`**（未用 `runAgentSession`），自己维护迭代循环、`MAX_TOOL_ITERATIONS=10/20`、`MAX_SERIALIZED_TURNS=50` 硬截断、命令 checkpoint（`editor.command.historyLength`）。`runAgentSession` 是引擎侧已提供的雏形，Phase 1 将以它为骨架下沉为 `AgentRuntime`。

### 2.2 长程缺口（逐条源码证据）

| # | 缺口 | 现状证据 | 长程后果 |
|---|---|---|---|
| G1 | 无持久化 session | `session.ts:56` messages 只在内存；宿主序列化最近 50 turn 到 project 文件 | 刷新/崩溃即丢；50 turn 后早期任务事实消失 |
| G2 | 硬截断而非 token budget | 宿主 `messages.slice(-MAX_SERIALIZED_TURNS)` | 长任务中期上下文质量不可控；overflow 直接报错 |
| G3 | checkpoint 边界混乱 | 宿主命令 checkpoint（undo 链长度）是唯一"存档点"；Agent context 与 ProjectDocument revision 无关联结构 | 无法安全回滚到"第 N 步之前"并继续跑 |
| G4 | 错误处理散落 | `session.ts:164-166` error 事件直接 return；无重试、无类别、无恢复 | provider 抖动 = 任务死亡；恢复时可能重复非幂等命令 |
| G5 | 无审批生命周期 | `tool-types.ts:20` `requiresConfirmation` 只是个标志，宿主自行解释 | 刷新后等待确认的任务丢失或重复执行 |
| G6 | 无 run ledger / 可观测性 | `TokenUsage` 只有三个 token 数；无 runId/revision/commandId 关联 | 无法做成本统计、恢复决策、parity 审计 |

---

## 3. 目标、非目标与硬约束

### 3.1 目标：长程最小闭环

```text
读取项目 → 制定编辑步骤 → 调用工具 → 验证结果 → 修正失败
    → 生成/预览 → 用户确认 → 应用/导出 → 可恢复地继续
```

第一阶段的成功标准（上游 §12.13）：**一个被取消、刷新或 context overflow 打断的长程视频剪辑任务，可以安全、可解释、无重复副作用地继续执行。** 不是新增 provider，不是跑更多轮 LLM。

### 3.2 非目标

- 不替换 RimeCut 的领域工具（33+5）、Skills（13+2）、Expert Roles（7）、RAG（7 JSON）——runtime 是它们的承载者，不是所有者；
- 不引入 Pi / LangGraph / Mastra / OpenChatCut Runner；
- 不在 rimeagent 内实现项目存储——`ProjectDocument` / `ProjectCommand` / EditorCore / HeadlessRuntime 全部留在宿主；
- 不做媒体管线（解码/合成/导出）——那是 rimecut-cli / SDK crate 的领地（CLI 文档 §2）。
- 不在原生侧引入第二 agent 循环/执行器——Rust 传输 crate（宿主持有）只做模型调用与事件透传，工具执行、迭代、审批、checkpoint 唯一归属本 runtime（§5.11 / D12）。

### 3.3 硬约束

1. **宿主无关**：runtime 核心不得依赖 React、Zustand、DOM、EditorCore、Tauri API 或任何具体数据库。能力经接口注入（store、clock、tokenizer、artifact、approval）。`shouldUseDirect()` 里现有的 `window` 探测是 backend 层既有例外，runtime 层零新增。
2. **AGPL clean-room**：OpenChatCut Runner 只作行为与模块边界参考（它有 ApiAgentRunner、compaction、ledger、approval、recovery 的完整先例），不复制源码、不静态依赖；发布前做依赖与源码审计。
3. **许可与依赖预算**：MIT 保持；runtime 依赖维持 `nanoid` 一个（tokenizer / IndexedDB / Vercel AI SDK 全部走注入或可选子路径导出，见 §4.3）。
4. **消费面兼容**：`runAgentLoop` / `runAgentSession` / 全部现有导出在 1.0.0 前不删不改语义；RimeCut 按 Phase 逐个 pin commit 切换，不允许 big-bang。
5. **原生传输边界**：`./backends/native` 只实现 `LLMBackend` 并遵守 §5.11 wire 契约与硬边界；主入口零 Tauri 依赖（peer 注入），错误/usage 映射到本仓冻结类型，不自带重试、循环或事件协议。

---

## 4. 目标架构

### 4.1 模块图

```text
宿主（RimeCut Web / Tauri / rimecraft）
  ├── 领域 adapter（保持现状）
  │   ├── 33+5 tools（补 annotations）→ ToolRegistry
  │   ├── 13+2 skills / 7 roles / RAG builders
  │   ├── ProjectDocument / ProjectCommand / EditorCore / HeadlessRuntime
  │   └── storage adapter（IndexedDB / SQLite / file）· approval UI · tokenizer
  │
  └── rimeagent Durable Agent Runtime            ← 本仓交付物
      ├── AgentRuntime（run 生命周期 + RunController）
      ├── SessionStore / CheckpointStore / ArtifactStore（契约 + InMemory 实现）
      ├── ContextManager（token budget / compaction / overflow recovery）
      ├── ToolExecutor（annotations 策略：读并行 / 写串行）
      ├── ApprovalGate（suspend / resume / proposal）
      ├── RuntimeLedger（usage / revision / retry / 终态）
      ├── errors（四类归一）+ events（版本化事件 v2）
      ├── 现有不动：SkillRegistry / ExpertRoleRegistry / PromptBuilder
      └── LLMBackend（基线 RimeAgentBackend + 可选 Vercel / Native 槽位，见 §5.11）
```

### 4.2 目标 `src/` 结构（单文件 ≤400 行）

```text
src/
├── types.ts                  扩展：TokenUsage 增 cost/cache；AgentMessage 增 runId?
├── events.ts                 ★ AgentRuntimeEvent v2 + 版本协商
├── errors.ts                 ★ AgentErrorCategory 四类归一 + normalizeError()
├── tool-types.ts             扩展：AgentToolAnnotations（挂到 AgentTool.annotations）
├── prompt-builder.ts         不变
├── skills.ts / expert-roles.ts / mcp.ts   不变
├── service.ts / session.ts   兼容入口保留；内部逐步改为 AgentRuntime 的薄包装
├── runtime/
│   ├── runtime.ts            ★ AgentRuntime 工厂 + RunController（run 生命周期状态机）
│   ├── executor.ts           ★ ToolExecutor（并行/串行调度 + ledger 写入 + 重放保护）
│   ├── approval.ts           ★ ApprovalGate（preflight → allow/deny/suspend → resume）
│   ├── context-manager.ts    ★ token budget / cut point / compaction / overflow
│   └── ledger.ts             ★ RuntimeLedger 记录与查询
├── store/
│   ├── entries.ts            ★ AgentSessionEntry 判别联合 + 校验
│   ├── session-store.ts      ★ AgentSessionStore 契约 + InMemorySessionStore
│   ├── checkpoint.ts         ★ AgentCheckpoint / AgentCheckpointRef / branch
│   └── artifact-store.ts     ★ 大 tool result 的引用存取契约 + InMemory 实现
├── llm-backend.ts / anthropic-*.ts / llm-client.ts   现有；errors 接入归一；Phase 1 起归并导出 RimeAgentBackend（任务 1.3）
└── adapters/                 （可选子路径导出，不进主入口）
    ├── indexeddb.ts          ★ web: IndexedDB SessionStore/ArtifactStore
    ├── vercel.ts             ★ VercelAIBackend（peer: "ai"，永不进 dependencies）
    └── native.ts             ★ NativeLLMBackend（peer: "@tauri-apps/api"，§5.11 wire 契约）
```

### 4.3 导出与版本策略

`package.json` exports 增加子路径，主入口保持零平台 API：

```jsonc
{
  "exports": {
    ".":            { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./adapters/web":   { "import": "./dist/adapters/indexeddb.js" },   // 仅浏览器
    "./backends/vercel":{ "import": "./dist/adapters/vercel.js" },     // peer: ai
    "./backends/native":{ "import": "./dist/adapters/native.js" }     // peer: @tauri-apps/api
  }
}
```

版本节奏（0.x 阶段 minor 即允许破坏，但破坏只发生在新增面，不触碰兼容入口）：

| 版本 | Phase | 性质 |
|---|---|---|
| 0.2.0 | 0 | 传输前置（additive）：errors 归一 / TokenUsage 扩展 / backend 多槽化 |
| 0.3.0 | 1 | VercelAIBackend（可选子路径 `./backends/vercel`）+ RimeAgentBackend 归并 |
| 0.4.0 | 2 | runner 契约冻结：事件 v2 / entries / checkpoint / store / ledger / annotations |
| 0.5.0 | 3 | `createAgentRuntime()` 主入口；`runAgentLoop`/`runAgentSession` 变薄包装 |
| 0.6.0 | 4 | store 落盘 + ledger + interrupted-run resume（含 `./adapters/web`） |
| 0.7.0 | 5 | ContextManager + compaction + overflow recovery |
| 0.8.0 | 6 | ToolExecutor 策略 + ApprovalGate |
| 1.0.0 | 7+8 | CLI/MCP/parity + 评测；契约冻结承诺（semver 语义化开始） |

RimeCut 宿主每个 Phase 结束 pin 新 commit 切换一次（上游 §12.9 阶段验收即切换点）；pin 纪律与引擎仓 `dist/` release 要求见附录 D。

---

## 5. 核心契约

以下接口是 Phase 0 的冻结对象。命名与上游 §12.4 对齐，签名按本仓源码风格（`readonly`、判别联合、async generator）收敛。

### 5.1 Session entries 与 AgentSessionStore（对 G1）

```typescript
// store/entries.ts
export type AgentSessionEntry =
  | { kind: "user_message";        id: string; ts: number; content: string }
  | { kind: "assistant_message";   id: string; ts: number; content: string; toolCalls?: ToolCall[]; usage?: TokenUsage }
  | { kind: "tool_call";           id: string; ts: number; toolCallId: string; name: string; argsDigest: string }
  | { kind: "tool_result";         id: string; ts: number; toolCallId: string; result: AgentToolResult; artifactId?: string }
  | { kind: "approval_requested";  id: string; ts: number; toolCallId: string; reason: string }
  | { kind: "approval_resolved";   id: string; ts: number; toolCallId: string; decision: "allow" | "deny"; by: "user" | "policy" }
  | { kind: "compaction";          id: string; ts: number; summary: string; compactedEntryIds: string[]; projectDigest: ProjectFactsDigest }
  | { kind: "checkpoint";          id: string; ts: number; checkpointId: string; projectRevision?: number }
  | { kind: "branch";              id: string; ts: number; fromCheckpointId: string; branchId: string }
  | { kind: "run_started";         id: string; ts: number; runId: string; parentRunId?: string }
  | { kind: "run_interrupted";     id: string; ts: number; runId: string; cause: AgentErrorCategory; lastDurableBoundary?: string }
  | { kind: "run_awaiting_approval"; id: string; ts: number; runId: string; toolCallId: string }
  | { kind: "run_completed";       id: string; ts: number; runId: string }
  | { kind: "run_failed";          id: string; ts: number; runId: string; error: NormalizedError }
  | { kind: "error";               id: string; ts: number; error: NormalizedError }
  | { kind: "usage";               id: string; ts: number; runId: string; usage: TokenUsage };

// store/session-store.ts
export interface AgentSessionStore {
  load(sessionId: string): Promise<AgentSessionSnapshot | null>;
  append(sessionId: string, entry: AgentSessionEntry): Promise<void>;   // append-only
  saveCheckpoint(checkpoint: AgentCheckpoint): Promise<void>;
  listCheckpoints(sessionId: string): Promise<AgentCheckpoint[]>;
}
```

规则：**只追加，不修改**。"模型可见 messages" 是 entries 的投影（projection），由 ContextManager（§5.7）生成——这使 compaction 可以只改投影而不篡改历史。存储实现由宿主注入（Web 默认 `./adapters/web` 的 IndexedDB；Tauri SQLite/file；服务端任意），核心只带 InMemory 实现用于测试。

### 5.2 Checkpoint 与 branch（对 G3）

```typescript
// store/checkpoint.ts
export interface AgentCheckpoint {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly parentId?: string;             // 链成树 → branch
  readonly createdAt: number;
  readonly entrySeq: number;              // append 到第几条时的快照边界
  readonly contextDigest: string;         // 投影内容的 hash，恢复时校验
}

export interface AgentCheckpointRef {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly projectId?: string;
  readonly projectRevision?: number;      // 恢复前必须校验（不变量 3）
  readonly projectCheckpointId?: string;  // 宿主 project.checkpoint 的 ID（CLI 文档 §8.2）
  readonly contextDigest: string;
}
```

与 ProjectDocument 的边界不变量（上游 §12.3.1，逐字继承）：

1. Agent branch **不得自动回滚** ProjectDocument；
2. 项目回滚只能通过明确的 `project.restore` 领域操作（宿主工具）；
3. 恢复 Agent run 前必须验证项目 revision 匹配 `AgentCheckpointRef.projectRevision`；
4. stale revision 不得静默覆盖——mismatch 返回结构化错误，由用户/宿主决策；
5. 每次写工具都记录 project revision before/after 和 commandId（ledger，§5.8）；
6. context compaction 不得把摘要当成 ProjectDocument 的事实来源（§5.7）。

### 5.3 事件 v2（对 G6 部分）

现有 `AgentEvent`（`types.ts:62-67`）保持不动。runtime 事件是外层信封：

```typescript
// events.ts
export const AGENT_RUNTIME_EVENT_VERSION = 2;

export interface AgentRuntimeEventEnvelope<T = unknown> {
  readonly v: 2;
  readonly runId: string;
  readonly seq: number;        // 每 run 单调递增，持久化边界
  readonly ts: number;
  readonly type: string;       // 判别键
  readonly payload: T;
}

export type AgentRuntimeEvent =
  | AgentRuntimeEventEnvelope<{ kind: "run_started" | "run_resumed"; sessionId: string }>
  | AgentRuntimeEventEnvelope<{ kind: "run_interrupted"; cause: AgentErrorCategory }>
  | AgentRuntimeEventEnvelope<{ kind: "run_awaiting_approval"; toolCallId: string }>
  | AgentRuntimeEventEnvelope<{ kind: "run_completed" }>
  | AgentRuntimeEventEnvelope<{ kind: "run_failed"; error: NormalizedError }>
  | AgentRuntimeEventEnvelope<{ kind: "iteration_start" | "iteration_end"; iteration: number }>
  | AgentRuntimeEventEnvelope<AgentEvent>                       // 透传 text_delta / tool_calls_complete / message_end / status
  | AgentRuntimeEventEnvelope<{ kind: "tool_result"; toolCall: ToolCall; result: AgentToolResult }>
  | AgentRuntimeEventEnvelope<{ kind: "compaction_completed"; droppedEntries: number; summaryDigest: string }>
  | AgentRuntimeEventEnvelope<{ kind: "role_switch"; roleId: string }>;
```

消费规则：宿主按 `v` 与 `type` 判别；**未知 `type` 必须安全忽略**（向前兼容的门禁测试项）。`seq` 是持久化对齐键——ledger 与 store 落盘以 `seq` 为界，中断恢复从最大 `seq` 继续。

### 5.4 AgentRuntime 与 RunController（对 G1/G4 主体）

```typescript
// runtime/runtime.ts
export interface AgentRuntimeConfig {
  readonly sessionId: string;
  readonly llmConfig: AgentLLMConfig;
  readonly expertRoleId: string;
  readonly sessionStore: AgentSessionStore;
  readonly artifactStore: AgentArtifactStore;
  readonly context: ContextManagerConfig;          // §5.7
  readonly tools: readonly AgentTool[];            // 带 annotations
  readonly executor?: ToolExecutorConfig;          // §5.5，缺省全串行
  readonly approval?: ApprovalGate;                // §5.6，缺省 auto-allow 只读
  readonly maxIterations?: number;                 // 缺省 10；orchestrator 20 由宿主传
  readonly identityPrompt?: string;
  readonly workRules?: string;
  readonly customLayers?: PromptLayer[];
  readonly locale?: "zh" | "en";
  readonly hooks?: {
    readonly buildDynamicContext?: () => string | null;      // 宿主 timeline 快照（P30）
    readonly buildRagContext?: RagBuilder;                   // 迁移自 runAgentLoop 参数（§5.7）
    readonly buildErrorRecovery?: ErrorRecoveryBuilder;
    readonly onRoleSwitch?: (roleId: string) => AgentLLMConfig | void;
    readonly getProjectFacts?: () => ProjectFactsDigest;     // compaction 反事实注入源
  };
}

export interface AgentRuntime {
  run(userMessage: string, signal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent>;
  resume(runId: string, signal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent>;   // 中断/审批后恢复
  resolveApproval(toolCallId: string, decision: "allow" | "deny"): Promise<void>;
  checkpoint(label?: string): Promise<AgentCheckpointRef>;
  abort(reason?: string): void;
}

export function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime;
```

run 生命周期（上游 §12.4.2 逐字落地）：

```text
create run → load session/checkpoint → prepare context（投影 + hooks）
  → request model → stream assistant output → validate and execute tools
  → approval suspend/resume when required
  → append results and project revision refs
  → compact or recover overflow when required
  → checkpoint durable boundary → continue or settle
```

`agent-store` 只保留宿主状态与 UI 绑定；`session.ts:59-173` 的隐式迭代状态机整体下沉到这里，`runAgentSession` 改为 `AgentRuntime` 的兼容薄包装（同样的 `AgentSessionEvent` 输出形状）。

### 5.5 Tool annotations 与执行策略（对 G5 部分）

```typescript
// tool-types.ts 扩展（AgentTool 增可选字段，零破坏）
export interface AgentToolAnnotations {
  readonly readOnly?: boolean;        // 缺省 false
  readonly destructive?: boolean;
  readonly idempotent?: boolean;      // 缺省 false → 重放保护按非幂等处理
  readonly requiresApproval?: boolean;
  readonly executionMode?: "serial" | "parallel";   // 缺省 "serial"
}
```

RimeCut 38 个工具的默认标注（宿主侧 Phase 4 任务，本仓只定义契约 + 缺省策略表）：

| 工具类 | readOnly | executionMode | requiresApproval |
|---|---|---|---|
| get_timeline / seek / list_* / RAG 查询 | true | parallel | false |
| add_* / update_* / split / trim / move / keyframe | false | serial | false（小范围编辑按产品策略自动允许） |
| delete / batch replace | false | serial | proposal（生成 proposal 后审批） |
| undo / redo / restore | false | serial（且独占：不与其他写并行） | false |
| 生成服务（视频/图片/音频） | false | serial | true |
| export / publish | false | serial | true |

写默认串行的理由（上游 §12.4.3）：EditorCore 可变状态、ProjectCommand revision、undo chain 与媒体任务副作用不能依赖 LLM 返回顺序以外的调度顺序。

### 5.6 ApprovalGate（对 G5）

```typescript
// runtime/approval.ts
export type PreflightDecision =
  | { action: "allow" }
  | { action: "deny"; reason?: string }
  | { action: "suspend"; reason: string };

export interface ApprovalGate {
  preflight(call: ToolCallContext): PreflightDecision | Promise<PreflightDecision>;
  /** suspend 后宿主收集用户决策（可跨进程重启），回写 store 并唤醒 run */
  resolve(toolCallId: string, decision: "allow" | "deny", note?: string): Promise<void>;
}

export interface ToolCallContext {
  readonly runId: string;
  readonly toolCall: ToolCall;
  readonly annotations?: AgentToolAnnotations;
  readonly projectId?: string;
  readonly projectRevision?: number;
}
```

持久化语义：suspend 时 runtime 落盘 `approval_requested` entry + `run_awaiting_approval` + checkpoint（durable boundary），事件流结束；`resume()` 读回持久化决策，**以同一 toolCallId 继续**。executor 侧第二道防线：执行前查 ledger，该 `toolCallId` 已有成功记录则跳过并返回缓存结果——刷新后不丢待确认任务，也不重复执行非幂等工具。

默认分类（缺省 ApprovalGate 实现 `createDefaultApprovalGate()`）：只读自动允许；普通编辑自动允许；`destructive` / `requiresApproval` 标注 → suspend；proposal 生成后仍走同一审批通道。

### 5.7 ContextManager：token budget、compaction、overflow（对 G2）

```typescript
// runtime/context-manager.ts
export interface ContextManagerConfig {
  readonly tokenizer?: (text: string) => number;   // 宿主注入；缺省 ceil(chars/4)
  readonly contextTokens?: number;                 // 缺省取 AgentLLMConfig.contextLength
  readonly reserveOutputTokens?: number;           // 缺省 4096
  readonly compactTriggerRatio?: number;           // 缺省 0.80
  readonly maxToolResultTokens?: number;           // 缺省 2048，超出 → artifact + 摘要行
}

export interface ProjectFactsDigest {
  readonly projectId?: string;
  readonly projectRevision: number;
  readonly digest: string;             // 宿主实时构建（canonical JSON hash / timeline 摘要）
  readonly summary?: string;           // 可选人类可读行
  readonly producedBy: "host";         // 类型级强制：摘要不得伪装宿主事实
}

export interface ContextProjection {
  readonly messages: AgentMessage[];   // 模型可见（喂 runAgentLoop 的形状）
  readonly tokensUsed: number;
  readonly compacted: boolean;
}
```

投影算法（替换 `messages.slice(-MAX_SERIALIZED_TURNS)`）：

```text
entries → tokenize 计量
  → 保留最近完整 tool turns（assistant toolCalls + 对应 tool results 原子性保留）
  → 超过 compactTriggerRatio × (contextTokens − reserveOutputTokens)：
       选择安全 cut point（最后一个已完成任务边界 / checkpoint entry）
       旧 entries → 宿主 summarize hook 生成摘要（含：用户目标、约束、已完成编辑、
         关键决策、失败工具、未解决问题、下一步、重要媒体/时间线引用）
       落盘 compaction entry（摘要 + compactedEntryIds + projectDigest）
  → 大 tool result（> maxToolResultTokens）→ artifact store，投影只留摘要行 + artifactId
  → 头部注入最新 getProjectFacts() digest（P30 之前的独立 context 行）
  → 输出 ContextProjection
```

overflow recovery（error category `context_overflow`）：compaction → 仍超则降低输出预算 → 仍超则缩小工具面（按 skill `toolRefs` 过滤）→ 仍超则 fail 并落盘可恢复状态。RAG 迁移：`RagBuilder` / `ErrorRecoveryBuilder` 从 `runAgentLoop` 参数变为 `hooks.buildRagContext` / `hooks.buildErrorRecovery`，在每次新用户请求、tool failure、role switch、compaction 后重建（上游 §12.5）。

### 5.8 RuntimeLedger 与 artifact（对 G6）

```typescript
// runtime/ledger.ts
export interface LedgerRecord {
  readonly runId: string;
  readonly seq: number;
  readonly ts: number;
  readonly event:
    | { kind: "model_call"; provider: string; model: string; requestIndex: number; usage: TokenUsage }
    | { kind: "tool_exec"; toolCallId: string; tool: string; argsDigest: string;
        outcome: "success" | "failure"; messageDigest: string; artifactId?: string;
        commandId?: string; projectRevisionBefore?: number; projectRevisionAfter?: number }
    | { kind: "retry"; toolCallId?: string; attempt: number; category: AgentErrorCategory }
    | { kind: "approval"; toolCallId: string; decision: string }
    | { kind: "compaction" | "cancellation"; detail?: string };
}

export interface RuntimeLedger {
  append(record: LedgerRecord): Promise<void>;
  hasExecuted(toolCallId: string): Promise<boolean>;    // 重放保护查询
  query(runId: string): Promise<LedgerRecord[]>;
}
```

红线：ledger 不存媒体字节、API key、cookie、完整敏感 prompt；大结果走 `AgentArtifactStore`（put/get/list，value 为 JSON-able 数据 + contentType；媒体文件本就不进 agent 层）。`commandId` / revision before/after 字段与 CLI serve 的 `project.log` / `project.diff`（CLI 文档 §8.2）按 key 对齐，供 rimecut 仓做命令流 parity 断言（§7 Phase 6）。

### 5.9 错误归一（对 G4）

```typescript
// errors.ts
export type AgentErrorCategory =
  | "provider"           // 网络 / HTTP / 超时 / provider 5xx
  | "context_overflow"
  | "tool_failure"       // 业务失败（AgentToolResult.success=false 的累积升级）
  | "interrupted";       // abort / 进程退出 / 刷新

export interface NormalizedError {
  readonly category: AgentErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export function normalizeError(err: unknown, ctx?: { toolName?: string }): NormalizedError;
```

策略表（上游 §12.4.5）：

| 类别 | 策略 |
|---|---|
| provider | 有界重试 + backoff（缺省 3 次，指数，宿主可覆盖） |
| context_overflow | §5.7 链路：compaction → 降输出预算 → 缩工具面 → fail |
| tool_failure | 结构化错误 + suggestions（现有 `ToolSuggestion`）+ 有限修正轮次（沿用宪法规则 4：两次失败即向用户说明） |
| interrupted | 落盘 `run_interrupted` + durable boundary，等 `resume()` |

### 5.10 与 ProjectCommand / CLI serve 的对齐

| CLI serve 方法（已存在） | rimeagent 侧消费方式 |
|---|---|
| `project.checkpoint` / `project.restore` | 宿主领域工具；`AgentCheckpointRef.projectCheckpointId` / `projectRevision` 引用关联，runtime 不直接调用 |
| `project.log` / `project.diff` | ledger 的 `commandId` + revision before/after 即关联键；parity 断言在 rimecut 仓 conformance（CLI 文档 Phase 4 已验收的部分不重做） |
| `commandId` 幂等 | 契约已保证；ledger `hasExecuted(toolCallId)` 是 agent 侧第二道防线 |
| `cli.methods` / serve 协议 1.1.0 | 不进 rimeagent；工具词汇统一时点遵循 CLI 文档 §D6 的 2026-09-24 决策——**保持 EditorCore manager API 词汇，随 Durable Runtime 迁移一并统一** |

执行拓扑定位（CLI 文档 §D5）：Tauri 内置 agent 走 in-process invoke 快路径；rimeagent 是纯 TS 库，无独立进程——"真正的后台长任务跑在 Web server/worker、Tauri host 或 CLI process，UI 只消费统一事件流"由宿主实现，runtime 只保证事件可序列化、可跨进程恢复。

### 5.11 原生传输 backend（NativeLLMBackend）

> 来源：rimecut 宿主侧 2026-10-11 harness 评估。GPL-3 harness（tinyagents）因许可边界否决；「turn-level 引擎 crate + 工具回调往返 + Rust 侧事件归一化」因制造平行语义否决；收敛为**仅替换 LLM 传输**的 adapter（D12）。Rust 侧 crate（rimecut `rust/crates/agent-engine`，可基于 rig-core 等 permissive 库）由宿主持有，本仓只交付 TS adapter、wire 契约与 conformance 套件。
>
> **Rev3**：Native 实施移出主排期，转附录 C 条件触发；本节 wire 契约与硬边界保持冻结，不随排期变化漂移。

**架构与数据流**（`═` 为 §5.11 契约边界；`▼` invoke 下行、`┆` Channel 事件上行）：

```text
  TS 侧 —— rimeagent 引擎 + 宿主（WebView）
 ─────────────────────────────────────────────────────────────────────
  agent-store / AgentRuntime          唯一归属：迭代 · 角色切换 · 工具执行
      │                               · 审批 · checkpoint · ledger · compaction
      ▼
  runAgentLoop ─► streamChatCompletion ─► llm-client（多槽解析 · 任务 0.4）
      │                                解析顺序：native（握手成功）→ vercel（opt-in）
      │                                             → RimeAgentBackend 基线
      │
      ├─► RimeAgentBackend     基线 · web/tauri 同一套（内部 OpenAI-compat 线 / Anthropic 原生线）
      │                        native 握手失败的回退目标；本地 Ollama 直连通路
      │
      ├─► VercelAIBackend      增强槽 · ./backends/vercel（peer: ai · 宿主 opt-in）
      │                        纯 TS，不跨越契约边界
      │
      └─► NativeLLMBackend     增强槽 · ./backends/native（peer: @tauri-apps/api · 附录 C 条件触发）
              │  构造时握手：命令存在性 + 契约版本号
              │  失败 ─► 诊断事件 ─► 整体回退 RimeAgentBackend
              │
              │  invoke agent_engine:stream_turn
              │    { requestId, config, messages, tools? }
              ▼
 ═════════════ 契约边界：§5.11 wire 契约 + conformance 套件 ════════════
              ▲
              ┆  ipc::Channel<StreamChunk>（serde camelCase）
              ┆  content_delta · tool_calls_delta · tool_calls_complete
              ┆  · done · error —— tool_calls_complete 后流即结束，
              ┆  工具执行回到 TS 侧 AgentRuntime / 宿主链路
              │
              ▼
  Rust 侧 —— rust/crates/agent-engine（rimecut 仓持有 · 可基于 rig-core）
 ─────────────────────────────────────────────────────────────────────
  组装 CompletionRequest ─► rig-core 流式调用 ─► StreamChunk 透传
  硬边界：不执行工具 · 不迭代 · 不重试 · 不持久化 · 不加事件信封
  BYOK：apiKey 仅随 turn 传递，不落盘 / 不缓存 / 不进 ledger
              │
              ▼
  provider HTTP(S)：OpenAI · Anthropic · DeepSeek · Ollama · …
```

```typescript
// adapters/native.ts —— 可选子路径 ./backends/native
// peerDependencies: { "@tauri-apps/api": ">=2" }（optional）；主入口零 Tauri 依赖（硬约束 5）
export class NativeLLMBackend implements LLMBackend {
  type = "native" as const;
  async *streamChat(
    config: AgentLLMConfig,
    messages: OpenAIMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamChunk>
}
}
```

wire 契约（宿主 Rust 实现方的 conformance 基准；通道事件即 `StreamChunk` 同构，serde camelCase）：

```text
invoke agent_engine:stream_turn {
  requestId: string                  // nanoid；abort 关联键
  config:   { baseUrl, apiKey, model, provider?, contextLength?, timeoutMs? }
  messages: OpenAIMessage[]          // system 已由 runAgentLoop 组装（P0–P50 分层不变）
  tools?:   ToolDefinition[]
} → ipc::Channel<StreamChunk>        // content_delta / tool_calls_delta /
                                     // tool_calls_complete / done / error
```

硬边界（违反任意一条即拒收该宿主实现）：

1. **Rust 不执行工具、不迭代、不重试、不持久化**——`tool_calls_complete` 后本次流即结束；迭代与错误策略归 runtime（§5.4/§5.9），工具执行/审批/ledger 全留 TS 侧既有链路；
2. **事件不自带信封**——v2 信封（§5.3）由 runtime 统一添加；原生通道只传内层 `StreamChunk`，不引入第二事件协议；
3. **错误透传 + TS 侧归一**——Rust 以 `{ type:"error", message }` 上报；类别判定（provider / context_overflow / …）由 `normalizeError()` 完成，映射表随 v0.2.0 冻结（native 实现依赖该时序，先契约后落地）；
4. **usage 对齐冻结形状**——`done.usage` 填 Phase 0 扩展后的 `TokenUsage`（cost/cache 为可选字段），不得另造平行结构；
5. **BYOK 红线**——apiKey 仅随单次 turn 传递；Rust 侧不落盘、不缓存、不进 ledger/artifact（同 §5.8 红线）；
6. **探测与回退**——adapter 构造时握手（命令存在性 + 契约版本号）；失败发诊断事件并整体回退 `RimeAgentBackend`（归并后基线），禁止半原生半 Web 管线；
7. **注册**——经任务 0.4 的谓词注册接入（匹配 `directMode===true` 或宿主显式选择），与 Vercel/基线并存不互相覆盖。

---

## 6. 关键设计决策

| # | 决策 | 理由 / 替代方案拒绝原因 |
|---|---|---|
| D1 | **Append-only session + 投影** | 历史不可篡改使 compaction 可回退、审计可行；替代"原地改写 messages"会破坏恢复与 parity 的可信度 |
| D2 | **Agent checkpoint 与 Project checkpoint 分离，仅引用关联** | §5.2 六不变量；合并两者（OpenChatCut 的 project store 路线）会把领域模型拉进引擎，违反宿主无关 |
| D3 | **写串行、只读可并行，默认全串行** | undo chain / revision / 媒体副作用不容许调度器自由发挥；并行收益仅在批量只读查询 |
| D4 | **审批持久化 + 同一 toolCallId resume + ledger 重放保护双保险** | 只靠标志位（现状 `requiresConfirmation`）在刷新后语义即丢失；只靠 ledger 不够——审批本身要跨重启存活 |
| D5 | **摘要不是项目事实**：compaction 后注入宿主实时 `ProjectFactsDigest`（`producedBy:"host"` 类型级标记） | 上游最高风险项"compaction 丢失项目事实"的结构性解法：摘要只作模型上下文，事实永远来自宿主单源 |
| D6 | **事件 v2 信封 + 未知事件安全忽略** | 事件协议要跨 Web/Tauri/CLI 与未来 rimecraft 消费者；无版本协商的联合类型会在第一个消费者处锁死 |
| D7 | **存储/分词/审批全部注入，核心只带 InMemory** | 宿主无关硬约束；IndexedDB/SQLite 走可选子路径 `./adapters/web`，peer dep 不进 dependencies |
| D8 | **Vercel AI SDK 仅作 backend adapter，可选子路径，不同时替换 session/event/tool 契约** | 上游 §12.7；先验证 provider/usage/取消/错误归一，`ToolLoopAgent` 不得拥有 checkpoint/approval/revision |
| D9 | **token 计量缺省 chars/4，tokenizer 注入** | 精确 tokenizer 依赖模型词表（每 provider 不同），引擎内置即破坏宿主无关；近似值只影响 compaction 触发点，偏差由 `compactTriggerRatio` 余量吸收 |
| D10 | **兼容入口不删**：`runAgentLoop` / `runAgentSession` 保留至 1.0.0 后一个大版本 | RimeCut 66 处 import 与 pin-commit 消费模式要求逐 Phase 切换；big-bang 迁移违反上游"增量演进"决策 |
| D11 | **`seq` 单调序号作为持久化对齐键** | `Date.now()`（现状 session.ts 消息 id）在并发/回拨下不可靠；seq 让 ledger/store/事件流三者可对账 |
| D12 | **原生传输只做 LLMBackend adapter**：Rust crate 不执行工具、不循环、不拥有事件信封（§5.11） | 复用 `registerLLMBackend` 既有 seam 与 D8 先例；替代方案「turn-level 引擎 crate + 工具回调往返 + Rust 侧 AgentEvent 归一化」被否决——归一化/事件协议/迭代语义已有唯一归属，第二实现即平行语义 |
| D13 | **backend 槽位与归并（Rev2）**：Cloud/Anthropic 双 backend 归并为单一 `RimeAgentBackend`（web/tauri 同一套基线，内部保留 OpenAI-compat 线 / Anthropic 原生线）；增强槽 vercel（宿主 opt-in）优先落地，native 延后条件触发；解析顺序 native（握手成功）→ vercel → 基线；基线零 npm 依赖，是 native 的回退目标与本地 Ollama 直连的唯一通路 | 归并消费面核实为零（rimecut 全仓无 `CloudLLMBackend`/`AnthropicLLMBackend` import），clean cutover 无需别名；删除基线会同时砍掉 native 回退、BYOK 本地直连与非 Vercel 宿主（rimecraft）的通路，被否决 |

---

## 7. 实施计划（Phase 0–8）

阶段划分、周期与验收对齐上游 §12.9 基线（合计 ~18 周日历 / 160 人日基线不变；2026-10-11 Rev3 重排：Phase 0 拆出传输前置子集，VercelAIBackend 前置为 Phase 1（宿主第一步），runner（原 Phase 1–4）顺延为 Phase 2–6，NativeLLMBackend 移出排期转附录 C 条件触发）。每个 Phase 给出：任务 → 文件 → 验收。测试命令统一为 `bun test`（本仓 `package.json scripts.test`）；当前仓无测试目录，Phase 0 建立 `tests/`（bun test 约定：`*.test.ts` 就地或 `tests/` 均可，采用 `tests/<module>/*.test.ts`）。

**执行纪律**：每个任务独立 commit（`feat(runtime): ...`）；破坏性类型变更只允许发生在新增面；每 Phase 收尾跑全量 `bun test` + `npm run build` + 更新下表状态后打 tag。

### 7.0 总览与依赖

```text
Phase 0 传输前置（errors · TokenUsage 扩展 · 多槽化）
  └► Phase 1 VercelAIBackend + RimeAgentBackend 归并            ← 第一步（宿主最快可 pin）
       └► Phase 2 runner 契约冻结（事件 v2 · entries · checkpoint · ledger）
            └► Phase 3 循环下沉 ─► Phase 4 持久化/恢复 ─► Phase 5 上下文 ─► Phase 6 审批/执行
                                                                        │
Phase 8 评测/发布（门禁在 P7 后）◄── Phase 7 CLI/MCP/parity（依赖 P4+P6）◄┘
```

Phase 2 的 runner 契约冻结与 Phase 3 的循环行为等价是后续一切的前置（对应上游 §12.9「契约冻结先行」原话的 Rev3 映射）。Phase 4 结束前若证实 Web host 不能承载后台长任务，由宿主侧决策 server/worker 或 Tauri 边界——不阻塞本仓任务。

### 7.1 Phase 0：传输前置（0.5 周 → v0.2.0）

> Rev3 从原 Phase 0 拆出的传输子集——只含 VercelAIBackend 落地所需的 additive 契约（errors 归一 + TokenUsage 扩展 + 多槽化）。runner 契约（事件 v2 / entries / checkpoint / store / ledger / annotations）整体后移至 Phase 2。

| 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|
| 0.1 建立 tests/ 骨架 | `tests/`、`tsconfig.json`（include tests） | bun test 可发现；CI（.github/workflows）跑 test+build | 空 smoke 测试通过 |
| 0.2 errors 归一 | `src/errors.ts`、`src/index.ts` | `AgentErrorCategory` / `NormalizedError` / `normalizeError()`；覆盖 fetch 错误、HTTP 状态、SSE 中断、abort | `tests/errors.test.ts`：≥8 个输入→类别映射断言 |
| 0.3 TokenUsage 扩展 | `src/types.ts` | cost / cache 字段（可选，additive）；现有消费者零破坏 | 类型快照 + 现有消费面零变化 |
| 0.4 backend 注册多槽化 | `src/llm-client.ts` | `registerLLMBackend(backend)` 语义保持（唯一注册者视作全匹配）；新增 `registerLLMBackendFor(predicate, backend)`；解析顺序：predicate 命中 → 旧 custom 单槽 → anthropic 原生 → cloud | 单 backend 注册行为零变化（现有快照）；双 backend 谓词路由 + 重复谓词显式诊断测试 |

**Phase 0 出口**：传输层 additive 契约导出；现有导出零变化；`bun test` + `npm run build` 绿。

**实施状态**：引擎侧完成（与 Phase 1 合并准备 `0.3.0`）；测试使用 `tests/` + 独立 `tsconfig.test.json`（noEmit），不向发布 `dist/` 混入测试。CI 运行 typecheck/test/build；不保留空 smoke 或实现文本快照，改用错误分类、协议边界和路由优先级行为断言。

实施冻结补充（2026-10-11）：`TokenUsage` 新增可选 `cost`（provider 报告的 USD 成本，不推算）、`cacheReadTokens`、`cacheWriteTokens`。`StreamChunk.error` additive 增 `error?: NormalizedError`，原有 `message` 保持；旧 `AgentEvent` 不变。多槽谓词按最近注册优先解析，随后旧 custom 单槽、基线；同一谓词函数重复注册抛错，不猜测不同函数的逻辑等价性。新增注册返回注销函数，旧 `registerLLMBackend()` 仍为最后注册者胜。

错误优先级补充：provider 明确报告的鉴权、权限、请求无效、`insufficient_quota` 等永久错误码不得因 HTTP 429/5xx 被重新标为可重试；普通 rate-limit 429 仍可重试。未知错误保守返回不可重试；异常 SSE 断流为可重试 provider 故障，显式取消为 interrupted。

### 7.2 Phase 1：VercelAIBackend + RimeAgentBackend 归并（1 周 → v0.3.0）

> Rev3 第一步（宿主最快可 pin 的增量）：Vercel AI SDK 以 peer 依赖接入为 `LLMBackend` 传输适配器；内置双 backend 归并为 `RimeAgentBackend`（web/tauri 同一套基线）。不触碰循环/工具/审批语义。

| 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|
| 1.1 VercelAIBackend | `src/adapters/vercel.ts`、`package.json`（exports `./backends/vercel` + `peerDependencies: {"ai": ">=5"}` + `peerDependenciesMeta.optional`） | 实现 `LLMBackend`（`llm-backend.ts:3-11` 现有接口，零核心改动）；streamText → StreamChunk 映射；宿主 opt-in 注册 | mock `ai` 包的 provider smoke；不安装 `ai` 时主入口构建不受影响 |
| 1.2 usage/错误归一 | `src/adapters/vercel.ts` | provider 错误 → `normalizeError`；usage 含 cost/cache 字段透传（Phase 0 扩展的 `TokenUsage`） | 错误类别断言 |
| 1.3 RimeAgentBackend 归并 | `src/llm-backend.ts` / `src/llm-client.ts` / `src/index.ts` | Cloud/Anthropic 两 class 归并为 `RimeAgentBackend`（内部 OpenAI-compat / Anthropic 两线路由不变）；导出替换，无别名（消费面核实为零） | `streamChatCompletion` 行为等价（现有快照）；`bun test` + `npm run build` 绿 |

**Phase 1 出口**：Web provider smoke 通过（Vercel 路径 + RimeAgentBackend 基线）；rimecut 宿主 pin 新 commit，在 web 端 opt-in 注册 VercelAIBackend。

**实施状态**：引擎侧完成，已重建 `dist/`；`./backends/vercel` 包含类型与运行时导出，`ai` 仅 optional peer 和 dev dependency，不进核心 dependencies。兼容入口 `runAgentLoop` / `runAgentSession` 未改；旧双 class clean cutover 为 `RimeAgentBackend`。宿主 pin/提交/tag 仍待发布流程，未修改 rimecut 仓。`npm run build:core` 可在没有 SDK 的环境编译核心，完整 adapter 开发构建需要 SDK dev dependency。

实施冻结补充（2026-10-11）：`VercelAIBackend` 构造注入 `(config) => LanguageModel | Promise<LanguageModel>`，provider 包、BYOK 与 proxy 模型选择由宿主持有。adapter 只做单次 `streamText`，`maxRetries: 0`、不提供 tool `execute`，不持有循环/审批。`ai >=5` 为 optional peer（开发构建与测试安装 AI SDK 5）；主入口不引用 SDK。历史 tool result 按 `toolCallId` 关联原工具名，未知关联返回结构化错误。缓存用量接受 SDK 5/6 字段；成本只接收明确 USD `cost`，不做价格推算。

传输生命周期：Vercel adapter 的请求与返回的 async generator 同寿命。宿主 AbortSignal 或消费者提前关闭 generator 均取消该次 provider 请求，正常完成亦释放传输资源；不由 adapter 发起重试。初始 system prompt 通过 SDK 专用 `system` 通道传入，不改写对话中的 tool turn。JSON schema 只描述工具参数，执行前的领域校验仍归工具执行层；adapter 拒绝不可解析的 tool JSON，不新增参数校验引擎。

工具流终态：已收到 tool input start 的调用必须在本 turn 收到完整且可解析的 tool-call；否则即使 provider 发出 finish，也返回 `tool_failure`，不得发出成功 `done` 或部分批次 `tool_calls_complete`。

### 7.3 Phase 2：runner 契约冻结（1.5 周 → v0.4.0）

> 原 Phase 0 的主体（契约冻结）后移至此，新增面开始承载 runner（Durable Agent Runtime）。行为级变更必须先改本文档再改代码（维护约定）；OpenChatCut Runner 仍只作行为参考（clean-room，§3.3.2）。

| 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|
| 2.1 事件 v2 信封 | `src/events.ts`、`src/index.ts` | §5.3 全类型 + `AGENT_RUNTIME_EVENT_VERSION`；透传 AgentEvent | `tests/events.test.ts`：信封构造 + 未知 type 的类型级穷尽检查（编译期）|
| 2.2 session entries | `src/store/entries.ts`、`src/index.ts` | §5.1 判别联合 + `isAgentSessionEntry()` 守卫 + round-trip 校验函数 | `tests/store/entries.test.ts`：全 kind 构造→JSON→还原 |
| 2.3 checkpoint 类型 | `src/store/checkpoint.ts` | §5.2 + `computeContextDigest()`（对投影做 FNV-1a hash，无新依赖） | `tests/store/checkpoint.test.ts`：digest 稳定性 + parentId 链 |
| 2.4 annotations | `src/tool-types.ts` | `AgentToolAnnotations` 挂 `AgentTool.annotations?`；`agentToolToDefinition` 不透传（annotations 不进 LLM schema） | 现有工具定义输出逐字节不变（快照断言） |
| 2.5 store 契约 + InMemory | `src/store/session-store.ts`、`src/store/artifact-store.ts` | §5.1 接口 + InMemory 实现 | append-only 语义测试：重复 append 同 id 抛错 |
| 2.6 ledger 类型 + InMemory | `src/runtime/ledger.ts` | §5.8 `LedgerRecord` + InMemory + `hasExecuted` | `tests/runtime/ledger.test.ts` |
| 2.7 clean-room 记录 | `docs/rimeagent-design.md` §3.3 | AGPL 边界与审计清单成文 | 评审签字（宿主负责人） |

**Phase 2 出口**：runner 全部新类型进 `index.ts` 导出；现有导出零变化；`bun test` + `npm run build` 绿。

### 7.4 Phase 3：循环下沉（2.5 周 → v0.5.0）

| 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|
| 3.1 AgentRuntime 骨架 + 生命周期 | `src/runtime/runtime.ts` | `createAgentRuntime()`；run 生命周期状态机（idle→running→awaiting_approval/interrupted→settled）；事件打信封 + seq | `tests/runtime/lifecycle.test.ts`：mock LLM backend 走完一次 run，事件序列符合 §5.4 |
| 3.2 迭代循环迁移 | `src/runtime/runtime.ts` | 把 `session.ts:59-173` 的循环逻辑（iteration、role switch、失败收集）搬入 runtime；hooks 化 ragContext/errorRecovery | 与 `runAgentSession` 行为等价：同一 mock 输入产生相同 tool 调用序列（golden trace 测试） |
| 3.3 `runAgentSession` 改薄包装 | `src/session.ts` | 内部委托 AgentRuntime（InMemory store），输出形状（`AgentSessionEvent`）不变 | 现有消费面零感知：`tests/session-compat.test.ts` 快照 |
| 3.4 取消语义 | `src/runtime/runtime.ts` | AbortSignal 触发 `run_interrupted{cause:"interrupted"}` + durable boundary 落盘；不留"运行中"假状态 | 取消后 store 无 running 状态残留 |
| 3.5 maxIterations 可观察 | `src/runtime/runtime.ts` | 达上限 → `run_completed` + 明确 payload 标记（非静默 return，修 session.ts:100 的早退） | 事件断言：iteration 计数可见 |

**Phase 3 出口**：宿主可开始灰度切换 `agent-store` → `createAgentRuntime`（rimecut 仓任务，行为等价验收在上游）。

### 7.5 Phase 4：持久化与恢复（3 周 → v0.6.0）

| 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|
| 4.1 entries 落盘 | `src/runtime/runtime.ts` | run 全生命周期 entry 追加（§5.1 全 kind）；每 iteration 边界 flush | 断电模拟（强杀 generator）后 store 状态一致 |
| 4.2 durable boundary | `src/runtime/runtime.ts` | checkpoint 自动生成策略：每 iteration 结束 + approval suspend 时；`contextDigest` 校验 | `tests/runtime/resume.test.ts` |
| 4.3 `resume()` | `src/runtime/runtime.ts` | 载入 session → 校验 `AgentCheckpointRef.projectRevision`（mismatch → 结构化错误，不变量 3/4）→ 从 seq 重建状态继续 | 中断→恢复→完成的端到端 mock 测试；revision mismatch 拒绝恢复 |
| 4.4 重放保护 | `src/runtime/executor.ts`（初版顺序执行） | 执行前 `ledger.hasExecuted(toolCallId)`；命中→返回缓存摘要，不重执行 | 恢复场景中非幂等工具恰好执行一次（计数断言） |
| 4.5 ledger 记录 | `src/runtime/ledger.ts` | model_call / tool_exec（含 commandId、revision before/after——由 `AgentToolResult.data` 增可选字段透出）/ retry / 终态 | `tests/runtime/ledger-e2e.test.ts` |
| 4.6 IndexedDB adapter | `src/adapters/indexeddb.ts`、`package.json` exports | `./adapters/web`：SessionStore/ArtifactStore/Ledger 的 IndexedDB 实现；主入口零 DOM | bun test（happy-dom 或 jsdom devDep）round-trip |
| 4.7 Tauri 适配指引 | `docs/rimeagent-design.md` 附录 | SQLite/file adapter 由宿主实现（rimecut 仓）；本仓只验收契约 contract test 复用 | 宿主 adapter 通过同一 contract test 套件 |

**Phase 4 出口**：刷新/重启后对话可恢复；无重复非幂等 command。

### 7.6 Phase 5：上下文管理（3 周 → v0.7.0）

| 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|
| 5.1 ContextProjection | `src/runtime/context-manager.ts` | entries → messages 投影；最近 tool turns 原子保留；token 计量（缺省 chars/4） | 投影形状 = runAgentLoop 可直接消费 |
| 5.2 artifact 截断 | `src/runtime/context-manager.ts`、`src/store/artifact-store.ts` | tool result > maxToolResultTokens → 存 artifact，投影留摘要行 + artifactId | 大结果注入后 tokensUsed 受控 |
| 5.3 compaction | `src/runtime/context-manager.ts` | §5.7 算法：安全 cut point（checkpoint/completed-task 边界）→ 宿主 summarize hook → 落盘 compaction entry | `tests/runtime/compaction.test.ts`：超预算触发、摘要含必备字段清单断言 |
| 5.4 project digest 注入 | `src/runtime/context-manager.ts` | 每次投影头部注入 `hooks.getProjectFacts()` 最新值（D5） | compaction 后投影仍含当前 revision digest（不变量 6 测试） |
| 5.5 overflow recovery | `src/runtime/context-manager.ts` | `context_overflow` → compaction → 降输出预算 → 缩工具面（skill toolRefs 过滤，宿主提供过滤钩子）→ fail 可恢复 | 三级降级链路逐级断言 |
| 5.6 RAG hooks 迁移 | `src/runtime/runtime.ts` | ragContext/errorRecovery 改由 hooks 在新请求/tool failure/role switch/compaction 后重建；`runAgentLoop` 参数保留（内部桥接） | 行为等价 + 重建时机断言 |

**Phase 5 出口**：长会话超 50 turn 仍能继续；项目事实不丢失。

### 7.7 Phase 6：审批与执行策略（2.5 周 → v0.8.0）

| 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|
| 6.1 ToolExecutor 策略引擎 | `src/runtime/executor.ts` | 按 annotations 分组：readOnly+parallel 并行（`Promise.allSettled`），其余严格串行；undo/redo/restore 独占批次 | 交错调度断言：写操作全序、读并行不阻塞写 |
| 6.2 默认 ApprovalGate | `src/runtime/approval.ts` | `createDefaultApprovalGate()`：§5.6 分类表；suspend → 落盘 → 事件流结束 | 删除/生成/export 类标注触发 suspend |
| 6.3 resume 审批链路 | `src/runtime/runtime.ts` | `resolveApproval()` + `resume()` 同一 toolCallId 继续；allow 后经 4.4 重放保护 | 刷新模拟后：审批任务不丢、不重复执行（端到端） |
| 6.4 proposal 事件 | `src/events.ts` | 批量编辑生成 proposal 的宿主协议（proposal = 带 diff 预览的 approval 变体，payload 增 `proposalDigest`） | 事件 schema 测试 |
| 6.5 宿主标注迁移指引 | `docs/rimeagent-design.md` | RimeCut 38 工具的标注表（§5.5）由 rimecut 仓落地；本仓提供 contract test 校验标注完整性 | 每个注册工具 annotations 齐全（宿主侧门禁） |

**Phase 6 出口**：删除/生成/export 审批；revision 和 undo chain 正确。

### 7.8 Phase 7：CLI/MCP/parity 对接（2.5 周）

本仓交付边界：**只做引擎侧的可对账面，golden task 命令流一致性在 rimecut 仓 conformance**（CLI 文档 Phase 4 已验收的 serve parity 不重做）。

| 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|
| 7.1 ledger ↔ project.log/diff 关联导出 | `src/runtime/ledger.ts` | `query(runId)` 输出含 commandId/revision 的可序列化报告（与 `project.log` 按 commandId join 的形状） | 报告 schema 测试 |
| 7.2 MCP 工具桥 | `src/mcp.ts`（扩展） | `MCPToolProvider.listTools()` 产出带 annotations 的 AgentTool；MCP 与内置工具经同一 executor/审批/ledger | mock provider 经 executor 的全生命周期测试 |
| 7.3 contract test 发布 | `tests/contract/` | store/ledger/approval 的可复用 contract test 套件（宿主 adapter 与 rimecraft 复用） | 套件作为导出（`./contract`）可被外部仓 import 运行 |
| 7.4 parity 支持 | 与 rimecut 仓协作 | 同一 golden task 在 Web/Tauri/CLI 三宿主的 journal 对比需要的引擎侧数据（ledger 报告 + 事件流录制/回放） | 事件流录制→回放产生相同 ledger |

### 7.9 Phase 8：评测与发布（2 周 → v1.0.0）

| 任务 | 要点 | 验收 |
|---|---|---|
| 8.1 引擎级故障注入测试 | provider 断流 / overflow / 取消 / 强杀恢复 / 审批跨重启 五类注入 | 全部落入预期终态，无假 running、无重复执行 |
| 8.2 评测支持 | 上游 20 个真实任务集的引擎侧数据收集（ledger → 指标：无效重试、compaction 次数、token/cost、恢复时间） | 指标导出器 + 一份基线报告 |
| 8.3 AGPL 审计 | 依赖树 + 源码相似度自查（§3.3 clean-room 记录） | 审计报告归档 |
| 8.4 文档与版本 | README、本文档状态行更新、CHANGELOG、`1.0.0` tag；rimecut 仓解除 pin 切 npm `^1.0.0`（或继续 pin） | 发布门禁（§8）全绿 |

### 7.10 里程碑与宿主切换节奏

```text
v0.2.0 ──► v0.3.0 ──► v0.4.0 ──► v0.5.0 ──► v0.6.0 ──► v0.7.0 ──► v0.8.0 ──► v1.0.0
  P0        P1        P2        P3        P4        P5        P6        P7+P8
  传输前置   Vercel+    runner    循环      持久化/    上下文     审批/     评测/发布
            归并       契约      下沉      恢复       管理       执行
                      │                    │
                      ▼                    ▼
              runner 契约基线      刷新恢复上线
              （rimecraft 复用）  （rimecut 灰度）
```

每 Phase 的宿主切换由上游阶段验收触发，本仓只保证该版本出口条件成立；pin commit 必须包含 `dist/`（附录 D）。

## 8. 验收与质量门禁

### 引擎契约（本仓 CI 强制）

- session entry 全 kind 在 InMemory / IndexedDB / 宿主 adapter 三实现 round-trip 一致（contract test 套件）；
- checkpoint `contextDigest` / `parentId` / `projectRevision` 引用可验证；
- 事件 v2：未知 `type` 安全忽略；`seq` 单调；取消后无"运行中"假状态；
- approval resume 不重复执行已提交 toolCallId（重放保护）；
- compaction 后投影必含最新 `ProjectFactsDigest`（不变量 6）；
- 兼容入口 `runAgentLoop` / `runAgentSession` 输出快照不回归。

### 发布阻断条件（上游 §12.11 收敛到引擎可测项）

1. 重放保护可被绕过（恢复后非幂等工具重复执行）；
2. compaction 后模型可见错误 revision；
3. 取消/中断留下不一致 store 状态；
4. `./adapters/web` 或 `./backends/vercel` 泄漏进主入口（构建产物 import 检查）；
5. ledger/artifact 存入 API key、cookie、媒体字节（schema 红线断言）；
6. 故障注入五类（7.9/8.1）任一无法解释地失败。
7. 原生通道执行工具、自带事件信封，或错误绕过 `normalizeError` 直通模型（§5.11 硬边界被破坏）。

### 长程任务评测（与 rimecut 仓共同承担）

≥20 个真实编辑任务（导入/粗剪/字幕/音频/转场/模板/生成/批量/预览/导出/失败恢复），rubric：不破坏项目、完成用户要求、结果质量；确定性项目状态检查（ProjectDocument/journal）优先于自然语言检查；失败案例回灌 regression。引擎侧职责 = ledger 指标导出（7.2）。

---

## 9. 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---:|---|
| 引擎从 1.4K 膨胀为难维护框架 | 中 | 领域内容拒之门外（§3.2）；单文件 ≤400 行；每 Phase 出口条件独立可验 |
| AGPL 源码误复制 | 高 | §3.3 clean-room 规则成文（任务 0.9）+ 7.3 审计；仅行为参考 |
| chars/4 token 近似导致 compaction 时机漂移 | 低 | `compactTriggerRatio` 0.80 留 20% 余量；tokenizer 注入可精确化；overflow recovery 兜底 |
| IndexedDB 在隐私模式/配额下不可用 | 中 | 契约化——宿主可换 SQLite/file adapter；`./adapters/web` 内部降级到 InMemory 并显式事件告警（不静默） |
| 兼容层长期滞留成双实现 | 中 | D10 明确退场时点（1.0.0 后一个大版本）；每 Phase 减薄一层 |
| rimecraft 接入时 API 漂移 | 高 | contract test 套件导出（6.3）供双仓共用；版本协商靠事件 `v` + semver |
| 审批跨进程重启的状态机复杂度 | 高 | 状态全部落盘为 entry（§5.1 approval/run_awaiting_approval kind），resume 是纯投影重建，无独立内存状态机 |
| 原生/可选 backend 并存时单槽注册互相覆盖 | 高 | 多槽化在 Phase 0 冻结（任务 0.4），先于 Vercel/native 任一落地 |
| wire 契约漂移（宿主 Rust crate 与本仓 adapter） | 中 | §5.11 为 conformance 基准；套件随 `./contract` 导出，双方 CI 消费（触发时落地，见附录 C） |
| rig-core 等 Rust 依赖 MSRV 抬升波及宿主 workspace | 低 | rimecut 仓侧问题：pin 精确版本 + toolchain 升级独立 PR；本仓不受影响 |

---

## 10. 与上游文档的可追溯映射

| 本文章节 | 上游来源 |
|---|---|
| §3.1 最小闭环 / §5.4 生命周期 | rimecut design §12.1 / §12.4.2 |
| §5.1–5.2 store / checkpoint | §12.4.1 / §12.3.1（六不变量） |
| §5.3 事件 v2 | §12.4 + 附录 A（`AgentRuntimeEvent`） |
| §5.5–5.6 annotations / approval | §12.4.3 / §12.4.4 |
| §5.7 ContextManager | §12.5 |
| §5.8 ledger | §12.6 |
| §5.9 错误归一 | §12.4.5 |
| §5.10 CLI 对齐 | cli-for-agent §D5 / §D6 / §8.2 |
| §5.11 / D12 / 7.6（5.4–5.6） | rimecut 宿主侧 2026-10-11 harness 评估（tinyagents GPL 否决 → rig-core 收缩为传输 adapter） |
| §7 周期与人日 | §12.9 / §12.10（人力表在 rimecut 侧，本文不复制） |
| §8 门禁 | §12.11 |
| §9 风险 | §12.12（引擎侧子集 + 新增） |

---

## 附录 A：`index.ts` 导出增量（Rev3 版本映射）

```typescript
// Phase 0 新增（v0.2.0 · 传输前置）
export type { AgentErrorCategory, NormalizedError } from "./errors";
export { normalizeError } from "./errors";

// Phase 2 新增（v0.4.0 · runner 契约冻结）
export { AGENT_RUNTIME_EVENT_VERSION } from "./events";
export type { AgentRuntimeEvent, AgentRuntimeEventEnvelope } from "./events";
export type { AgentSessionEntry, AgentSessionSnapshot } from "./store/entries";
export type { AgentSessionStore } from "./store/session-store";
export { InMemorySessionStore } from "./store/session-store";
export type { AgentCheckpoint, AgentCheckpointRef, AgentBranch } from "./store/checkpoint";
export { computeContextDigest } from "./store/checkpoint";
export type { AgentArtifactStore } from "./store/artifact-store";
export { InMemoryArtifactStore } from "./store/artifact-store";
export type { AgentToolAnnotations } from "./tool-types";        // 挂在 AgentTool 上（Phase 2.4）
export type { LedgerRecord, RuntimeLedger } from "./runtime/ledger";
export { InMemoryLedger } from "./runtime/ledger";

// Phase 3+ 新增（v0.5.0 起 · runtime 主入口）
export type { AgentRuntimeConfig, AgentRuntime } from "./runtime/runtime";
export { createAgentRuntime } from "./runtime/runtime";
export type { ContextManagerConfig, ContextProjection, ProjectFactsDigest } from "./runtime/context-manager";
export type { ToolExecutorConfig } from "./runtime/executor";
export type { ApprovalGate, PreflightDecision, ToolCallContext } from "./runtime/approval";
export { createDefaultApprovalGate } from "./runtime/approval";

// 可选子路径（不进主入口）
// "rimeagent/backends/vercel"→ VercelAIBackend（v0.3.0 · Phase 1；peer: ai）
// "rimeagent/adapters/web"   → IndexedDB stores（v0.6.0 · Phase 4）
// "rimeagent/contract"       → contract test 套件（v0.4.0 起 · Phase 2）
// "rimeagent/backends/native"→ NativeLLMBackend（附录 C 触发时；peer: @tauri-apps/api）
```

现有导出（§2.1 表 + 上游附录 A）全部保持。

## 附录 B：规模与依赖预算

| 指标 | 基线（v0.1.0） | 目标（v1.0.0） |
|---|---:|---:|
| 总行数 | 1,398 / 17 文件 | 4,000–6,000（含 tests；不含宿主 tools） |
| 最大单文件 | `anthropic-backend.ts` 202 行 | ≤400 行 |
| runtime 依赖 | `nanoid` | `nanoid`（不变）；`ai` 仅 peer；IndexedDB 为平台 API 非 npm 依赖 |
| 测试 | 0 | 每模块 ≥1 测试文件；故障注入 5 类；contract test 套件可导出 |
| 导出 | 59 行 index.ts | 主入口纯核心；4 个可选子路径 |

新增代码量估算（对齐上游"约 4,000–6,000 行"）：runtime 核心 ~1,600（runtime/executor/approval/context-manager/ledger）、store ~800（entries/session/checkpoint/artifact + InMemory）、adapters ~800（indexeddb/vercel/native + wire conformance）、events/errors ~250、tests ~1,200–2,000。

---

## 附录 C：NativeLLMBackend 条件触发（不在主排期）

> Rev3 决策：NativeLLMBackend（§5.11）移出主排期。契约面（wire 契约 + 硬边界 + conformance 套件）已随本文档冻结，触发后按下表落地，无需重新设计。

**触发条件**（满足任一即启动）：

1. 现场出现 WebView 传输故障工单：企业代理 / MITM 证书下 direct fetch 失败、AV 软件缓冲导致 SSE 断流、renderer 生命周期中断长流；
2. rimecut 宿主排期 tauri 原生传输（如后台长任务需要脱离 WebView 网络栈）；
3. BYOK/合规需求要求 API key 不进 WebView 进程。

**触发后的任务序列**（对应 Rev2 任务 5.4–5.6）：

| 步骤 | 内容 | 验收 |
|---|---|---|
| C.1 TS adapter `NativeLLMBackend`（`./backends/native`） | invoke + `ipc::Channel` → `StreamChunk`；握手失败整体回退 `RimeAgentBackend` | mock invoke/Channel 全事件序列测试 |
| C.2 wire conformance 套件落地（`./contract`） | §5.11 事件顺序 / 错误透传 / usage 形状断言 | 宿主 Rust crate（rimecut `rust/crates/agent-engine`，可基于 rig-core）以同一套件验收 |
| C.3 宿主侧 crate + 注册 | rimecut 仓实现 `agent-engine` + `registerLLMBackendFor(predicate, native)` | tauri 端 provider smoke + 回退路径回归 |

**不触发时的状态**：`native` 槽位在多槽解析中恒为空，解析顺序退化为 vercel（opt-in）→ RimeAgentBackend 基线；§5.11 全节保持「契约冻结、实现缺席」。

## 附录 D：宿主 pin 纪律（git dep 消费面）

> 隔离模型：rimecut 以 `github:caozisheng/rimeagent#<commit>` pin 冻结快照消费，两仓日常开发零耦合（引擎重构不碰宿主构建，宿主变更引擎零感知）。**锁死旧 commit = 停留 v0.1.0 基线，Rev3 全部收益与宿主无关**；收益获取的唯一路径是 Phase 出口 re-pin。

**引擎仓 release 纪律（阻断级）**：每个 Phase 出口的 pin commit **必须包含最新构建的 `dist/`**——git dep 消费者解析的是构建产物而非源码（`#5898430` 即为此存在的 commit）。漏带 `dist/` 直接断宿主构建；发布前跑 `npm run build` 并确认 `dist/` 入 commit。

**每个 Phase 出口的宿主 re-pin 动作**（约半小时，rimecut 仓任务）：

1. 改 `apps/web/package.json` + `apps/tauri/package.json` 两处 pin → 新 commit hash；
2. `bun install`（lock 变更仅此一处，不带无关 lock diff）；
3. agent 冒烟：一次对话 + 一次工具调用链路（P3 起对照 golden trace / 快照验收）。

**re-pin 安全性依据**：

| 保障 | 内容 |
|---|---|
| D10 兼容承诺 | 1.0.0 前现有导出不删不改语义；破坏性类型变更只发生在新增面（新类型 / 新子路径） |
| 消费面核实 | 唯一替换性改动（P1.3 RimeAgentBackend 归并）已核实 rimecut 全仓零直接 import 旧类名 |
| 出口门禁 | 每个 pin 点对应引擎侧 `bun test` + `npm run build` 绿 + 宿主侧行为等价验收 |

**1.0.0 后**：可选切 npm `^1.0.0`（任务 8.4），摆脱手工 pin；在此之前版本节奏即 pin 节奏（§4.3 版本表 = 宿主 re-pin 时刻表）。

---

*维护约定：本文随每个 Phase 出口更新状态与差异；行为级变更（契约、不变量、门禁）必须先改本文再改代码。*
