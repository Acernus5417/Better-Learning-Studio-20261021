# Studio course workbench

English | [中文](studio-course-workbench.zh.md)

Better Learning Studio creates one Workspace per course under
`Documents/Better Learning Studio/course/<CourseId>`. Course names appear directly
in one contextual sidebar beside a persistent icon rail. The rail provides Home,
course reading and global panels such as Plugins, with Settings at its foot. Home
shows the course catalog; selecting a course opens reading and replaces that same
sidebar with its files, search and file actions. Its bottom menu switches courses.
The reading center has no second file sidebar. Home resumes the current course's
generation Session, or offers course creation when none is selected. Collapsing
the contextual sidebar leaves the icon rail available.

The caption holds the only sidebar toggle. A heading magnifier opens one search
field for course names or course-local file names and content. Course creation
keeps one top entry; Home alone resumes generation. Duplicate row, reader and
course-menu entries are removed. Content transitions respect reduced motion,
while the outer rail keeps the same coordinates, order and dimensions.

The native course API accepts a course identity and relative file paths. It
rejects parent traversal, hidden metadata access, and symlink escapes. Markdown
saves compare the expected SHA-256 version and retain before-images. Deletions
move to course-local trash. Rename first previews link edits, then validates the
preview token and retains a recovery journal before replacing individual files.
Multi-file rename is recoverable, not an atomic filesystem transaction.

The reader and Host index use `dsh-util-course-document`. The source editor uses
CodeMirror 6. The single-row 56px document header aligns with the compact brand
and contains reading history, the course title and reading/editing icons. File commands use the left
file tree’s context menu.
The reference surface offers outline, backlinks and file graph icons beside the tutor. Search uses SQLite FTS5 trigram
with literal short-query fallback. Search, backlinks and graph metadata share a rebuildable per-course index;
unchanged files reuse their indexed projection.

Saved Markdown selections show Explain, Examples, Key points, Quiz and Discuss. Studio loads the corresponding built-in skill and starts a task in the course tutor Session with the source quote. Maintain these skills under [`apps/desktop/resources/skills`](../apps/desktop/resources/skills), which Desktop packages as the application’s `resources/skills` directory. Use a `SKILL.md` with a matching `name` and a `description` in each of `study-explain`, `study-example`, `study-summarize`, `study-quiz` and `study-discuss`. When a build lacks a skill, the toolbar shows its expected path.

The tutor uses `study_skill` to list or load built-in skills, `course_read` to read current-course Markdown, and `study_show` to display visuals. Each entry in `frames` contains a course-relative image `path` or a self-contained `svg` string, plus an optional `label`. A single frame displays directly. For multiple frames, `controls` defaults to `steps`, with previous and next arrows for discrete states. `playback` adds play and pause, with timing set by `intervalMs`. Use `choices` for named alternatives and `slider` for sampled continuous parameters. Each control selects the corresponding image or SVG, and Session history renders the published media snapshot.

Manual edits are marked for review without rewriting generation validation
receipts. The existing generation resources, visual transcription process,
confirmation gates, and watchdog remain in use. Old external courses are not
silently moved. Community plugin hosting, Canvas, Bases, Sync, Publish, PDF
TextLayer/OCR quotation, and complete inline Live Preview compatibility are not
part of this basic version.

The runtime needs no external Obsidian installation. AI generation and tutoring
still require a configured model provider. This local update is not published to
GitHub or an application update channel.

Course roles are fixed. Generation offers no workspace or preset chooser, and
Settings exposes neither Agent presets nor coding-view controls. The left file
explorer uses animated folders, natural folder-first ordering, keyboard traversal
and four creation/expand/collapse icons. File commands remain in its context menu.

The reading explorer hides the legacy home, lecture, attachment and workflow-storage entries while keeping their files available to workflows, links and embeds. Reading opens an available learning document, uses the theme's CJK sans-serif stack and a separate code stack, and hides HTML comments and BL/BLS maintenance comments wrapped as inline code without changing source offsets.

The tutor's note action offers single/multiple selection and an editable Markdown preview. Preparation retains answer text in conversation order and removes exact duplicates; it does not make an additional model rewrite request. Confirmation lazily creates `笔记/<document name>-笔记.md` and later writes append to the same note. Source-path digests distinguish equal filenames. New courses have no starter note file. The learning projection publishes only final text from settled turns, excluding thinking, tools and automatic prompts. Host writes validate course, Session, source and answer identities, retain before-images, and use an operation UUID plus content hash to prevent duplicate retries. A failed save retains the draft.

Studio docks the persistent composer outside the message scroll range. Native selection feedback, fading selection tools, row colors and retained folder/reasoning/callout transitions share theme timing. Programmatic navigation and return-to-bottom animate while wheel/trackpad and streaming follow retain direct response. Reduced-motion preferences disable transitions. The approach references [Radix Collapsible](https://www.radix-ui.com/primitives/docs/components/collapsible) and reuses current primitives and CSS Grid instead of adding an animation runtime.

Imported courses preserve their own folder layout, including lecture and attachment folders. The course-switch menu offers Import course below a separator. The square dialog follows Settings proportions and keeps only its dashed drop target and top-right close icon. Dropping one folder automatically validates at least one .md file, copies regular files into a fresh course directory and Workspace, then opens reading; there is no chooser or confirmation button. Processing blocks duplicate drops and closing; failures permit another drop. Source files remain unchanged; source .studio metadata and foreign Sessions are not adopted. Source _工作区 is archived in .studio/imported-workspace and a fresh empty runtime workspace is created. Links/junctions, self-import and more than 20000 entries are rejected. Failed imports remove only their new destination; copying finishes before catalog publication.

Reading, generation, learner messages and tutor answers share the CJK sans-serif font stack and text scale. Outline navigation scrolls only the document and aligns the selected heading to its viewport top, including final headings. The brand uses an icon beside a two-line Better Learning / Studio wordmark. General Settings offers a persistent Markdown styling switch, enabled by default, that changes presentation without changing source or parsing. Heading, table and quotation styles reference [github-markdown-css](https://github.com/sindresorhus/github-markdown-css); existing mdast/GFM, KaTeX and code rendering remain in use.

Delivery uses metadata-v1 receipts: full content checks precede cleanup; packaging checks recorded file/ledger metadata, refreshes only changed artifact fingerprints, audits relocated links once and records the result. Later packaged checks read no Markdown bodies and calculate no global file hashes. This covers ordinary changes rather than cryptographic integrity. Accepted old packages can upgrade without deleted intermediates; active old courses repeat final once. See the [receipt upgrade guide](upgrade-guide/v0.2.1-rc.2/studio-delivery-receipts/guide.md).

The compact 56px reading header replaces the repeated file path with back/forward navigation beside the course title and reading/editing icons. History records document and heading destinations within the selected course, truncates forward entries after a new destination and retains unsaved-edit confirmation. All three regions use 16px corners. The always-expanded outline draws nesting guides and keeps every existing heading jump clickable. Dragging the right boundary within 72px of the frame edge requests occupant-owned closure while retaining the saved width for reopening.

Markdown styling supports Obsidian highlights and the red, orange, yellow, green, blue and purple emoji prefixes, hiding the color marker while quoting the unchanged source token. Callout types and aliases use distinct icons, colors and subtle fills; headings, table headers, quotations and code use theme-aware styling. The approach references [github-markdown-css](https://github.com/sindresorhus/github-markdown-css) and [Obsidian syntax](https://obsidian.md/help/syntax), retains the parser tree and safe React rendering, and removes decorative colors when styling is off. Course source files remain unchanged; native generation adds the presentation processing described below.

Reading projects complete details/summary structures into safe disclosure components instead of showing their tags as code. Nested bodies retain source-mapped Markdown parsing; arbitrary HTML remains inert. Learning-objective and entry sections use ordinary formatting without automatic full-section fills; other existing styles remain. Existing summary, exercise and warning sections remain controlled by the styling switch. Ordinary note disclosures retain only their chevron, and outline indentation is three quarters of its former size. The tutor's local citations are claimed for its current course reader, supporting relative paths, workspace-rooted absolute paths, file URLs, headings and lines. Outside paths, private work data, missing targets and ambiguous names never fall through to generic preview. Later clicks and reading navigation supersede slower earlier clicks.

Same-file outline, inline-link, tutor and history jumps issue a new navigation request while retaining the document instance and current scroll position, then scroll smoothly to the target. Repeated heading activation still works. File changes, explicit reload and accepted draft discard rebuild the document. Same-file navigation invalidates old selection tools and reveals folded targets independently from document reconstruction.

Native lesson commits and card finalization use a fixed semantic-v1 presentation pass before content publication. The Host requests a source-bound annotation plan and independent review in fresh, logged, tool-less sessions using the selected model, with at most one repair round per group. Complete cards remain grouped; accepted cards survive failures elsewhere. Fixed role styles, exact quotes, protected ranges, condition checks and 8%/6% highlight limits constrain adoption. Markdown bytes, links, source IDs, mastery evidence and existing content hashes remain unchanged. Optional `.betterlearning/presentation/` metadata rebinds after derived relation changes; stale teaching bindings use basic typography. New native courses require a terminal passed/basic decision for every unit, while legacy stage evidence is retained. Card metadata and checking sections default to folded reading, including when color styling is disabled. Old/imported courses are not automatically charged for reformatting; external Markdown readers show their complete source. Packaging retains the portable directory and performs no added global hashing.

Wiki alias pipes inside table cells are protected before GFM tokenization without changing UTF-16 positions. Tables retain semantic headers, wrapped long cells and local horizontal overflow for wide tables; citations and selection still refer to original Markdown.

The reading toolbar places File graph between Backlinks and the tutor. It opens the current course's file-link graph in the existing right sidebar; the vertical-more icon below sidebar collapse opens a settings card whose groups start collapsed on each opening. Expanded content scrolls below the trigger, keeping the fixed toolbar reachable; the reader header reserves the full toolbar width when the sidebar is closed. Isolated and self-only files are hidden by default, with line thickness 0.1 and link attraction 0.4. Filters support search, tags, attachments, existing notes and optional orphan files. Color groups, arrows, text fade, node/line sizes, highlight color, center/repulsion/link forces, link distance, neighborhood depth/direction and animation playback use the supplied independent graph reimplementation. Settings are saved per course, retaining saved custom values; this display makes no model calls. Clicking a real file uses the existing reader navigation. Course changes, leaving reading and sidebar closure dispose the graph frame, physics Worker and animation timers. The frame uses Studio theme colors, including an explicit dark background, and honors reduced motion.

The settings card uses Studio menu material, elevation, focus rings and themed slider tracks. Its entry and dismissal use the fast overlay fade; group bodies animate height and opacity with the standard disclosure timing. Closed bodies and dismissing cards are inert, and reduced-motion preferences remove their transitions. Each opening still starts with all groups collapsed.

The authenticated graph projection contains only course file paths, tags, timestamps and local destinations, excluding private working/hidden files and foreign Sessions. Duplicate file destinations are collapsed. Input limits are 2000 Markdown files, 64 MiB of text, 5000 included files and 50000 unique file destinations; the visible graph is capped at 5000 nodes. Unreferenced attachments are omitted. YAML property WikiLinks and aliases participate in graph relationships without changing source-link rename semantics. The optional display does not edit Markdown or generation evidence.

Generated/imported public file changes prepare the graph in the background. When a saved graph exists, opening the view first shows its last-known relationships, positions and camera, then verifies source changes and updates the result. An unchanged verification retains the current layout. Missing or invalid caches rebuild; the first-ever index still depends on course size. Opening a file or creating an AI quotation continues to verify its current source.

Course reads use a byte-bounded cache and one queued Host parser Worker. Conditional `view` replies omit unchanged trees; the existing `read` action keeps its canonical document contract. The private `.studio/index/course.sqlite` cache stores source-bound metadata and FTS rows, updates changed files, and survives Host restarts. Watch notifications invalidate affected paths; metadata checks remain the fallback. Saves, rename commits and saved selections still freshly verify source versions. Parsing, caches and indexes make no model calls and do not alter generation receipts or course Markdown.

The reading projection shares its safe disclosure normalization with the Host. Reading does not construct a hidden CodeMirror instance or reparse unchanged source; stable reader content skips unrelated shell updates. Large documents mount complete semantic blocks in batches, while ordinary documents keep their original structure. Nearby formulas and folded answers prepare on demand, and mounted content remains available. Navigation prepares preceding blocks and formula heights before one smooth scroll; native find, select-all and printing finish the content they need. Same-source decorations can refresh without replacing drafts. This is progressive rendering, not a virtual reader that recycles selected text.
