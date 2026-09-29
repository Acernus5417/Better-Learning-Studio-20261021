# Obsidian 身份、区块与关系契约（v2）

新课程 `_工作区/课程配置.json` 使用 `link_mode: obsidian` 与 `link_schema_version: 2`。缺少 `link_schema_version` 的旧包记作 v1，本工具**不会静默升级**：旧包继续按 v1 验收，只有显式执行迁移才切换。v2 不恢复 v1 的 heading/裸文件内部链接。

## 一、链接形态

内部实体链接只有一种形态，必须带稳定块锚点：

```text
[[课程内路径#^稳定块ID|显示标签]]        例如 [[知识内容#^K-03-04|特征值]]
[[课程内路径#^稳定块ID\|表格内显示标签]]  表格单元格中的别名分隔符写成 \|
![[附件/图.png]]                       附件保留扩展名
[说明](https://example.com)             外部 URL 保持 Markdown
```

禁止：`.md` 后缀、`../`、`./`、绝对路径、目录越界、`_工作区/` 目标、heading 锚点（`#标题`）、无锚点的文件链接、table-safe 变体注入第二个目标。表格安全变体只改变分隔符写法，不产生新的关系。

## 二、稳定边界与身份锚点

每个实体区间由显式边界与入口锚点确定，程序不按 heading 或“下一个块 ID”猜范围：

```text
<!-- BL-K:BEGIN K-03-04 -->
### 特征值

K-03-04 ^K-03-04

正文……
<!-- BL-K:END K-03-04 -->
```

- 边界标记单独成行，代码围栏、行内代码与来源载荷内的同名文本一律不生效。
- 身份锚点 `ID ^ID` 必须紧接着 section 标题出现，**不得放在段落末尾**；放错位置报 `ANCHOR_NOT_AT_ENTRY`。
- 同一文件内块定义唯一；重复报 `DUPLICATE_BLOCK`。
- 缺少/交叉/未闭合边界报 `SECTION_BOUNDARY_INVALID`，不做退化照常解析。
- 嵌套只允许契约规定的组合（L 含 TEACH/EX、SOURCE 含 SRC、SRC 含 SOURCE-TEXT、PATH 含 STEP、容器/实体含 BL-REL）；其他组合直接报错。

区间种类：`K`、`KP`、`EX`、`SOURCE`（来源文档外壳）、`SRC`（来源单元）、`SOURCE-TEXT`（原文载荷）、`L`（讲义）、`TEACH`（讲义中的知识小节）、`PATH`、`STEP`、`START`、`MGMT`、`INDEX`（索引容器）、`CHAPTER`（知识章容器）、`REL`（系统关系区）。

### 谁写什么

| 角色 | 可写 | 不可写 |
|---|---|---|
| 转写成员 | 单元正文 | 任何 `BL-*`、任何块 ID、来源外壳 |
| 主代理写讲义 | 各 section 的自然片段 | `BL-*`、身份锚点、`^K/^EX` 块 ID、关系区 |
| 主代理写知识分片 | `BL-K` 边界与 `K ^K` 入口锚点 | 关系区（由渲染器生成） |
| 主代理写卡片/路径/入口 | `BL-KP`/`BL-PATH`/`BL-STEP`/`BL-START` 边界与入口锚点 | 关系区 |
| 脚本 | 边界装配、锚点落位、关系区、来源外壳、注册表 | — |

## 三、四类关系与允许矩阵

顶层四类：`NAV`（导航）、`TEACH`（教学）、`DEP`（依赖）、`SOURCE`（来源）。出边与 subtype 必须有审核记录，矩阵外的组合一律 `RELATION_TYPE_FORBIDDEN`。

| 源 | 目标 | 允许关系 |
|---|---|---|
| K | K 子集 | `DEP.prerequisite` |
| K | KP / SRC 单元 / L | `TEACH.core` / `SOURCE.evidence` / `TEACH.lesson` |
| KP | K canonical / EX | `TEACH.summarizes` / `TEACH.practice` |
| EX | K / SRC / L | `TEACH.assesses` / `SOURCE.evidence` / `NAV.owner` |
| L | K / EX / L / Path / START | `TEACH.knowledge` / `TEACH.exercise` / `NAV.previous,next` / `NAV.path` / `NAV.entry` |
| L | L（跨讲前置） | `DEP.prerequisite`；仅聚合已审核的 K 前置及双方 `lesson_ids` |
| Path | L / START | `NAV.step` / `NAV.entry` |
| START | KP / L / Path / IDX / M | `NAV.entry` / `NAV.management` |
| 管理文档 | 已登记实体 | `NAV.management`（另有 `NAV.entry` 指向 START） |
| 索引容器 / 知识章 | 其成员 | `NAV.index`；容器可 `NAV.entry` 指向 START |

硬规则：

- **K→L 目标是 Lesson 实体**，落点必须是该 Lesson 中对应 K 的 teaching occurrence；该 occurrence 注册在 K 的 locations 中，块仍是 K-ID。
- **KP→K 始终解析到 K 的 canonical location**，不得落在 teaching occurrence；KP 出边只有 canonical K、active EX、相关讲义 L（章级）与前置/后续/关联卡片，其余类型报 `KP_TARGET_FORBIDDEN`。
- **学习者文档不显示溯源与卡片入口**：`render_policy` 决定渲染范围——讲义（L/TEACH/EX）与卡片（KP）作用域不渲染 `SOURCE` 类边、不渲染指向 KP 的边，因此讲义/卡片正文与关系区都不会出现 `资料转写/` 链接；知识内容（K）作用域仍渲染 `K→SRC` 溯源。渲染器与 `check_projection` 调用同一个策略，隐藏的边不会造成投影不一致。
- **必链（`UNLINKED_REFERENCE`）**：卡片与讲义中提及前置/后续/关联卡片、相关讲义、前置知识等必链实体的名称或 ID 时，该名字必须位于同一个内部链接内；显式 ID 与必链名单内的名称未链接是 error，术语型名称（如知识标题作为普通术语出现）是 warning。关系区内的链接不参与该判定。
- **转写文件不可作为链接目标（`SOURCE_LINK_FORBIDDEN`）**：卡片与讲义中一律不得出现指向 `资料转写/` 或 SRC 实体的内部链接（含正文与关系区）；来源用文字标注。知识内容与报告类文档不受此限。
- **SRC 与其单元出度为零**（`SOURCE_NOT_LEAF`），来源文件不生成关系区、不产生系统出边。
- **DEP 必须无自环、无三节点环**，环路径整体报告（`DEPENDENCY_CYCLE`）。
- 允许矩阵内但无事实依据的边报 `RELATION_PROVENANCE_MISSING`。
- 正文、列表、表格中的活跃内部链接同样受矩阵约束：`check_scope_link_policy` 会报告未登记的目标（KP 违规报 `KP_TARGET_FORBIDDEN`）。

### 跨讲依赖与反向遗漏审计

- K→K 与新增 L→L 的 `DEP.prerequisite` 均沿用“依赖方→前置方”的方向；不更改旧 K 方向。跨讲聚合保存每个贡献知识对作为 provenance，多个知识对只产生一条讲义依赖边。若前置知识已在同一讲出现，不因它另有教学位置而强加外部依赖；多个外部位置则保留全部已登记位置。聚合后仍执行 DEP 无环检查。
- `NAV.previous/next` 仅按讲义 `order`（相同时按 ID）形成相邻链，与教学依赖独立；渲染分别标注“上一讲”“下一讲”，规范键去重。非相邻前置由 DEP 保留，不能被相邻导航替代。
- 正文解析使用讲义稳定 ID、标题、aliases、`第N讲`、中文数词及当前讲的“上一讲/下一讲”。数字优先取显式 `lesson_number`，兼容取 `order`，不猜 ID 的数字后缀。重名/重号保留候选并报 `AMBIGUOUS_REFERENCE`；未知讲号报 `UNRESOLVED_REFERENCE`。确定目标但没有已确认关系时只报 pending，不凭提及新增边。
- `resolve_lesson_references(..., rewrite=True)` 是独立正文操作：只给获授权的明确引用加稳定链接，保留表格转义，跳过代码、标题、注释及系统关系区；已有错误目标报 `REFERENCE_TARGET_MISMATCH`。它不属于关系区渲染器，也不静默重写已有错误链接。
- `audit_relations` 对照已审核知识索引独立重算跨讲依赖及相邻方向；删掉 K 边或非相邻 L 边会报告遗漏。另可输入带 `evidence_ref` 的独立证据，并扫描知识正文中的明确“依赖/前置知识”等表述；只形成 pending 候选，不自动修改 `prerequisites`。普通共现不是依赖证据。该确定性审计不承诺语义完整性或召回率，语义审核由独立环节承担。

## 四、关系区

关系区完全由脚本渲染，是可重放投影，不是知识：

```text
<!-- BL-REL:BEGIN K-03-04 -->
> [!links]- 知识关系
> **前置 · DEP**
> - [[知识内容#^K-02-01|矩阵乘法]]
>
> **核心复习 · TEACH.core**
> - [[核心知识点#^KP-03-02-01|特征值]]
<!-- BL-REL:END K-03-04 -->
```

- 分组与组内顺序固定（DEP → 学习 → 来源 → 核心复习 → 练习 → 考查 → 导航）；同一集合重复渲染必须得到逐字节相同输出。
- 没有出边的实体不显示空 callout；存在但为空的关系插槽会被删除。
- 渲染器只改 `BL-REL` 内部，绝不改正文；重复执行是幂等 no-op。
- 校验用 `observed == expected`（键级比较）判定投影一致，不只看“是否有点”。

## 五、来源载荷

来源文件外壳：`BL-SOURCE` → `BL-SRC`（每单元）→ `BL-SOURCE-TEXT`（原文载荷）。

- 载荷内容逐字保存；只有“已登记外壳 + 校验通过载荷哈希”才能豁免链接扫描。
- 载荷中出现字面 `[[...]]` 或 `<!-- BL-... -->` 不被吸收成系统关系；保留 BL 文本时做可逆转义，并在 `转写索引.json` 记录 `transforms`。
- 载荷内不得重新定义系统块 ID。
- 不允许 Agent 通过自声明 `SOURCE-TEXT` 获得任意豁免：豁免范围来自外壳与回执，不来自自述。

## 六、命令与模式

```text
python -X utf8 <scriptsRoot>/obsidian_links.py --course COURSE check --mode final
python -X utf8 <scriptsRoot>/obsidian_links.py --course COURSE rebuild
python -X utf8 <scriptsRoot>/obsidian_links.py --course COURSE rename-lesson --lesson L-01 --path 学习文档/01-新名称.md
python -X utf8 <scriptsRoot>/obsidian_links.py --course COURSE merge-knowledge --from-id K-02 --into-id K-01
python -X utf8 <scriptsRoot>/obsidian_links.py --course COURSE plan-migration
python -X utf8 <scriptsRoot>/obsidian_links.py --course COURSE apply-migration --plan _工作区/迁移计划-xxx.json
python -X utf8 <scriptsRoot>/obsidian_links.py --course COURSE rollback-migration --journal _工作区/链接迁移记录.jsonl
python -X utf8 <scriptsRoot>/validate_package.py --course COURSE --mode final
python -X utf8 <scriptsRoot>/validate_package.py --course COURSE --mode packaged
```

模式：`legacy-report` 只读盘点 v1；`staged`/`final` 是 v2 严格模式（不接受 heading 与裸文件目标）；`packaged` 核对交付文件与保留的注册表、快照，交付文件缺失中间产物也算通过。

## 七、重命名、合并与迁移

- **重命名**：保持 L/K/KP/EX ID；事务性预演（旧讲义有效、无活动成员，完成的卡片通过原快照），失败自动回滚索引与文件，重写链接后按更新后的目标集重新渲染并复验。
- **合并知识**：只做身份迁移，保留旧正文与 `merged_into`；不产生 K→K 自环或新环，教学 occurrence 不受影响；目标分片与覆盖台账由主代理复核，不能机械删正文。
- **迁移 v1→v2**：计划只使用文件内可见的旧侧栏锚点，范围无法证明时写 `UNRESOLVED_MIGRATION` 并跳过，绝不猜范围；执行前全量备份并记录 journal，校验通过才提交，失败按备份回滚。派生视图（`知识内容.md`）由分片重建而不是就地修补。每个实体的 canonical 与 teaching location 保持独立，旧路径没有残留。

## 八、Graph View 边界

Obsidian 原生 Graph View 的节点是笔记文件；块 ID 提供精确定位与机器可检验关系，不会自动成为独立图节点。需要逐知识点的独立可视图谱应另行设计原子笔记或专门的图谱视图，本版不虚称已实现。官方说明：https://obsidian.md/help/links 、https://obsidian.md/help/callouts 、https://obsidian.md/help/plugins/graph 。
