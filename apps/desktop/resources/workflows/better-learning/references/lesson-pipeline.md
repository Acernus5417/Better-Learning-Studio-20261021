# 讲义生成（主代理）与核心卡片收口

以下章级主代理规则适用于默认模式。显式 `bounded-v1` 改用 [有界生成接入](bounded-pipeline.md) 的逐节输入、蓝图及独立审核；原 parts-v1 装配和提交检查保留，批次派发规则保持不变。

入口条件：全部资料转写完成、知识分片完整且知识条目 verified，`知识内容.md` 已通过 `assemble_knowledge.py --check`；学习路径已落盘，章节索引的 lessons 列出稳定 ID、title、order、path、status 和 path_excerpt（或路径中带该 lesson ID 的独立段落）。路径片段应包含本章目标、先修、顺序、过关标准，不是整份路径副本。

**讲义不再并发派发子 Agent**：每章由主代理本人写作，脚本负责输入包、装配、校验与提交。

原生 Studio 的讲义提交与卡片定稿分别固定调用 `course_workflow run-step lesson-commit` 和 `cards-finalize`。宿主验证候选后，以独立无工具、完整日志的当前模型请求完成语义规划和审核，最多一轮修复；本地脚本的 commit/finalize 仍是内容验收器，不代替宿主排版环节。排版只存入 `.betterlearning/presentation/`，不重写正文、身份、链接或学习状态。新课的阶段验收要求每个单元都有通过或基础排版终态；排版失败保留已合格正文，工具详情明确报告基础排版数量。重复宿主步骤复用通过的结果，仅重试未通过单元；旧完成课程不强制重排。卡片核对和元信息在阅读时按需展开，关闭颜色仍保留折叠。

## 一、章级输入包

```text
python -X utf8 <scriptsRoot>/lesson_tasks.py --course COURSE prepare
```

每章生成 `_工作区/讲义输入/<L-ID>/task.json` 及其输入文件（学习需求、路径片段、知识片段、前置知识片段、`parts/Sxxx/`）。主代理只转发/读取这些路径；manifest 已包含 canonical link 字面量、预留 EX ID、本事务的 graph policy / registry revision、章节规范与模板的绝对路径，模型只能消费 manifest 里给出的身份与路径。

manifest 权限与转写阶段一致：**只读正文、只写片段**；`agent_can_write_system_regions: false`，`sections[].anchor_literal` 与 `system_slots` 只说明脚本会插入什么，写作者不得自己写 `BL-*`、`ID ^ID` 或 `^K/^EX`。链接按矩阵只分发可用关系：分配知识的 canonical K 链接、前置知识 canonical K 链接、本章学习步骤链接，以及已登记题源练习的 `exercise_sources`。

EX ID 预留数量默认为 `max(24, 6×本章知识数+12)`，可在章节索引设置 exercise_count；它是可用 ID 池，不是练习数量要求；未使用的预留 ID 保持 reserved，不构成有效关系目标。

**模板组合契约**：写作前读 `assets/templates/learning-chapter.md`（`manifest.template`）共用骨架，再只读 `manifest.teaching_design` 选中的学科、活动、目标模式；`knowledge` 中的覆盖用于对应知识小节，其余用 `lesson`。按 [学科路由](subject-routing.md) 维护 `_工作区/教学设计.json`。模板与有效选择哈希已纳入输入快照；所选资源变化需重新核对，未选学科的改动不会单独使本章过期。

**单元契约**：新课程在 prepare 前按 [教学粒度规范](teaching-granularity.md) 写 `_工作区/教学单元.json`。manifest.teaching_units 与 sections[].teaching_unit 传递分组、目标、深度、标准和停止依据。一个 knowledge section 可覆盖多个 K，各 K 的真实标题在 section.json.knowledge_headings 登记；公共内容不重复。显式单元的预留 EX ID 按 section 独占分配，实际练习可在单元/章首/章末；result.unit_reviews 映射全部目标到实际练习与反馈。配置/策略变化纳入快照，不影响其他讲有效设计的独立指纹。旧课程无配置保留一 K 一 section。

## 二、主代理逐章写作

按 lesson order **一次一章**：读 `task.json` → 读 [章节规范](chapter-writing.md) 与模板 → 按 sections 写片段与回执 → 写 `result.json` → `commit`。写完立即提交再进入下一章；不把多章内容同时装入对话。写作细则见 [章级写作策略](lesson-writing-policy.md)。

```text
python -X utf8 <scriptsRoot>/lesson_tasks.py --course COURSE commit --lesson L-01
python -X utf8 <scriptsRoot>/lesson_tasks.py --course COURSE status
```

commit 的流程没有任何一步可以被"看起来差不多"绕过：

1. **输入校验**：知识/路径/需求/模板/规范/注册表版本与输入包快照一致（不一致即 `STALE_INPUT`）；逐节检查回执、文件、围栏与公式边界、允许链接；片段中出现 `BL-*`、`ID ^ID` 锚点或 `^K/^EX` 直接报 `RESERVED_SYSTEM_MARKUP`。
2. **目标复核与装配**：显式单元先检查 unit_reviews 的目标覆盖、实际练习映射、反馈定位与复核说明；按 section 清单合并片段，插入 `BL-L`、`BL-TEACH`、`BL-EX` 边界与该实体的入口锚点；练习区间由 `result.json` 的 `exercises[].heading` 定位，标题缺失或不唯一即 `INVALID_OUTPUT`。
3. **关系渲染与阶段性校验**：在候选文件集（虚拟完整文件集）上推导关系、渲染 `BL-REL`，检查结构、链接权限、投影相等、KP/SRC 约束与 DEP 无环。
4. **提交**：写入事务日志后按文件原子替换；任一步失败按备份回滚。提交成功后把实际使用的练习登记进 `_工作区/练习索引.jsonl`（status=used）。

重复 commit 不会重复合并或追加；幂等由"相同输入得到逐字节相同输出"保证。字节、分隔符和链接检查不证明数学或教学解释正确，仍须按章节规范复核内容。

草稿未写完时 commit 返回 `PARTIAL_OUTPUT`：保存有效片段的哈希与进度，整章不标记完成，缺失片段保留待补；主代理补写后再 commit，已验证片段不会被清空（哈希变了会被拒绝）。连续失败达到 `max_attempts` 转 `needs_review`。输入快照或已保存片段哈希改变时拒绝续写，须先复核处理。

```text
python -X utf8 <scriptsRoot>/lesson_tasks.py --course COURSE check
```

`check` 校验每章状态、输入新鲜度、输出哈希与提交证据；全部通过才允许进入卡片阶段。

## 三、主代理统一生成卡片

全部讲义通过 `lesson_tasks.py check` 后，主代理按 lesson order 每次读取一章与对应知识索引，及时将候选写入 `_工作区/核心候选.jsonl`。不要一次读取全部章节，不宣称能清除已读历史。

```json
{"concept_key":"经主代理归一的概念键","knowledge_ids":["K-01","K-02"],"reason":"为何核心，引用实际目标或覆盖证据",
 "exercise_ids":["EX-L01-003"],"exercise_reason":"该题直接考查本卡覆盖的知识"}
```

同义归一是主代理的语义工作；脚本只按已确认的 concept_key 合并候选，不能自动证明两个术语同义。同一知识不得进入不同概念组。多个章节对应相同概念可合成一卡，保留所有知识去向。`exercise_ids` 必须指向 `_工作区/练习索引.jsonl` 中状态为 used、属于本卡任一知识所在讲义、且 `assesses` 与本卡知识有交集的练习；否则 `RELATION_PROVENANCE_MISSING`。

```text
python -X utf8 <scriptsRoot>/core_cards.py --course COURSE prepare
```

脚本确认全部讲义有效，统一分配稳定 `KP-章-序-01` ID，保留已有 concept_key 的 ID；输出 `_工作区/核心卡片计划.json`（含 knowledge_ids、exercise_ids 与 canonical 字面量），回写知识索引的 core/card 元数据，重建 `知识内容.md` 并重新渲染关系区。主代理根据计划、[卡片规范](core-cards.md) 和 `assets/templates/core-card.md` 统一写 `核心知识点.md`，不派卡片子 Agent。

```text
python -X utf8 <scriptsRoot>/core_cards.py --course COURSE lint      # 写前/写后自查（只读）
python -X utf8 <scriptsRoot>/core_cards.py --course COURSE finalize
python -X utf8 <scriptsRoot>/obsidian_links.py --course COURSE rebuild
python -X utf8 <scriptsRoot>/core_cards.py --course COURSE check
python -X utf8 <scriptsRoot>/validate_package.py --course COURSE --mode final
```

顺序不能颠倒：卡片会改变全课程的派生关系，`finalize` 先在 staged 相位渲染全课程关系，`rebuild` 再把 KP 转为 active 后的关系重渲一次。

**图谱冻结原则**：所有会新增实体（K / KP / EX / L / STEP）的写作**全部完成后**才执行 `rebuild`，且**只执行一次**；`rebuild` 之后只允许改不产生新实体的纯文字（改纯文字后如需刷新台账用 `refresh`）。

## 命令幂等语义表

| 命令 | 已完成时的行为 | 正确替代动作 |
| --- | --- | --- |
| `lesson_tasks prepare` | 对 `done` 讲义保持完成态并跳过输入包重建；只重建未完成的章节 | 无（不需要为刷新指纹重跑 prepare） |
| `lesson_tasks commit --lesson L` | 返回 `idempotent: true`，**不重新装配** | 刷新指纹用 `lesson_tasks.py refresh`；重写正文先按内容重新打开对应片段 |
| `lesson_tasks check` | 只读校验；`rebuild` 重渲关系区**不会**令讲义失效（按教学内容指纹判定） | 直接复跑即可 |
| `lesson_tasks refresh [--moves x.json]` | 重算 `output_hash`/`semantic_hash` 与 commit 证据并留审计 | 迁移/搬迁链接后调用一次 |
| `obsidian_links rebuild` | 幂等：关系区已一致时不改写文件；输出 `touched_documents` 与 `semantic_invalidated_lessons` | 无需重复执行 |
| `core_cards lint` | 只读；列出计划外链接（`MANIFEST_LINK_VIOLATION`）与必链缺失（`UNLINKED_REFERENCE`，warning 不阻断） | 清理用 `flatten`，缺链接用计划字面量补 |
| `core_cards flatten [--apply]` | 预览；`--apply` 才改写并写 `_工作区/卡片链接规范化记录.jsonl` | 只清理计划外链接，不动计划内必链 |
| `validate_package --mode plan` | 只读盘点：缺失交付物、容器、确认位与收尾顺序 | 写作前跑一次，不必重复 |
| `convert_materials diagnose` | 只读全景：围栏/媒体/异常单元；不修改任何文件 | 材料返工后跑一次即够 |
| `core_cards prepare` | 保留已分配 KP ID，重建计划与知识库视图 | 卡片内容变化时用它重新出计划 |
| `core_cards finalize` | 校验 KP 边界/锚点/出边/投影并保存快照 | 卡片正文改动后重跑 |

finalize 验证全局 ID、KP 边界与入口锚点、KP 出边只连 canonical K 与 active EX、关系投影键级一致，并记录全部讲义教学内容哈希、知识索引/知识库哈希、练习映射哈希、graph policy 与卡片哈希。**Obsidian 链接（边界、锚点、关系区）始终由脚本渲染**：写完卡片后运行 `obsidian_links.py rebuild` 同步关系与注册表，再 `core_cards.py check` 与 `--mode final` 复验；`package` 之后用 `--mode packaged` 复验。主代理不在正文手写这些链接。

运行时 staging 不作为知识图谱节点；最终 package 清理讲义输入与尝试目录。不要在学习包仍需修订时提前 package。
