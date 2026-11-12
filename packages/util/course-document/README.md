# @deepseek-ai/dsh-util-course-document

English | [中文](README.zh.md)

Portable course Markdown parsing, source positions, link resolution, and the
versioned data types shared by the desktop course library and browser workbench.

## Model Experience

This library exposes no model tools. The desktop Host verifies a selected source
version before creating a quote. A learning Session receives the saved quotation
and its course, path, version, and source range through the course quote codec.

## Use this package

`parseCourseDocument(source)` returns a source-mapped rendering tree, headings,
explicit blocks, links, tags, and YAML properties. GFM, math, and frontmatter use
the maintained mdast/micromark packages. Code, HTML, escaped brackets, and comments
do not create WikiLink edges. Unknown YAML is never reserialized into the source.

`resolveCourseLink(from, target, paths, wiki)` resolves against a single course.
WikiLinks support unique basename fallback; ordinary Markdown links retain
relative-path semantics. Missing and ambiguous destinations remain explicit.

`createCourseLinkResolver(paths)` builds exact-path and basename lookups once for a batch. Its returned resolver retains the same relative priority, case sensitivity and ambiguity order as `resolveCourseLink`; replace it when the admitted inventory changes.

## Limits

Offsets are UTF-16 and versions are SHA-256 of UTF-8 source text. This package
does not read files, grant filesystem access, persist indexes, run Obsidian, host
community plugins, or guarantee complete compatibility with every Obsidian
dialect extension. The Host owns size limits, CAS saves, snapshots, and recovery.

## Open-source dependencies

The implementation uses mdast/micromark and their GFM, math, and frontmatter
extensions (MIT), plus YAML (ISC). See the installed dependency licenses and
the repository's Studio course workbench documentation. No recovered Obsidian
business code is included.

The study-notes types declare the learning-answer projection view. `organizeCourseNotes` produces an editable, ordered Markdown preview and removes exact duplicate answers; it preserves answer wording and performs no model request. The Host owns note allocation, validation and append operations.

`CourseGraphData` and `CourseGraphNote` carry course-local file metadata and link destinations without document bodies or Session identities. The Host owns admission and resolution; the reader owns filtering and rendering.

`CourseGraphLayout` carries optional, rebuildable file coordinates and a window-independent camera. It contains no source content or quotation authority; the Host owns validation, persistence and course-path admission.

`courseReadingTree` and `ReadingNode` normalize safe disclosures and presentation sections without changing source offsets. A `CourseFileContent` with `reading.schemaVersion: 1` carries that normalized tree in `document.nodes` plus prepared annotation offsets; its headings, links, blocks, text and source version retain canonical meanings. The ordinary Host `read` action remains canonical. The UI may clear the optional reading projection when editing a draft; this package owns no cache, Worker or filesystem operations.
