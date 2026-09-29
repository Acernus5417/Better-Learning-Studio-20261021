# 有界任务运行时

`scripts/bounded_runtime.py` 是标准库实现的候选产物运行时。数据库位于课程的
`_工作区/bounded-runtime/runtime.sqlite3`，采用 SQLite WAL、事务与持久化租约。
它不发布正式课程文件；发布者必须在写入前调用 `gate_for_artifact`，并使用门禁确认的精确文件路径与内容哈希。

## 信任边界与能力限制

宿主适配器必须实际创建不继承历史的新执行体、记录真实 Agent ID，并从宿主获取终态。
运行时只检查适配器回执结构、标识关联及文件哈希；JSON 文件不是隔离的自动证明，模块也不会创建代理、验证签名或验证宿主事件真实性。
适配器、SQLite 数据库和回执存储属于受信边界，应由调度器管理；不得让写作者自行制造回执或改写数据库。
测试中的 `trusted-fixture-adapter` 仅为模拟数据，不代表真实宿主验证。

读取覆盖记录证明字节已通过受限接口交付给评审会话，不证明模型已经理解内容。
独立身份、全文交付与逐项 findings 是最低机械门禁，语义判断仍由实际评审者负责。
文件快照校验不等于操作系统文件锁；发布方应在同一受信流程内读取并复核返回哈希后发布，避免校验后被其它进程改写。
当前读取接口只支持 UTF-8 文本。二进制图片/PDF 的视觉读取证明仍由转写专用宿主适配器处理；本模块不能代替视觉证据。

## 注册版本与预算

`policy_registry(stage, skill_root=None)` 对阶段关联的 `SKILL.md`、宿主适配、参考规范、模板、验证脚本和运行时源码逐项保存绝对路径、SHA-256 与字节数。
支持 `transcription / knowledge / path / lesson / cards / relations / quality`。
任务规格同时绑定原始输入、配置哈希、规范注册表和写作者宿主回执；任一内容变化使旧任务失效，须创建新任务 ID。
schema v2 不自动迁移旧版数据库，版本不一致直接报错；旧数据应保留用于审计。

所有数值单位均为 **UTF-8 字节**，不是模型 tokens，尚未针对具体模型标定。
当前固定上限为：每任务调用预留 131072 字节、每宿主会话累计 524288 字节、单次正文读取 8192 字节、候选输出最大 32768 字节、工具/评审回执最大 16384 字节、规格最大 32768 字节、状态页最多 50 条、单任务最多 64 个输入或候选文件。
这些只是模块内的保守预留与实际读入记账，不能测量绕过接口的上下文、宿主系统提示或所有外部工具输出；不应宣称它们等同于真实模型上下文限额。
适配器需另行约束外部工具与实际 token 用量；计划启用更低模型预算时应先调整常量并重新建任务，不得沿用原规格。

`create_task` 在落任务时一次预留输入全文、规范全文、实际规格字节数加固定 512 字节元数据余量、输出和工具额度；最终规格仍需小于 32768 字节，并复核没有超过实际预留。`prepare_review` 在评审开始前一次预留原输入、全部候选、规范/模板全文、实际 scope 规格加 512 字节元数据余量、回执以及少量重读额度。不得通过省略正文或适用规范来腾出额度。
预算不足直接要求拆分或新会话交接，不生成摘要代替未读取正文。
预留不退款；重试必须使用新任务 ID 并继续累计同一会话预算。幂等重放不清零预算，也不能领取第二个有效租约。

## Python API

```python
runtime = Runtime(course_path, skill_root=None)
runtime.register_session({'receipt_path': '相对课程路径或课程内绝对路径'})
runtime.create_task(task_id, stage, inputs, config, session_id,
                    output_reserve=16384, tool_reserve=8192)
spec = runtime.task_spec(task_id)
lease = runtime.claim(task_id, session_id)['lease']
chunk = runtime.read_input(task_id, lease, path, offset=0, limit=8192)
runtime.submit_candidate(task_id, lease, candidate_paths, {'receipt_path': stop_path})

prepared = runtime.prepare_review(task_id, reviewer_session)
# 对 prepared['scope'] 每个分组里的每个文件从 offset=0 读取至 eof。
chunk = runtime.read_review(task_id, reviewer_session, prepared['review_token'],
                            path, offset=0, limit=8192)
runtime.review(task_id, reviewer_session, 'pass', [review_receipt_path])
gate = runtime.verify_gate(task_id, candidate_paths=None)
artifact_gate = runtime.gate_for_artifact(exact_candidate_path)
runtime.close()
```

`read_input` 和 `read_review` 返回 `text / next_offset / eof`；偏移和长度都是字节数。
必须使用返回的 `next_offset`，避免切断中文 UTF-8 字符。正文超出单页时继续分页读取。
`prepare_review` 返回 `task_id / review_token / scope / scope_hash / spec_hash / reserved`；scope 含 `inputs / candidates / policies / templates` 四组快照。
重复读取、跳过中段、只读候选而未读原输入，都不能满足全文覆盖门禁。
评审身份的 session_id 和 agent_id 都必须不同于作者，且宿主回执声明 `can_review=true`。
审核分配不能转给另一个身份；中断评审须保留原记录，改用新任务重新走候选与评审流程，当前版本没有评审迁移/恢复 API。

`verify_gate` 再次校验输入、全部规范、模板、验证脚本、候选、作者/评审者宿主回执、停止回执与评审回执，返回：
`schema_version / task_id / stage / approved / spec_hash / reviewer_session / scope_hash / candidates / review_evidence / inputs / registry / config_hash / writer_host / reviewer_host / stop_evidence`。
`gate_for_artifact` 另返回 `artifact` 快照，且只匹配规范化后的精确路径；同内容的另一个文件不获授权。
这些字段可由发布者保存为审计摘要并复核规范和证据；摘要本身不是签名，也不授权绕过当前门禁。
若发布后删除 staging，发布流程须先保存对应候选字节/哈希、评审回执及最终路径映射，后续质量复验由发布层实现；本模块的实时门禁仍要求原候选存在。

## 宿主会话与停止回执

宿主会话回执结构：

```json
{
  "kind": "host-session", "session_id": "actual-session-id",
  "agent_id": "actual-agent-id", "host": "actual-host",
  "event_id": "actual-host-event", "issuer": "trusted-adapter",
  "independent_context": true, "context_history": "none",
  "can_write": true, "can_review": true
}
```

回执中的事件必须来自真实适配器调用结果。用于接收交接的新会话回执还须包含 `handoff_id`，其值等于 `handoff()` 返回的 ID。

停止回执含 `kind="host-stop"`、`state="completed"|"stopped"|"failed"`、真实 `event_id`，以及完全匹配任务的 `task_id / lease / session_id / agent_id / issuer`。
租约为 900 秒；过期不会自动证明旧执行体已停止，也不会自动允许重新领取。
`recover(task_id, lease, {'receipt_path': stop_path})` 仅在真实停止回执成立后转为 stopped；新尝试必须使用新任务 ID，不复用原 lease。
候选仅允许写入 `_工作区`，提交候选时同样必须附停止回执。

## 评审回执

每个评审回执是有界 JSON，包含：

```text
kind = "semantic-review"
task_id / spec_hash / reviewer_session
verdict = "pass" 或 "fail"
candidate_hashes = scope.candidates 中各 SHA-256，顺序一致
scope = prepare_review 返回的完整 scope 对象
scope_hash = prepare_review 返回的 scope_hash
findings = [{check, path, result, detail}, ...]
```

`findings` 必须覆盖 `source_fidelity / coverage / pedagogy / relations` 四项；每项记录范围内的精确绝对 `path`、`result="pass"|"fail"` 和非空的具体判断 `detail`。
适用性本身也须说明，例如关系尚不适用时写清当前阶段与原因。
通过回执不得包含 fail finding；失败回执必须包含至少一个 fail finding。
这些字段不替代人工/模型语义审查，只防止空白布尔值盖章和旧版本回执错用。

## 交接与命令行

`handoff(session_id, payload)` 接受最多 8192 字节的元数据对象，返回 `handoff_id`，不自行生成新会话。
旧会话有 ready 任务、未确认停止的租约或未完成评审时禁止交接；stale 状态不会隐藏尚未停止的旧租约。
`accept_handoff(handoff_id, new_session_id)` 验证 payload 哈希、新会话真实回执的关联、不同 Agent ID，并再次检查旧租约；随后关闭旧会话并向新会话计入交接内容额度。
伪造不同字符串 ID 不等同于真实新会话，真实性仍由受信适配器承担。

命令行统一使用：

```text
python scripts/bounded_runtime.py --course COURSE COMMAND --request bounded-request.json
```

`COMMAND` 对应 `register-session / create / spec / claim / read / candidate / prepare-review / read-review / review / verify / gate-for-artifact / recover / handoff / accept-handoff`；请求 JSON 字段名等同上述 Python 方法参数。
`status --after 0 --limit 20` 只返回分页状态，`registry --stage knowledge` 返回有界规范清单。
命令行错误输出短 JSON 并返回状态码 1，不将正文回传调度器。

验证：`python -m unittest discover -s tests -p test_bounded_runtime.py -v`。
