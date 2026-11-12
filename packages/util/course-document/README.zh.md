# @deepseek-ai/dsh-util-course-document

[English](README.md) | 中文

可移植的课程 Markdown 解析、源位置、链接解析，以及桌面课程库与浏览器工作台共享的版本化数据类型。

## Model Experience

本库不提供模型工具。桌面 Host 在创建引用前核验被选源文的版本；学习 Session 通过课程引用编解码器获得保存的原文、课程、路径、版本与区间。

## Use this package

`parseCourseDocument(source)` 返回带源位置的阅读树、标题、显式块、链接、标签和 YAML 属性。GFM、公式与 frontmatter 使用维护中的 mdast/micromark 包。代码、HTML、转义括号和注释不会生成 WikiLink 图边。未知 YAML 不会被重新序列化回原文。

`resolveCourseLink(from, target, paths, wiki)` 只在一门课程中解析目标。WikiLink 支持唯一 basename 回退；普通 Markdown 链接保留相对路径语义。缺失和重名歧义目标均显式返回。

`createCourseLinkResolver(paths)` 为一批链接一次建立精确路径与basename索引。返回的解析器保留`resolveCourseLink`的相对目录优先、大小写敏感及歧义候选顺序；准入文件列表变化时需要替换解析器。

## Limits

偏移为 UTF-16，版本为 UTF-8 源文 SHA-256。本库不读取文件、不授予文件权限、不持久化索引、不运行 Obsidian、不托管社区插件，也不保证兼容其所有方言扩展。Host 负责体积限制、版本保存、快照与恢复。

## Open-source dependencies

实现采用 mdast/micromark 及 GFM、math、frontmatter 扩展（MIT），以及 YAML（ISC）。许可见实际安装依赖与仓库 Studio 课程工作台文档。未包含恢复版 Obsidian 的私有业务代码。

study-notes 类型声明学习回答的投影视图；`organizeCourseNotes` 按原顺序生成可编辑的 Markdown 预览并去除完全相同的答案，保留原答措辞，不调用模型。笔记分配、核验与追加由宿主负责。

`CourseGraphData` 与 `CourseGraphNote` 传递本课文件元信息和链接目标，不包含正文或Session身份；Host负责准入与解析，阅读器负责筛选和渲染。

`CourseGraphLayout`传递可选、可重建的文件坐标和与窗口尺寸无关的视角，不包含原文内容，也不作为引用依据；Host负责校验、持久保存及课程路径准入。

`courseReadingTree` 与 `ReadingNode` 在保留原文偏移的前提下投影安全折叠框和排版分区。带有 `reading.schemaVersion: 1` 的 `CourseFileContent` 在 `document.nodes` 中传递规范化阅读树，并附带已准备的标注偏移；标题、链接、块、原文及源版本仍保持规范含义。普通Host `read`操作保留原始解析契约。界面编辑草稿时可清除可选的阅读投影；本库不拥有缓存、Worker或文件操作。
