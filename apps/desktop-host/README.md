---
description: "Better Learning Studio Desktop Host workflow control, validation, recovery, and visual dispatch."
kind: "package-reference"
---

# Better Learning Studio Host workflow

English | [中文](README.zh.md)

With `BLS_WORKFLOW_ROOT` configured, the Desktop Host exposes authenticated `POST /api/better-learning/workflow` and the model-facing `course_workflow` tool. Both share one durable `_工作区/内置工作流.json` cursor. A course must be a registered workspace root or a direct child; real paths are checked. The HTTP route supports `inspect`, `initialize`, `change-model`, `start`, `complete-stage`, `pause`, `reconcile`, `resume`, and `watchdog`. Intake `confirm` remains on the model tool so it can require a saved proposal and a later direct human turn; the desktop does not yet have a separate confirmation control. The model tool additionally supports `guide`, `create-course`, `propose`, `probe`, `transcribe-batch`, and stage-bound mechanical actions. `create-course` requires a direct human turn in a workspace-root Session and creates one new direct-child directory before plan initialization.

The web listener selects a free loopback TCP port at startup, so an installed DSH instance can run at the same time. `BLS_WEB_PORT` may select a fixed port for an isolated desktop instance.

`initialize` runs the bundled plan validator before creating the cursor. The model saves an intake summary with `propose`, then `confirm` requires a direct human message in a later turn. `guide` reads a named policy section or template from the bundled application workflow. The selected model is taken from the live Session request. Each stage advances only after Host verification of saved artifacts and script receipts. A model change invalidates transcription and downstream evidence. Ordinary `inspect` is read-only; startup scan and explicit `reconcile` mark interrupted work `needs_review`.

`probe` and `transcribe-batch` start fresh DSH managed activations under the independent `better-learning-probe` and `better-learning-vision` presets. Each supplies its task persona and inherits the parent's current provider, model and reasoning effort. The probe exposes only `read_image` and `write`; transcription also exposes `read` and `edit`. Each allowlist retains the filesystem tools contributed by its preset and masks all other inherited tools, including the Host course control tool. The probe reads a random challenge and checks the saved response; the parent never reads the image or expected answer. Failure pauses the course. Transcription reserves a whole batch, records real child IDs and collects only after terminal results and resource release. Cancellation disposes the exact activation, including a child published during cancellation. Results return to the Host, which sends the batch summary without a second automatic child notification. The workflow cursor uses `schemaVersion: 1`; stage order and existing course recovery are unchanged.

The Host watchdog checks the ledger on a timer and on `subagent/end`, persists anomalies, and sends one reminder per unchanged silent set. Explicit `resume` checks the current Host roster: a live bound child blocks recovery; stopped registered attempts are collected and unregistered reservations are released before the cursor becomes ready.

The dedicated Agent preset reads application policy through `guide`; skill loading is disabled. Its persona suffix interpolates only the current model; the working-directory service supplies the current course directory as required runtime context. `run-step` executes whitelisted knowledge assembly, lesson commits, card/link operations, and packaging only in their matching stages. The composer retains DSH Session admission and attachments. Existing courses without a native cursor remain on the legacy path. The right sidebar prefers native status when present. Teaching content and semantic review remain model-authored, with Host stage validation. A real API-backed end-to-end test of this migrated path is still pending.

<a id="teaching-templates"></a>

## Teaching templates

`guide subject-routing` describes selection and inheritance; `guide teaching-catalog` lists 22 subjects, a generic fallback, nine activity modules and four goal modes. The writer saves `_工作区/教学设计.json` separately from execution configuration, based on verified materials and confirmed learner needs. `run-step teaching-resolve` returns the default selection or an optional `lesson` selection with resource paths and hashes. The Studio adapter validates every saved override against actual chapter and knowledge indexes; callers cannot supply knowledge IDs. `teaching-validate` requires explicit configuration. Native knowledge and path validation require the same check; legacy script consumers retain the absent-config fallback.

Lesson manifests carry `teaching_design`, card plans carry `teaching_designs`, and input snapshots include effective choices and selected resource hashes without installation paths. Changes to selected resources invalidate affected lessons and cards. Unselected subjects and unrelated lesson choices do not invalidate a chapter. Existing committed lessons need review and regeneration when their writing inputs change; never delete receipts to bypass freshness checks. The optional bounded pipeline receives local selected resources but remains disabled by default. Template validity does not establish teaching quality.

Maintain the four shared files under `apps/desktop/resources/workflows/better-learning/assets/templates`, and register subject/module/mode files in `subjects/catalog.json`. Run `templates.py check` and the keyless tests in `apps/desktop-host/tests/python` with the bundled Python. The workflow is application-owned; the source skill and global skill installation are not consulted at runtime. See [template routing](../desktop/resources/workflows/better-learning/references/subject-routing.md) for the configuration format.

<a id="teaching-units"></a>

## Teaching units

`guide teaching-granularity` describes grouping knowledge records by learning goals and selecting reminder, standard, deep or extension depth. New courses save `_工作区/教学单元.json` after knowledge and path planning, before `lesson-prepare`; subject selection remains in `教学设计.json`. `run-step units-resolve` requires `lesson`; `units-validate` checks every lesson against the saved knowledge assignments. Native path validation rejects invalid units. Unconfigured chapters are reported in `legacy_lessons` and keep one knowledge record per section without rewriting old content. Explicit units require v2 course identities.

Lesson manifests and card plans carry `teaching_units`. A section may cover several K records, with a nonoverlapping real title for each in `knowledge_headings`; assembly retains each TEACH identity. Exercises use that section's exclusive reserved IDs and real task/feedback headings. Commit requires `unit_reviews` to map every planned goal to an actual exercise and record reasoning, economy and limitations. Completed checkpoint headings are protected on resume. Unit changes invalidate affected lesson and card inputs; `refresh` cannot replace prepare and commit. Grouping, depth and stopping criteria add no fixed length or exercise-count requirement. Mechanical checks do not establish answer correctness or learner mastery; see the [unit specification](../desktop/resources/workflows/better-learning/references/teaching-granularity.md).
