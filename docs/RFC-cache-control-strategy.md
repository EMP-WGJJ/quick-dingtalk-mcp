# RFC: 大数据任务的内存与缓存控制策略

## 背景

quick-dingtalk-mcp 是一个 CLI 包装器架构：

```
MCP Client (AI) → quick-dingtalk-mcp → execFile(dws) → 钉钉 API
```

当前每次工具调用都通过 `execFile` 派生 `dws` 子进程，**全量缓冲 stdout 到内存**后返回。
唯一的保护是 `maxBuffer: 5MB`——超限直接杀掉子进程，已获取的数据全部丢失。

这意味着：
1. **MCP 服务本身不管理业务数据内存**——数据在 dws 子进程里产生，完成后一次性交给 Node.js 堆。
2. **没有中间状态**——要么全部成功，要么全部作废。
3. **无法处理大批量任务**——如"下载100个PDF"在第80个时内存超限，前79个结果全丢。

因此，控制策略的核心不是"监控内存然后杀进程"，而是**从源头控制数据量，让内存永远不会撑不住**。

---

## 目标

- 大批量任务不会导致 OOM 或数据全部丢失
- 已完成的部分结果可以增量交付，失败后可从断点恢复
- 重复请求不需要重新执行 dws，通过本地缓存加速
- 对现有工具调用透明，不破坏已有接口

---

## 设计方案

### 一、任务拆分策略（防止内存溢出的根本方案）

#### 1.1 问题本质

```
当前：1个工具调用 = 1次 dws 执行 = 全量数据缓冲
结果：数据量大时，要么成功（全占内存），要么失败（全部丢失）
```

#### 1.2 解决方案：批次拆分

将大任务自动拆分为多个小批次的 dws 调用：

```javascript
// 示例：批量获取邮件
// 之前：dws mail message search --size 100  → 一次性返回100条完整邮件
// 之后：拆分为 10 次 × 10条，逐批执行

async function batchExecute(tool, inputArgs, batchConfig) {
  const { batchSize, pageParam, cursorParam } = batchConfig;
  const results = [];
  let cursor = null;

  while (true) {
    const batchArgs = { ...inputArgs, [pageParam]: batchSize, [cursorParam]: cursor };
    const result = await executeTool(tool, batchArgs);
    results.push(result);

    // 每批完成后可交付中间结果
    cursor = extractNextCursor(result);
    if (!cursor) break;
  }

  return mergeResults(results);
}
```

#### 1.3 批次配置

| 工具类型 | 默认批次大小 | 说明 |
|---------|------------|------|
| 邮件搜索/列表 | 10条/批 | 邮件体积大，含 HTML body |
| 文件下载 | 1个/批 | 单文件可能很大 |
| 表格读取 | 500行/批 | 按行数分片 |
| 记录查询 | 50条/批 | aitable 记录 |
| 文档列表 | 20个/批 | 元数据较小 |

---

### 二、并发控制（限制同时在内存中的数据量）

#### 2.1 问题

即使单个任务拆分了，如果 AI 同时发起多个工具调用（并发读邮件+查文档+下文件），
每个 dws 子进程都在缓冲数据，内存仍然会累积。

#### 2.2 解决方案：全局执行队列

```javascript
class ExecutionQueue {
  constructor(config) {
    this.maxConcurrency = config.maxConcurrency;       // 最大并发 dws 进程数
    this.maxTotalBuffer = config.maxTotalBuffer;       // 所有进程的缓冲总量上限
    this.currentBuffer = 0;
    this.running = 0;
    this.queue = [];
  }

  async submit(task) {
    if (this.running >= this.maxConcurrency) {
      await this.waitForSlot();
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.processQueue();
    }
  }
}
```

#### 2.3 并发配置

```javascript
const CONCURRENCY_CONFIG = {
  maxConcurrency: 3,                    // 同时最多 3 个 dws 子进程
  maxTotalBuffer: 200 * 1024 * 1024,    // 所有进程缓冲总量上限 200MB
  queueTimeout: 120_000,                // 排队超时 2 分钟
  priority: {                           // 优先级（高优先执行）
    'mail': 1,
    'chat': 1,
    'drive': 2,                         // 文件类大任务优先级低
    'sheet': 2,
  }
};
```

---

### 三、增量响应（已完成的部分不丢失）

#### 3.1 问题

当前模式下，如果任务执行到一半失败，AI 得到的只是一条错误信息，
已经成功获取的数据全部丢失。

#### 3.2 解决方案：进度跟踪 + 部分结果交付

```javascript
class TaskProgress {
  constructor(taskId, totalBatches) {
    this.taskId = taskId;
    this.totalBatches = totalBatches;
    this.completedBatches = 0;
    this.results = [];                // 已完成的批次结果
    this.lastCursor = null;           // 断点位置
    this.status = 'running';          // running | completed | failed | partial
  }

  addBatchResult(result, cursor) {
    this.results.push(result);
    this.completedBatches++;
    this.lastCursor = cursor;
  }

  // 失败时返回已有结果 + 断点信息
  getPartialResult() {
    return {
      status: 'partial',
      completed: `${this.completedBatches}/${this.totalBatches}`,
      data: this.results,
      resumeCursor: this.lastCursor,
      message: `已完成 ${this.completedBatches} 批，可使用 cursor="${this.lastCursor}" 继续`
    };
  }
}
```

#### 3.3 失败时的响应格式

```json
{
  "content": [{
    "type": "text",
    "text": "部分完成：已获取 80/100 封邮件。\n\n[已获取的数据...]\n\n如需继续，请使用 cursor=\"xxx\" 参数重新调用。"
  }],
  "isError": false
}
```

**关键变化**：失败不再是全部作废，而是返回已有结果 + 续做指引。

---

### 四、本地缓存（避免重复执行 dws）

#### 4.1 缓存的真正价值

缓存不是为了"转存内存数据"，而是为了：
- **避免重复调用 dws**：相同参数的请求直接返回缓存结果
- **支持断点续做**：已完成的批次结果缓存到磁盘，失败后不需要从头开始
- **跨会话复用**：AI 多次问同一个问题时不重复请求钉钉 API

#### 4.2 缓存架构

```
~/.quick-dingtalk-mcp/cache/
├── responses/          # dws 命令的响应缓存
│   ├── <hash>.json     # key = sha256(command + args)
│   └── ...
├── progress/           # 批量任务的进度文件
│   ├── <taskId>.json   # 断点信息 + 已完成批次列表
│   └── ...
└── meta.json           # 缓存元数据（总大小、文件数等）
```

#### 4.3 缓存策略

```javascript
const CACHE_CONFIG = {
  // 存储限制
  maxTotalSize: 1024 * 1024 * 1024,   // 总上限 1GB
  maxFileSize: 100 * 1024 * 1024,     // 单文件上限 100MB（超过则不缓存）

  // 过期策略
  ttl: {
    'mail.message.get': 4 * 60 * 60 * 1000,      // 邮件内容 4小时
    'mail.message.search': 10 * 60 * 1000,        // 搜索结果 10分钟
    'drive.download': 24 * 60 * 60 * 1000,        // 文件下载 24小时
    'sheet.read': 5 * 60 * 1000,                  // 表格数据 5分钟（易变）
    'doc.read': 30 * 60 * 1000,                   // 文档内容 30分钟
    'default': 15 * 60 * 1000,                    // 默认 15分钟
  },

  // 淘汰策略
  evictionPolicy: 'lru',              // LRU 淘汰
  cleanupInterval: 30 * 60 * 1000,    // 每30分钟清理过期文件

  // 缓存判定
  cacheableCommands: [                // 只缓存读操作
    'mail.message.get',
    'mail.message.search',
    'drive.download',
    'drive.list',
    'sheet.read',
    'doc.read',
    'doc.list',
    'aitable.record.list',
  ],
};
```

#### 4.4 缓存流程

```
工具调用进入
  → 计算缓存 key = hash(command + args)
  → 缓存命中且未过期？
     → 是：直接返回缓存内容（不执行 dws）
     → 否：执行 dws → 结果写入缓存 → 返回结果
```

---

### 五、Runner 改造（整合以上策略）

#### 5.1 改造后的执行流程

```
工具调用进入
  ├─ 1. 是否批量场景？ → 拆分为多批次
  ├─ 2. 每批次进入并发队列等待执行
  ├─ 3. 执行前查缓存（命中则跳过 dws）
  ├─ 4. 缓存未命中 → 执行 dws 子进程
  ├─ 5. 执行成功 → 写入缓存 + 记录进度
  ├─ 6. 执行失败 → 返回已完成的部分结果 + 断点
  └─ 7. 全部完成 → 合并结果返回
```

#### 5.2 改造后的 maxBuffer 策略

```javascript
// 不再一刀切杀进程，而是根据场景动态调整
const BUFFER_CONFIG = {
  // 小数据命令（列表、搜索）：保持 5MB
  small: 5 * 1024 * 1024,
  // 中等数据命令（文档内容、邮件正文）：50MB
  medium: 50 * 1024 * 1024,
  // 大数据命令（文件下载）：200MB（配合单任务执行）
  large: 200 * 1024 * 1024,
};

function getMaxBuffer(command) {
  if (command.includes('download') || command.includes('upload')) return BUFFER_CONFIG.large;
  if (command.includes('read') || command.includes('get')) return BUFFER_CONFIG.medium;
  return BUFFER_CONFIG.small;
}
```

---

## 配置总览

```javascript
const DEFAULT_CONFIG = {
  // 任务拆分
  batch: {
    enabled: true,
    defaultSize: 20,
    sizeByType: {
      'mail.message': 10,
      'drive.file': 1,
      'sheet.data': 500,
      'aitable.record': 50,
    },
  },

  // 并发控制
  concurrency: {
    maxProcesses: 3,
    maxTotalBuffer: 200 * 1024 * 1024,
    queueTimeout: 120_000,
  },

  // 本地缓存
  cache: {
    enabled: true,
    dir: '~/.quick-dingtalk-mcp/cache/',
    maxTotalSize: 1024 * 1024 * 1024,
    maxFileSize: 100 * 1024 * 1024,
    defaultTTL: 15 * 60 * 1000,
    evictionPolicy: 'lru',
    cleanupInterval: 30 * 60 * 1000,
  },

  // Buffer 限制
  buffer: {
    small: 5 * 1024 * 1024,
    medium: 50 * 1024 * 1024,
    large: 200 * 1024 * 1024,
  },
};
```

---

## 影响范围

| 模块 | 改造内容 |
|------|---------|
| `src/framework/runner.mjs` | 接入并发队列、缓存查询、动态 maxBuffer |
| `src/framework/batch-executor.mjs` | 新增：批次拆分与进度跟踪 |
| `src/framework/execution-queue.mjs` | 新增：并发控制队列 |
| `src/framework/cache-manager.mjs` | 新增：本地缓存管理（读写、淘汰、清理） |
| `src/tools/mail/message.mjs` | 添加批次配置（batchSize、分页参数映射） |
| `src/tools/drive/file.mjs` | 添加批次配置 + 大文件 buffer 标记 |
| `src/tools/sheet/data.mjs` | 添加批次配置（按行数分片） |

---

## 实现计划

### Phase 1：并发控制 + 动态 Buffer（最小改动，立即见效）
- [ ] 实现 `src/framework/execution-queue.mjs`
- [ ] 改造 `runner.mjs` 接入队列 + 动态 maxBuffer
- [ ] 添加配置加载支持

### Phase 2：本地缓存（减少重复请求）
- [ ] 实现 `src/framework/cache-manager.mjs`
- [ ] runner 中接入缓存查询/写入逻辑
- [ ] 实现 LRU 淘汰 + TTL 过期清理

### Phase 3：任务拆分 + 增量响应（大任务场景）
- [ ] 实现 `src/framework/batch-executor.mjs`
- [ ] 为各工具模块添加批次配置元数据
- [ ] 实现进度跟踪与断点续做
- [ ] 失败时返回部分结果 + 续做指引

### Phase 4：监控与日志
- [ ] 添加并发队列状态日志
- [ ] 缓存命中率统计
- [ ] 批次执行进度日志

---

## 与旧方案的对比

| 维度 | 旧方案（监控内存+杀进程） | 新方案（拆分+并发控制+缓存） |
|------|--------------------------|------------------------------|
| 哲学 | 事后补救 | 事前预防 |
| 内存超限时 | 杀 dws，数据全丢 | 不会超限（从源头控制数据量） |
| 部分失败 | 全部作废 | 返回已完成部分 + 断点 |
| 重复请求 | 每次都执行 dws | 缓存命中直接返回 |
| 并发安全 | 无限制，可能同时 OOM | 全局队列，有序执行 |
| 复杂度 | 高（内存监控、GC触发、转存） | 适中（队列+缓存，逻辑清晰） |

---

## 风险与注意事项

1. **批次拆分需要了解 dws 的分页机制**：不同命令的分页参数不同（cursor/next_token/offset），需要逐个适配。
2. **缓存一致性**：钉钉数据是实时变化的，TTL 设置需要权衡"新鲜度"和"性能"。
3. **向后兼容**：对不支持分页的 dws 命令，退化为单次执行（现有行为不变）。
4. **配置支持环境变量覆盖**：方便不同部署环境调整参数。
