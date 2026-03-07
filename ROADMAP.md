# QFC Explorer API — Roadmap

> 最后更新: 2026-03-07

## 已完成

### Phase 1: 核心 API (v1.0)
- [x] Fastify 5 + TypeScript + ESM 框架搭建
- [x] 区块、交易、地址、合约、代币 CRUD 路由
- [x] PostgreSQL 数据库查询层
- [x] Redis 缓存集成 (热路由 TTL 策略)
- [x] SSE 实时推送 (stream.ts)
- [x] Prometheus 指标 (/metrics)
- [x] 搜索 + 建议 API
- [x] 分析仪表板 API + CSV/JSON 导出
- [x] 排行榜 API (余额、活跃度、验证者、合约)
- [x] 健康检查 (DB + RPC + indexer lag)
- [x] 内存速率限制 (100 req/min/IP)

### Phase 2: Indexer 独立化
- [x] 从 qfc-explorer 迁移 indexer 到本 repo
- [x] Indexer 拆分为 Block / Token / Contract / Internal Tx 四模块
- [x] Pipeline: Block → Token+Contract (并行) → Internal Tx (优雅降级)
- [x] Docker 同镜像不同 CMD 部署 (API vs Indexer)

### Phase 3: 基础设施增强
- [x] 多 RPC 节点 + Round-Robin 故障转移
- [x] Archive 节点支持 (debug_traceTransaction)
- [x] PostgreSQL 读写分离 (Primary + Replica)
- [x] 数据库按 block_height 范围分区 (1M blocks/partition)
- [x] Internal Transaction API 路由
  - [x] GET /txs/:hash/internal
  - [x] GET /blocks/:height/internal
  - [x] GET /address/:addr?tab=internal_txs

---

## 计划中

### Phase 4: Indexer 可观测性 ✅
> Indexer 专属 Prometheus 指标，提升运维可见性

- [x] 处理速度指标 (block_process_duration, pipeline_stage_duration, batch_duration)
- [x] RPC 调用延迟直方图 (rpc_duration_seconds, 按 method + node 分类)
- [x] 队列深度 (lag_blocks = chain_height - current_height)
- [x] Token/Contract/Internal Tx 处理计数 (token_transfers_total, contracts_detected_total, internal_txs_total)
- [x] 错误率 + 失败区块计数 (rpc_errors_total, blocks_skipped_total)
- [x] Indexer 独立 /metrics 端点 (:9090, 与 API :3001 分离)

### Phase 5: 合约验证增强 ✅
> Solidity source verification + ABI 解码，提升数据可读性

- [x] Solidity 源码验证 (solc 编译 + bytecode 比对, CBOR metadata stripping)
- [x] 多文件 + import 支持 (POST /contract/verify-json, Standard JSON Input)
- [x] 验证后自动存储 ABI (contracts.abi JSON column)
- [x] ABI 解码 tx input (decoded_input in GET /txs/:hash, POST /contract/decode)
- [x] ABI 解码 event logs (decoded_logs in GET /txs/:hash, POST /contract/decode-log)
- [x] 已验证合约列表 API + 排行 (GET /contract/verified)

### Phase 6: 实时推送增强 ✅
> 基于现有 stream.ts 扩展，支持细粒度订阅

- [x] WebSocket 支持 (GET /ws, 与 SSE 并行)
- [x] 按地址订阅交易通知 (subscribe address → address_txs 事件)
- [x] 频道订阅: blocks (新区块), txs (最新交易), stats (网络统计)
- [x] 连接管理 (按需轮询: 无连接时停止, 有连接时自动启动)
- [x] 管理统计 (getWsStats: 连接数、订阅频道数、监控地址数)

### Phase 7: 搜索优化
> 提升搜索体验和数据维度

- [ ] PostgreSQL 全文搜索 (tsvector + GIN 索引)
- [ ] 地址标签系统 (已知合约、交易所、项目方)
- [ ] 合约名称 + 代币名称索引
- [ ] 搜索结果分类 (地址/交易/区块/代币/合约)
- [ ] 搜索历史 + 热门搜索

### Phase 8: 数据归档
> 老数据迁移到冷存储，减轻主库压力

- [ ] 归档策略设计 (按 block_height 阈值)
- [ ] 归档表 (archive_transactions, archive_events)
- [ ] 自动迁移脚本 (定时任务)
- [ ] 查询层透明回退 (主表 → 归档表)
- [ ] 归档数据压缩 + 外部存储 (S3/MinIO)

---

## 优先级排序

```
Phase 4: Indexer 可观测性    ✅ 已完成
Phase 5: 合约验证增强        ✅ 已完成
Phase 6: 实时推送增强        ✅ 已完成
Phase 7: 搜索优化            ← 数据量增长后再做
Phase 8: 数据归档            ← 数据量达到瓶颈后再做
```
