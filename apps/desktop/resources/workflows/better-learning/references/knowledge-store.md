# 可重建的全文检索与来源覆盖

`scripts/knowledge_store.py` 把课程现有 JSON/JSONL、知识分片、提取块与来源转写投影到 `_工作区/知识检索.sqlite3`。SQLite 只是可删除重建的缓存；知识索引、覆盖台账及原正文仍是权威文件。脚本不会调用模型、改写知识或生成语义评价。

## 建立与查询

```text
python -X utf8 <scriptsRoot>/knowledge_store.py --course COURSE build
python -X utf8 <scriptsRoot>/knowledge_store.py --course COURSE audit
python -X utf8 <scriptsRoot>/knowledge_store.py --course COURSE query --term 线性算子 --chapter KC-001 --source SRC-001 --status verified --max-items 8 --max-tokens 12000
python -X utf8 <scriptsRoot>/knowledge_store.py --course COURSE read --key knowledge:K-000001 --max-tokens 12000
python -X utf8 <scriptsRoot>/knowledge_store.py --course COURSE read --key knowledge:K-000001 --metadata
```

`query` 默认检索 `knowledge`。还可选 `chapter`、`source`、`extraction`、`coverage`、`metadata`。多个 `--term` 按 Unicode casefold 后作字面子串 AND 匹配；知识查询搜索完整正文及登记的 `title`、`terms`、`aliases`。中文别名无需分词，但没有自动同义词推断、向量召回或语义排序。结果按稳定 key 排序。章节、来源、状态过滤同时生效；知识的来源过滤通过其 `source_refs` 实现。缺省不输出巨大的索引条目，完整元数据也通过 `--metadata` 分页读取。

全文保存在 SQLite 内，当前子串查询会扫描符合范围的记录，并非 FTS 或向量检索。输出预算不等于计算时间、索引体积或进程内存上限。大型课程宜先按来源或章限定范围。

## 完整分页契约

每个 item 包含 `key`、`kind`、`field`、`text`、`range: [start,end]`、`total_chars` 和该字段完整内容的 `content_hash`。区间左闭右开，单位为 Python Unicode codepoint；不是 UTF-8 字节、UTF-16 单元或模型 token。

`max_items` 为 1..100；`max_tokens` 为 1024..1000000。这里的 `returned_tokens` 是为兼容参数命名而保留的字段，**实际值是完整紧凑 JSON 响应的 UTF-8 字节数**，包括 JSON 转义、所有 item 元数据、计数字段和续读游标，不是真实 tokenizer 计数。`token_method` 明确返回 `utf8_bytes_upper_bound_not_actual_tokens`。成功 CLI 输出不另加换行，所以其 UTF-8 字节数与计数一致；错误响应不纳入成功分页预算。

必须持续传回 `next_cursor`，直到 `has_more=false` 且 `next_cursor=null`。`truncated=true` 与 `has_more=true` 同义，仅表示这次预算内尚未返回全部匹配内容，不能宣称已完整读取。不得把第一批命中、已提取页数或已返回字符数当成全资料完成率。重组时按 key 和连续 range 拼接并核对完整哈希。空正文也会返回一条 `[0,0]` 记录。

```text
python -X utf8 <scriptsRoot>/knowledge_store.py --course COURSE read --key knowledge:K-000001 --max-tokens 12000 --cursor 上次返回的next_cursor
```

游标绑定索引内容版本、关键词与过滤条件、读取字段。续读可调整预算，但不得换查询条件。权威输入改动后先报 `INDEX_STALE`；重建后旧游标仍会被拒绝。游标是供同一调用方续读的非签名编码，不是授权凭据。若单条记录的必要元数据及至少一个字符也放不下，返回 `BUDGET_TOO_SMALL_FOR_RECORD`，不会静默省略记录或假报完成。

## 正文和来源位置

知识区间只接受通过结构解析的 `BL-K:BEGIN/END`，不按标题或相邻锚点猜测。返回完整实体片段（包含边界标记及入口锚点）。有索引却无显式知识边界时，正文为空、元数据为 `missing_explicit_boundary`，audit 不能判定机械覆盖完成；损坏或重复的边界直接阻止构建。

来源单元优先使用经过现有转写解析器校验的正文，否则保留所有提取块的原序拼接。提取块仍单独以 `extraction:SRC-ID:UNIT-ID:序号` 保存，不会因转写存在而丢弃。元数据 `spans` 提供实际文件及位置；提取块和知识分片采用禁用换行转换的 UTF-8 解码位置，来源转写遵循现有解析器的 universal newline 规则并明确标记 `newline_mode`。转写正文位置由结构捕获组确定，不通过搜索相同字符串推断。

每次读取重新核对所有已登记依赖的 SHA-256，包括原始来源文件、索引、台账、映射、分片、提取块和转写。文件被删除、截断、修改，或构建时缺失的权威索引后来出现，均令缓存失效。构建结束前再次核对输入，然后原子替换数据库。只检测课程索引登记的资料范围；不能发现用户尚未盘点的额外文件。

## 来源与知识覆盖矩阵

```text
python -X utf8 <scriptsRoot>/knowledge_store.py --course COURSE query --kind coverage --source SRC-001
python -X utf8 <scriptsRoot>/knowledge_store.py --course COURSE query --kind coverage --status needs_review
python -X utf8 <scriptsRoot>/knowledge_store.py --course COURSE read --key coverage:SRC-001:U00001
python -X utf8 <scriptsRoot>/knowledge_store.py --course COURSE read --key knowledge-coverage:K-000001
```

每个来源单元同时保存覆盖台账的 `knowledge_ids` 和知识索引反向登记的 `registered_knowledge_ids`。每个知识项的矩阵保存 `source_refs`、覆盖台账反向声明 `ledger_claims` 及不存在于当前映射的 `invalid_source_refs`。这两边分别展示原始登记，不自动修补不一致。

| state | 含义 |
| --- | --- |
| `unprocessed` | 尚无完整转写或知识覆盖声明；提取成功不等于转写完成 |
| `transcribed` | 转写完整，但尚未登记知识覆盖 |
| `incorporated` | 台账 covered，知识存在、有明确正文边界、状态 verified，且双方来源关联一致 |
| `excluded` | 台账 duplicate 或 non_teaching，必要理由/证据及关联机械检查通过 |
| `needs_review` | 不一致、未解决、知识正文缺失、转写未完整、宿主任务重开等问题 |

宿主转写任务存在时，非终态单元不能因旧转写还在而被视为完成。missing mapping、孤立台账行、无正文知识项、无效知识来源引用都会使 audit 的 `mechanical_coverage_complete=false`。全部转写完成但没有知识覆盖，也不能通过这个指标。

覆盖台账只声称整个来源单元与知识的关系，没有精确字符覆盖区间，因此 `covered_ranges=null`；`available_ranges` 只表示可读取的字符范围。脚本不编造已理解或已纳入知识的文本 span。`semantic_quality_verified` 始终为 false；此工具不验证视觉识别真实性、公式正确性、概念解释质量或排除理由是否合理，也不代替课程交付验收。

## 验证边界

```text
python -X utf8 -m unittest discover -s tests -p test_knowledge_store.py -v
```

测试包含超过百万字符的重复中文/emoji/转义字符正文，逐页核验预算、连续范围、游标进度和无损拼接；另测别名与范围过滤、覆盖五态、双向关系、源文件删除/截断失效、输入版本变更、无边界不猜测等。规模用例只记录字数、页数、UTF-8 响应字节数和实际耗时；它是机械扩展性与分页测试，不是百万字真实教材的语义召回 benchmark。
