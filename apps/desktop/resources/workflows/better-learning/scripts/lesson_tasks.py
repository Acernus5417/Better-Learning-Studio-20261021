"""Main-agent lesson writing: per-lesson input packages and snapshot-gated commits."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

from _common import Transaction, atomic_text, inside, read_json, read_jsonl, sha256, write_json, validation_run
from entity_sections import SectionError, parse_sections
from entity_registry import GRAPH_POLICY_VERSION, Registry, is_v2, teaching_section_id
from obsidian_links import (LEGACY_BLOCK_RELATIONS, block_ids, build_map, entity_section,
                            legacy_block_section, render_wikilink, sync_candidate,
                            validate_candidate, validate_document, validate_links,
                            validate_reference_links)
from relation_renderer import apply_edits
from templates import hash_of as template_hash
from teaching_design import resolve as resolve_teaching, fingerprint as teaching_fingerprint
from teaching_units import resolve as resolve_units, fingerprint as units_fingerprint, validate_result as validate_unit_result

LEDGER = '_工作区/讲义任务.json'
INDEX = '_工作区/章节索引.json'
ANCHOR_LINE = re.compile(r'^[ \t]*[A-Za-z][A-Za-z0-9-]*[ \t]+\^[A-Za-z0-9-]+[ \t]*$\n?', re.M)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


REL_SPAN = re.compile(r'[ \t]*<!-- BL-REL:BEGIN[^>]*-->.*?<!-- BL-REL:END[^>]*-->\n?', re.S)


def semantic(text):
    """Teaching content only: derived relation regions and identity anchors excluded.

    Works on whole documents and on single knowledge fragments, so re-rendering
    relation regions never invalidates teaching content.
    """
    text = REL_SPAN.sub('', text)
    if '<!-- BL-' not in text:
        return LEGACY_BLOCK_RELATIONS.sub('', text)
    try:
        index = parse_sections(text, None, strict_registry=False)
    except SectionError:
        return LEGACY_BLOCK_RELATIONS.sub('', text)
    edits = [(section.start, section.end, '')
             for section in index.sections.values() if section.kind == 'REL']
    stripped = apply_edits(text, edits) if edits else text
    return ANCHOR_LINE.sub('', LEGACY_BLOCK_RELATIONS.sub('', stripped))


def document(course, name):
    direct = course / name
    return direct if direct.exists() else course / '课程文档' / name


def step_for_lesson(course, lesson_id):
    """Path step that schedules this lesson, from the path index (never guessed)."""
    path_file = course / '_工作区/路径索引.json'
    data = read_json(path_file) if path_file.exists() else {}
    for step in data.get('steps', []):
        if lesson_id in step.get('lessons', []):
            return step['id']
    index = read_json(course / INDEX)
    for item in index['lessons']:
        if item['id'] == lesson_id and isinstance(item.get('order'), int):
            return f"{data.get('path_id', 'P-MAIN')}-S{item['order']:03d}"
    return None


def validate_frontmatter(text, lesson):
    match = re.match(r'\A---\n(.*?)\n---(?:\n|$)', text, re.S)
    if not match: raise ValueError('Missing lesson frontmatter')
    fields = {}
    for key in ('type', 'id', 'title', 'order', 'status'):
        values = re.findall(r'^' + key + r':[ \t]*(.*?)[ \t]*$', match[1], re.M)
        if len(values) != 1: raise ValueError('Missing/duplicate frontmatter field: ' + key)
        value = values[0]
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '\"\'': value = value[1:-1]
        fields[key] = value
    if (fields['type'] != 'lesson' or fields['id'] != lesson['id'] or not fields['title'].strip()
            or fields['order'] != str(lesson['order']) or fields['status'] != 'complete'):
        raise ValueError('Invalid lesson frontmatter identity/type/status/order')


def snapshot(course, lesson):
    index = read_json(course / INDEX)
    all_knowledge = read_jsonl(course / '_工作区/知识索引.jsonl')
    knowledge = [k for k in all_knowledge
                 if lesson['id'] in k.get('lesson_ids', []) and k.get('status') != 'merged']
    if not knowledge: raise ValueError('Lesson has no assigned knowledge: ' + lesson['id'])
    if any(k.get('status') != 'verified' for k in knowledge): raise ValueError('Assigned knowledge must be verified')
    chapters = {c['id']: c for c in index['chapters']}
    assigned = {k['id'] for k in knowledge}
    required = {dep for k in knowledge for dep in k.get('prerequisites', [])} - assigned
    prerequisites = [k for k in all_knowledge if k['id'] in required]
    if {k['id'] for k in prerequisites if k.get('status') == 'verified'} != required:
        raise ValueError('Missing/unverified prerequisite knowledge')
    registry = Registry(course)
    legacy = not is_v2(course)
    canonical_text = document(course, '知识内容.md').read_text(encoding='utf-8')
    slices, prerequisite_slices = {}, {}
    for k in knowledge + prerequisites:
        if legacy:
            section = legacy_block_section(canonical_text, k['id'])
        else:
            try:
                section = entity_section(canonical_text, 'K', k['id'], registry)
            except SectionError as exc:
                raise ValueError(f'SECTION_BOUNDARY_INVALID: 知识 {k["id"]} 缺少显式边界：{exc.message}') from exc
        if not section.strip(): raise ValueError('Knowledge needs stable block: ' + k['id'])
        (slices if k['id'] in assigned else prerequisite_slices)[k['id']] = semantic(section)
    records = [{key: value for key, value in k.items() if key not in
                {'core', 'core_reason', 'card_id', 'card_anchor', 'concept_key'}} for k in knowledge]
    path_text = document(course, '学习路径.md').read_text(encoding='utf-8')
    if not path_text.strip(): raise ValueError('学习路径必须完成并落盘')
    excerpt = lesson.get('path_excerpt')
    if not excerpt and not legacy:
        step_id = step_for_lesson(course, lesson['id'])
        if step_id:
            try:
                excerpt = entity_section(path_text, 'STEP', step_id, registry)
            except SectionError:
                excerpt = None
    if not excerpt:
        match = re.search(r'^#{1,6}[^\n]*\b' + re.escape(lesson['id']) + r'\b[^\n]*\n.*?(?=^#{1,6}\s|\Z)', path_text, re.M | re.S)
        excerpt = match.group(0) if match else None
    if not excerpt: raise ValueError('章节索引须含 path_excerpt，或学习路径中有带 lesson ID 的 BL-STEP 段落')
    requirements = document(course, '学习需求.md').read_text(encoding='utf-8')
    if not requirements.strip(): raise ValueError('学习需求不能为空')
    root = Path(__file__).resolve().parents[1]
    teaching = resolve_teaching(course, lesson['id'], [k['id'] for k in knowledge])
    units = resolve_units(course, lesson['id'], knowledge)
    if units['configured'] and legacy:
        raise ValueError('Teaching units require v2 course migration before prepare')
    spec = {'snapshot_version': 2,
            'fragments': {k: digest(v) for k, v in slices.items()}, 'records': digest(records),
            'prerequisites': {k: digest(v) for k, v in prerequisite_slices.items()},
            # Teaching content only: relation regions are a derived view, so their
            # re-render (cards, Obsidian rebuild) must not invalidate a chapter.
            'path_hash': digest(semantic(excerpt)),
            'requirements_hash': sha256(document(course, '学习需求.md')),
            'attachments': {p: sha256(inside(course, p)) for p in lesson.get('attachments', [])},
            'lesson': digest({k: lesson[k] for k in ('id', 'path', 'title', 'order', 'path_excerpt', 'exercise_count') if k in lesson}),
            'policy': sha256(root / 'references/lesson-writing-policy.md'),
            'parts_protocol': sha256(root / 'scripts/lesson_parts.py'),
            'writing_spec': sha256(root / 'references/chapter-writing.md'),
            'template': template_hash('lesson'),
            'teaching_design': teaching_fingerprint(teaching),
            'teaching_units': units_fingerprint(units),
            'graph_policy_version': GRAPH_POLICY_VERSION,
            # Identity of the entities a chapter may link, not the whole registry:
            # registering cards or exercises later must not stale teaching content.
            'execution_profile': read_json(course / '_工作区/课程配置.json').get('execution_profile', 'legacy'),
            'identity': digest({'knowledge': sorted(k['id'] for k in knowledge),
                                'lessons': sorted([l['id'], l.get('path', '')]
                                                  for l in index.get('lessons', []))}),
            'link_schema_version': 1 if legacy else 2}
    return {'input_hash': digest(spec), 'hashes': spec, 'slices': slices, 'knowledge': knowledge,
            'prerequisite_slices': prerequisite_slices, 'prerequisites': prerequisites,
            'path_excerpt': excerpt, 'requirements': requirements, 'teaching_design': teaching,
            'teaching_units': units}


def lesson_links(course, lesson, snap, mapping, registry_obj):
    """Minimal capability list: every literal comes from a reviewed relation."""
    from relation_renderer import render_entity_link
    legacy = not is_v2(course)
    lid = lesson['id']
    links, allowed = {}, []
    links['knowledge'] = {}
    for kid in lesson['knowledge_ids']:
        location = registry_obj.canonical(kid) if registry_obj.has(kid) else None
        if legacy or location is None:
            links['knowledge'][kid] = render_wikilink(mapping['knowledge'], block=kid)
            allowed.append(mapping['knowledge'] + '#^' + kid)
        else:
            links['knowledge'][kid] = render_entity_link(location, registry_obj.label(kid),
                                                         registry_obj.vault_prefix)
            allowed.append(location.path.removesuffix('.md') + '#^' + kid)
    links['self_blocks'] = {kid: '^' + kid for kid in lesson['knowledge_ids']}
    step = step_for_lesson(course, lid)
    if step and registry_obj.has(step):
        location = registry_obj.canonical(step)
        links['learning_path'] = render_entity_link(location, '本章学习安排', registry_obj.vault_prefix)
        allowed.append(location.path.removesuffix('.md') + '#^' + step)
    else:
        links['learning_path'] = render_wikilink(mapping['learning_path'])
        allowed.append(mapping['learning_path'])
    # The rendered relation region also links the path itself (L → NAV.path).
    path_id = step.rsplit('-S', 1)[0] if step else 'P-MAIN'
    if registry_obj.has(path_id):
        location = registry_obj.canonical(path_id)
        allowed.append(location.path.removesuffix('.md') + '#^' + path_id)
    else:
        allowed.append(mapping['learning_path'] + '#^' + path_id)
    # Reserve identifiers, not a quota: workers only use IDs needed by the chapter.
    exercises = [f'EX-{lid.replace("-", "")}-{i:03d}'
                 for i in range(1, lesson.get('exercise_count', max(24, 6 * len(lesson['knowledge_ids']) + 12)) + 1)]
    lesson_path = lesson['path'].removesuffix('.md')
    allowed += [lesson_path + '#^' + ex for ex in exercises]
    if legacy:
        links['exercises'] = {ex: render_wikilink(lesson_path, block=ex) for ex in exercises}
    links['prerequisites'] = {}
    for k in snap['prerequisites']:
        location = registry_obj.canonical(k['id']) if registry_obj.has(k['id']) else None
        if legacy or location is None:
            links['prerequisites'][k['id']] = render_wikilink(mapping['knowledge'], block=k['id'])
            allowed.append(mapping['knowledge'] + '#^' + k['id'])
        else:
            links['prerequisites'][k['id']] = render_entity_link(location, registry_obj.label(k['id']),
                                                                 registry_obj.vault_prefix)
            allowed.append(location.path.removesuffix('.md') + '#^' + k['id'])
    # 相邻导航和完整跨讲教学依赖是不同关系，共用稳定实体链接。
    links['lessons'] = {}
    ordered = sorted(read_json(course / INDEX)['lessons'], key=lambda l: (l.get('order', 0), l['id']))
    position = next((index for index, item in enumerate(ordered) if item['id'] == lid), None)
    neighbours = [position - 1, position + 1] if position is not None else []
    from relation_policy import lesson_dependencies
    targets = {ordered[n]['id'] for n in neighbours if 0 <= n < len(ordered)}
    dependencies = lesson_dependencies({'knowledge': read_jsonl(course / '_工作区/知识索引.jsonl')})
    targets.update(target for source, target in dependencies if source == lid)
    for other in sorted(targets):
        if not registry_obj.has(other):
            continue
        location = registry_obj.canonical(other)
        links['lessons'][other] = render_entity_link(location, registry_obj.label(other),
                                                     registry_obj.vault_prefix)
        allowed.append(location.path.removesuffix('.md') + '#^' + other)
    # 来源（转写文件）不在讲义/卡片的链接范围内：不提供字面量，关系区也不渲染。
    # Attachments must be explicitly assigned by the orchestrator in the lesson index.
    links['attachments'] = [render_wikilink(a, embed=True) for a in lesson.get('attachments', [])]
    allowed += lesson.get('attachments', [])
    return links, list(dict.fromkeys(allowed)), exercises


def lesson_reference_targets(course, lesson, snap, links):
    """Must-link entities for one lesson.

    前置知识 / 相邻或跨讲前置章节 = error（引用类关系）；本节知识 / 本讲步骤 = warning
    （术语型出现在正文属正常，只提示可能漏链）。
    """
    path_file = course / '_工作区/路径索引.json'
    steps = {step['id']: step for step in (read_json(path_file).get('steps', []) if path_file.exists() else [])}
    targets = []
    for entry in snap['prerequisites']:
        targets.append({'id': entry['id'], 'names': [entry.get('title', '')], 'severity': 2})
    aliases = Registry(course).lesson_aliases(lesson['id'])
    for lid in (links.get('lessons') or {}):
        names = [name for name, ids in aliases.items() if ids == {lid}]
        targets.append({'id': lid, 'names': names, 'severity': 2})
    for entry in snap['knowledge']:
        targets.append({'id': entry['id'], 'names': [entry.get('title', '')], 'severity': 3})
    step = step_for_lesson(course, lesson['id'])
    if step:
        targets.append({'id': step, 'names': [steps.get(step, {}).get('title', '')], 'severity': 3})
    return targets


def insert_identity_anchor(body, entity_id):
    """Insert 'ID ^ID' after the first heading; the assembler owns this."""
    lines = body.splitlines()
    for position, line in enumerate(lines):
        if re.match(r'^#{1,6}\s+\S', line):
            return '\n'.join(lines[:position + 1] + ['', f'{entity_id} ^{entity_id}'] + lines[position + 1:])
    return f'{entity_id} ^{entity_id}\n\n' + body


def wrap_section(kind, section_id, body):
    return (f'<!-- BL-{kind}:BEGIN {section_id} -->\n\n{body.strip()}\n\n'
            f'<!-- BL-{kind}:END {section_id} -->')


def exercise_span(text, heading):
    """Span of one exercise: its heading to the next heading of the same or higher level."""
    from obsidian_links import mask_code
    visible = mask_code(text)
    matches = [m for m in re.finditer(r'^#{1,6}[ \t]+' + re.escape(heading.strip()) + r'[ \t]*$', text, re.M)
               if visible[m.start():m.start() + 1] == '#']
    if len(matches) > 1:
        raise ValueError('Duplicate heading: ' + heading)
    if not matches:
        return None
    match = matches[0]
    level = len(re.match(r'^#+', match.group(0)).group(0))
    end = len(text)
    for other in re.finditer(r'^#{1,6}[ \t]+\S', text[match.end():], re.M):
        if visible[match.end() + other.start():match.end() + other.start() + 1] != '#':
            continue
        if len(re.match(r'^#+', other.group(0)).group(0)) <= level:
            end = match.end() + other.start()
            break
    return match.start(), end


def assemble_lesson_document(course, attempt, lesson, raw_text):
    """Keep shared unit prose once; preserve each K and EX as sibling entities."""
    if not is_v2(course):
        return raw_text
    lid = lesson['id']
    receipt = attempt.get('worker_result') or {}
    exercises = receipt.get('exercises', [])
    exids = [e.get('id') for e in exercises]
    if len(set(exids)) != len(exids) or any(ex not in attempt.get('allowed_blocks', []) for ex in exids):
        raise ValueError('INVALID_OUTPUT: Invalid/duplicate reserved exercise ID')
    found_ex, found_k, output, frontmatter = set(), set(), [], ''
    for section in attempt.get('sections', []):
        saved = attempt.get('part_progress', {}).get(section['id'])
        if not saved:
            continue
        merged = '\n\n'.join(inside(course, f['path']).read_text(encoding='utf-8') for f in saved['files'])
        if section['kind'] == 'intro':
            match = re.match(r'\A---\n.*?\n---(?:\n|$)', merged, re.S)
            if match:
                frontmatter, merged = match.group(0), merged[match.end():]
        spans = []
        headings = saved.get('knowledge_headings', {})
        for kid in section.get('knowledge_ids', []):
            if kid in found_k:
                raise ValueError('INVALID_OUTPUT: Duplicate teaching knowledge: ' + kid)
            found_k.add(kid)
            span = exercise_span(merged, headings[kid]) if headings else (0, len(merged))
            if not span:
                raise ValueError('INVALID_OUTPUT: Missing knowledge heading: ' + kid)
            spans.append((*span, 'TEACH', teaching_section_id(lid, kid), kid))
        for entry in exercises:
            heading = entry.get('heading', '')
            if not isinstance(heading, str) or not heading.strip():
                raise ValueError('INVALID_OUTPUT: Exercise requires heading')
            span = exercise_span(merged, heading)
            if not span:
                continue
            exid = entry['id']
            if exid in found_ex:
                raise ValueError('INVALID_OUTPUT: Exercise heading occurs in multiple sections: ' + heading)
            if 'reserved_exercises' in section and exid not in {e['id'] for e in section['reserved_exercises']}:
                raise ValueError('INVALID_OUTPUT: Exercise ID belongs to another section: ' + exid)
            found_ex.add(exid)
            if lesson.get('teaching_units', {}).get('configured'):
                feedback = exercise_span(merged[span[0]:span[1]], entry['feedback_heading'])
                if not feedback or feedback[0] == 0:
                    raise ValueError('INVALID_OUTPUT: Missing exercise feedback heading: ' + exid)
                chunk = merged[span[0]:span[1]]
                feedback_text = chunk[feedback[0]:feedback[1]].split('\n', 1)
                if len(feedback_text) < 2 or not feedback_text[1].strip():
                    raise ValueError('INVALID_OUTPUT: Empty exercise feedback: ' + exid)
                task_text = chunk[:feedback[0]].split('\n', 1)
                if len(task_text) < 2 or not task_text[1].strip():
                    raise ValueError('INVALID_OUTPUT: Empty exercise task: ' + exid)
            spans.append((*span, 'EX', exid, exid))
        spans.sort(key=lambda v: v[:2])
        if any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
            raise ValueError('INVALID_OUTPUT: Overlapping K/EX headings; place tasks beside knowledge headings')
        edits = [(start, end, wrap_section(kind, sid, insert_identity_anchor(merged[start:end], anchor)) + '\n\n')
                 for start, end, kind, sid, anchor in spans]
        merged = apply_edits(merged, edits) if edits else merged
        if section['kind'] == 'intro':
            merged = insert_identity_anchor(merged, lid)
        output.append(merged.strip())
    if found_k != set(lesson['knowledge_ids']):
        raise ValueError('INVALID_OUTPUT: Teaching knowledge coverage differs from lesson')
    if found_ex != set(exids):
        raise ValueError('INVALID_OUTPUT: Missing exercise headings: ' + ', '.join(sorted(set(exids) - found_ex)))
    return (frontmatter.rstrip() + '\n\n' + wrap_section('L', lid, '\n\n'.join(output))).strip() + '\n'


def invalidate(course, reason):
    path = course / LEDGER
    if path.exists():
        data = read_json(path)
        for lesson in data['lessons']:
            lesson.update(status='stale', stale_reason=reason)
        write_json(path, data)
        index = read_json(course / INDEX)
        for lesson in index.get('lessons', []): lesson['status'] = 'stale'
        write_json(course / INDEX, index)
    cards = course / '_工作区/核心卡片状态.json'
    if cards.exists():
        data = read_json(cards); data.update(status='stale', reason=reason); write_json(cards, data)


def commits_of(data):
    """Commit records; older ledgers stored them under 'attempts'."""
    return data.get('commits', data.get('attempts', []))


def active_records(data):
    return [c for c in commits_of(data) if c.get('state') in {'drafting', 'running', 'produced'}]


def build_lesson_input(course, definition, row, snap, mapping, root, previous=None):
    """Write the per-lesson input package the main agent reads before writing."""
    folder = row['folder']
    lid = row['id']
    inputs = {'requirements': f'{folder}/学习需求.md', 'path': f'{folder}/路径片段.md',
              'knowledge': f'{folder}/知识片段.md'}
    atomic_text(inside(course, inputs['requirements']), snap['requirements'])
    atomic_text(inside(course, inputs['path']), snap['path_excerpt'])
    atomic_text(inside(course, inputs['knowledge']), '\n\n'.join(snap['slices'].values()))
    if snap['prerequisite_slices']:
        inputs['prerequisites'] = f'{folder}/前置知识片段.md'
        atomic_text(inside(course, inputs['prerequisites']), '\n\n'.join(snap['prerequisite_slices'].values()))
    registry_obj = Registry(course)
    links, allowed, exercises = lesson_links(course, row, snap, mapping, registry_obj)
    row['reference_targets'] = lesson_reference_targets(course, row, snap, links)
    from lesson_parts import provision
    sections, protected, resume = provision(course, folder, row, previous)
    if snap['teaching_units']['configured']:
        pools = [[] for _ in sections]
        for i, ex in enumerate(exercises):
            pools[i % len(sections)].append({'id': ex, 'owner_lesson_id': lid})
        for section, pool in zip(sections, pools):
            section['reserved_exercises'] = pool
        inputs['teaching_units'] = f'{folder}/教学单元.json'
        write_json(inside(course, inputs['teaching_units']), snap['teaching_units'])
    if resume:
        inputs['continuity'] = f'{folder}/续写摘要.json'
        write_json(inside(course, inputs['continuity']), resume)
    v2 = is_v2(course)
    sections_meta = [dict(s, directory=str(inside(course, s['directory'])),
                          receipt=str(inside(course, s['receipt'])),
                          anchor_literal=(f"{s['knowledge_ids'][0]} ^{s['knowledge_ids'][0]}"
                                          if s.get('knowledge_ids') else None),
                          anchor_literals=[f'{kid} ^{kid}' for kid in s['knowledge_ids']],
                          system_slots=['identity', 'relations'] if s.get('knowledge_ids') else [])
                     for s in sections]
    from templates import path as template_path
    manifest = {'schema_version': 1 if not v2 else 2, 'kind': 'lesson', 'author': 'main-agent',
                'lesson_id': lid, 'title': row['title'], 'order': row['order'],
                'knowledge_ids': row['knowledge_ids'],
                'graph_policy_version': GRAPH_POLICY_VERSION,
                'registry_revision': registry_obj.structure_revision(),
                'input_content_hash': snap['input_hash'],
                'inputs': {k: str(inside(course, p)) for k, p in inputs.items()},
                'policy': str(root / 'references/lesson-writing-policy.md'),
                'writing_spec': str(root / 'references/chapter-writing.md'),
                'template': str(template_path('lesson')),
                'teaching_design': snap['teaching_design'],
                'teaching_units': snap['teaching_units'],
                'result': str(inside(course, f'{folder}/{lid}.result.json')),
                'write_mode': 'parts-v1', 'sections': sections_meta,
                'links': links, 'allowed_blocks': row['knowledge_ids'] + exercises,
                'reserved_exercises': [{'id': ex, 'owner_lesson_id': lid} for ex in exercises],
                'agent_can_write_system_regions': False}
    manifest['link_manifest_hash'] = digest({'sections': sections_meta, 'links': links})
    task = folder + '/task.json'
    write_json(inside(course, task), manifest)
    row.update(manifest=task, task_hash=sha256(inside(course, task)), sections=sections,
               protected_chunks=protected, allowed_links=allowed,
               allowed_blocks=manifest['allowed_blocks'],
               link_manifest_hash=manifest['link_manifest_hash'],
               result=f'{folder}/{lid}.result.json', output=f'{folder}/{lid}.md',
               agent_may_write_system_regions=manifest['agent_can_write_system_regions'])
    row['input_hashes'] = {p: sha256(inside(course, p)) for p in inputs.values()}
    from bounded_pipeline import provision as provision_bounded
    provision_bounded(course, row, snap)
    if row.get('blueprint'):
        manifest.update(author='bounded-workers', execution_profile='bounded-v1',
                        blueprint=row['blueprint'],
                        section_specs=[s['bounded_spec'] for s in row['sections']],
                        worker_entry='bounded_pipeline.py section-task; do not read this coordinator manifest as worker input')
        write_json(inside(course, task), manifest)
        row['task_hash'] = sha256(inside(course, task))
    return row


@validation_run
def prepare(course, max_attempts=3):
    """One input package per lesson; the main agent writes the chapter itself."""
    from assemble_knowledge import require_knowledge
    require_knowledge(course)
    if max_attempts < 1: raise ValueError('Invalid pool policy')
    path = course / LEDGER
    old = read_json(path) if path.exists() else {}
    if active_records(old): raise ValueError('先确认上一章的写入已提交或已放弃，再重建输入包')
    index = read_json(course / INDEX)
    if not index.get('lessons'): raise ValueError('学习路径与 lesson 索引尚未完成')
    from obsidian_links import initialize
    initialize(course); mapping = build_map(course)
    root = Path(__file__).resolve().parents[1]
    commits = commits_of(old)
    lessons = []
    for item in sorted(index['lessons'], key=lambda l: l['order']):
        if not item['path'].startswith('学习文档/') or not item['path'].endswith('.md'): raise ValueError('Invalid lesson path')
        snap = snapshot(course, item)
        previous = next((l for l in old.get('lessons', []) if l['id'] == item['id']), {})
        keep = (previous.get('status') == 'done' and previous.get('input_hash') == snap['input_hash']
                and inside(course, item['path']).exists() and sha256(inside(course, item['path'])) == previous.get('output_hash'))
        row = dict(item, status='done' if keep else 'pending', input_hash=snap['input_hash'],
                   attempt_count=previous.get('attempt_count', 0) if previous.get('input_hash') == snap['input_hash'] else 0,
                   knowledge_ids=[k['id'] for k in snap['knowledge']],
                   teaching_units=snap['teaching_units'],
                   folder=f"_工作区/讲义输入/{item['id']}", manifest=f"_工作区/讲义输入/{item['id']}/task.json")
        if keep:
            for k in ('output_hash', 'committed_attempt', 'allowed_links', 'allowed_blocks'): row[k] = previous[k]
        item['status'] = 'complete' if keep else 'pending'
        if not keep:
            resume = None
            if previous.get('input_hash') == snap['input_hash'] and previous.get('resume_record'):
                resume = next((c for c in commits if c['id'] == previous['resume_record']), None)
                if resume: row['resume_record'] = resume['id']
            build_lesson_input(course, item, row, snap, mapping, root, resume)
        lessons.append(row)
    data = {'schema_version': 3, 'engine': 'main-agent', 'max_attempts': max_attempts,
            'lessons': lessons, 'commits': commits}
    write_json(course / INDEX, index); write_json(path, data)
    return {'lessons': len(lessons), 'pending': sum(l['status'] == 'pending' for l in lessons),
            'next': '主代理按 lesson order 逐章读取 manifest，按章节规范与模板写片段与 result.json；'
                    '写完运行 commit --lesson <L-ID>'}


def find(data, cid):
    record = next(c for c in commits_of(data) if c['id'] == cid)
    lesson = next(l for l in data['lessons'] if l['id'] == record['lesson_id'])
    return record, lesson


def register_exercises(course, lesson, result, transaction=None):
    """Exercises actually written into the chapter become 'used' relation targets."""
    path = course / '_工作区/练习索引.jsonl'
    rows = read_jsonl(path) if path.exists() else []
    index = {row['id']: row for row in rows}
    allowed = set(lesson.get('allowed_blocks', []))
    changed = False
    sources = {}
    for entry in result.get('exercises', []) or []:
        exid = entry.get('id')
        if not exid or exid not in allowed: continue
        row = index.get(exid, {'id': exid, 'owner_lesson_id': lesson['id'], 'status': 'used',
                               'assesses': [], 'source_refs': [], 'title': entry.get('heading', '')})
        row.update(owner_lesson_id=lesson['id'], status='used',
                   title=entry.get('heading') or row.get('title', ''))
        if entry.get('assesses'):
            row['assesses'] = sorted(set(row.get('assesses', [])) | set(entry['assesses']))
        if entry.get('source_refs'):
            row['source_refs'] = entry['source_refs']
        if row.get('source_refs'):
            # 仅作证据记录：讲义/卡片不链接转写文件，来源用文字标注。
            sources[exid] = row['source_refs']
        index[exid] = row; changed = True
    lesson['exercise_sources'] = sources
    if not changed: return 0
    payload = ''.join(json.dumps(index[key], ensure_ascii=False) + '\n' for key in sorted(index))
    if transaction is None:
        atomic_text(path, payload)
    else:
        transaction.write(path, payload)
    return len(result.get('exercises', []) or [])


@validation_run
def commit(course, lesson_id, preview=False):
    """Verify the main agent's chapter draft, assemble identity/links, then commit it."""
    from convert_materials import now
    data = read_json(course / LEDGER)
    lesson = next(l for l in data['lessons'] if l['id'] == lesson_id)
    if preview and lesson['status'] == 'done':
        return {'path': lesson['path'], 'text': inside(course, lesson['path']).read_text(encoding='utf-8')}
    if lesson['status'] == 'done':
        from quality_gates import enabled, check_retained
        if enabled(course):
            check_retained(course, lesson['path'])
        return {'lesson': lesson_id, 'state': 'done', 'idempotent': True,
                'hint': '该讲义已提交，重复 commit 不会重新装配。想刷新指纹（关系区重渲/搬迁后）用 '
                        '`lesson_tasks.py refresh`；想重写正文请先 reopen 对应内容。'}
    index = read_json(course / INDEX)
    mapping = build_map(course)
    output_error = ''
    transaction_committed = False
    cid = 'C-' + uuid.uuid4().hex
    a = {'id': cid, 'kind': 'main', 'lesson_id': lesson_id, 'state': 'drafting',
         'input_hash': lesson['input_hash'], 'input_hashes': lesson.get('input_hashes', {}),
         'task_manifest': lesson['manifest'], 'task_hash': lesson.get('task_hash'),
         'output': lesson.get('output'), 'result': lesson.get('result'),
         'allowed_links': lesson.get('allowed_links', []), 'allowed_blocks': lesson.get('allowed_blocks', []),
         'write_mode': 'parts-v1', 'sections': lesson.get('sections', []),
         'protected_chunks': lesson.get('protected_chunks', {}),
         'knowledge_target': mapping['knowledge'],
         'reference_targets': lesson.get('reference_targets', []),
         'agent_may_write_system_regions': lesson.get('agent_may_write_system_regions', True),
         'link_manifest_hash': lesson.get('link_manifest_hash'), 'started_at': now()}
    definition = next(l for l in index['lessons'] if l['id'] == lesson['id'])
    kind = 'STALE_INPUT'
    try:
        from assemble_knowledge import require_knowledge
        require_knowledge(course)
        current_snapshot = snapshot(course, definition)
        if current_snapshot['input_hash'] != a['input_hash']:
            kind = 'STALE_INPUT'; raise ValueError('Knowledge/path/requirements changed')
        if (sha256(inside(course, a['task_manifest'])) != a['task_hash'] or any(
                sha256(inside(course, p)) != h for p, h in a['input_hashes'].items())):
            kind = 'STALE_INPUT'; raise ValueError('Assigned inputs changed')
        from lesson_parts import collect_parts
        kind = 'INVALID_OUTPUT'
        if not collect_parts(course, a, lesson):
            kind = 'PARTIAL_OUTPUT'
            raise ValueError('章节草稿未写完；已保存片段保留，只补缺失片段')
        staged = inside(course, a['output'])
        if not staged.exists() or not inside(course, a['result']).exists():
            kind = 'WRITE_FAILURE'; raise ValueError('缺少本章合并输出或 result 回执')
        kind = 'INVALID_OUTPUT'
        result = read_json(inside(course, a['result']))
        if result.get('status') != 'complete' or result.get('lesson_id') != lesson['id'] or sorted(result.get('knowledge_ids', [])) != sorted(lesson['knowledge_ids']):
            raise ValueError('Incomplete/foreign lesson result')
        a['teaching_quality'] = validate_unit_result(lesson.get('teaching_units', {}), result,
            [b for b in a['allowed_blocks'] if b.startswith('EX-')])
        raw = staged.read_text(encoding='utf-8')
        if not raw.strip(): raise ValueError('Empty output')
        documents = {}
        if is_v2(course):
            if '<!-- BL-' in raw:
                raise ValueError('RESERVED_SYSTEM_MARKUP: 主代理草稿不得包含系统边界或关系区')
            assembled = assemble_lesson_document(course, a, lesson, raw)
            documents, _graph = sync_candidate(course, {lesson['path']: assembled}, phase='staged')
            # 禁止转写链接只对本讲义生效（知识库侧的 K→SRC 溯源保留），且优先于能力清单报错
            own = [item for item in validate_links(course, documents[lesson['path']], phase='staged',
                                                   require_targets=False, forbid_source_targets=True)
                   if item['code'] == 'SOURCE_LINK_FORBIDDEN']
            if own:
                kind = 'INVALID_OUTPUT'
                raise ValueError('; '.join(f"{item['code']}: {item['message']}" for item in own))
            # Mid-course commit: later lessons, steps and entries may not exist yet.
            problems = validate_candidate(course, documents, phase='staged', require_targets=False)
            if problems:
                kind = 'INVALID_OUTPUT'
                raise ValueError('; '.join(problems))
            blocking = [item for item in validate_reference_links(
                documents[lesson['path']], a.get('reference_targets', [])) if item['severity'] <= 2]
            if blocking:
                kind = 'INVALID_OUTPUT'
                raise ValueError('UNLINKED_REFERENCE: ' + '; '.join(
                    f"第{item['line']}行 {item['mention']} → {item['entity']}" for item in blocking[:10]))
        else:
            validate_frontmatter(raw, lesson)
            if not set(lesson['knowledge_ids']) <= set(block_ids(raw)):
                raise ValueError('Missing assigned knowledge blocks')
            issues = validate_document(course, raw, a['allowed_links'], a['allowed_blocks'],
                                       require_targets=False, phase='staged')
            if issues: kind = 'INVALID_LINK_TARGET'; raise ValueError('; '.join(issues))
            from obsidian_links import _has, link_map
            mapping = link_map(course)
            if any(not _has(legacy_block_section(raw, k), mapping['knowledge'], k) for k in lesson['knowledge_ids']):
                kind = 'INVALID_LINK_TARGET'; raise ValueError('Missing knowledge backlink in its assigned block')
            documents = {lesson['path']: raw}
        from bounded_pipeline import require_lesson_reviews
        kind = 'QUALITY_GATE_FAILED'
        reviewed = require_lesson_reviews(course, lesson, a)
        if reviewed:
            a['reviewed_artifacts'] = reviewed
        if preview:
            return {'path': lesson['path'], 'text': documents[lesson['path']],
                    'evidence': {'*': json.dumps({'goals': semantic(current_snapshot['path_excerpt']),
                                                 'knowledge': {kid: semantic(body) for kid, body in current_snapshot['slices'].items()}}, ensure_ascii=False)}}
        tx = Transaction(course, course / '_工作区/事务记录.jsonl')
        # Only this chapter is committed; other documents keep their relation
        # regions until the Obsidian rebuild step, so the knowledge base is never
        # rewritten mid-course (which would stale every remaining chapter).
        tx.write(inside(course, lesson['path']), documents[lesson['path']])
        if reviewed:
            from quality_gates import receipt_state, RECEIPTS
            quality = receipt_state(course, lesson['path'], documents[lesson['path']], reviewed, 'G6')
            tx.write(course / RECEIPTS, json.dumps(quality, ensure_ascii=False, indent=2) + '\n')
        raw_hash = sha256(staged)
        if is_v2(course):
            atomic_text(inside(course, a['output'].removesuffix('.md') + '.assembled.md'),
                        documents[lesson['path']])
        commit_bytes = hashlib.sha256(documents[lesson['path']].encode('utf-8')).hexdigest()
        semantic_digest = digest(semantic(documents[lesson['path']]))
        a.update(state='committed', commit_hash=semantic_digest, commit_bytes=commit_bytes, raw_hash=raw_hash)
        lesson.update(status='done', output_hash=commit_bytes, semantic_hash=semantic_digest,
                      committed_attempt=cid,
                      allowed_links=a['allowed_links'], allowed_blocks=a['allowed_blocks'])
        lesson.pop('resume_record', None)
        definition['status'] = 'complete'; kind = 'COMMIT_FAILURE'
        register_exercises(course, lesson, result, transaction=tx)
        lesson['attempt_count'] = lesson.get('attempt_count', 0) + 1
        a['finished_at'] = now()
        data.setdefault('commits', []).append(a)
        progress = read_json(course / '_工作区/生成进度.json')
        progress['completed_lessons'] = [l['id'] for l in data['lessons'] if l['status'] == 'done']
        for path, value in [(course / LEDGER, data), (course / INDEX, index),
                            (course / '_工作区/生成进度.json', progress)]:
            tx.write(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')
        if reviewed:
            from bounded_pipeline import continuity
            continuity(course, lesson, documents[lesson['path']], transaction=tx)
        tx.commit()
        transaction_committed = True
        kind = None
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        if kind == 'INVALID_OUTPUT' and 'INVALID_LINK_TARGET' in str(exc): kind = 'INVALID_LINK_TARGET'
        a.update(state='collected', failure_kind=kind, error=str(exc))
        output_error = str(exc)
        lesson['status'] = ('stale' if kind == 'STALE_INPUT'
                            else 'needs_review' if lesson.get('attempt_count', 0) + 1 >= data.get('max_attempts', 3)
                            else 'failed')
        definition['status'] = lesson['status']
        if kind == 'STALE_INPUT': lesson.pop('resume_record', None)
        elif a.get('part_progress'): lesson['resume_record'] = cid
    if not transaction_committed:
        if not any(c['id'] == cid for c in data.get('commits', [])):
            lesson['attempt_count'] = lesson.get('attempt_count', 0) + 1
            data.setdefault('commits', []).append(a)
        a['finished_at'] = now()
        write_json(course / LEDGER, data); write_json(course / INDEX, index)
        progress_path = course / '_工作区/生成进度.json'
        progress = read_json(progress_path)
        progress['completed_lessons'] = [l['id'] for l in data['lessons'] if l['status'] == 'done']
        write_json(progress_path, progress)
    output = {'commit': cid, 'lesson': lesson['id'], 'state': a['state'], 'failure_kind': kind,
              'saved_sections': len(a.get('part_progress', {})), 'missing_sections': a.get('missing_sections', [])}
    if kind is not None: output['error'] = output_error
    if kind and a.get('worker_result'):
        worker = a['worker_result']
        output['draft_failure'] = {'status': worker.get('status'), 'error_kind': worker.get('error_kind'),
                                   'reason': str(worker.get('reason', ''))[:500]}
    if kind is None:
        output['next'] = '本章已提交；继续下一章，全部 commit 后运行 check'
        if lesson.get('exercise_sources'):
            output['exercise_sources'] = lesson['exercise_sources']
    else:
        output['next'] = '按 failure_kind 修正草稿片段后重新 commit；已保存片段不会被清空'
    return output


@validation_run
def check(course):
    if not (course / LEDGER).exists(): return ['Missing lesson task ledger']
    data = read_json(course / LEDGER); errors = []
    if active_records(data): errors.append('有未提交的章节草稿正在处理')
    index = read_json(course / INDEX)
    definitions = {l['id']: l for l in index['lessons']}
    if set(definitions) != {l['id'] for l in data['lessons']}: errors.append('Lesson scope changed')
    for lesson in data['lessons']:
        try:
            if lesson['status'] != 'done' or definitions[lesson['id']]['status'] != 'complete': raise ValueError('Lesson not complete')
            from quality_gates import enabled, check_retained
            if enabled(course):
                check_retained(course, lesson['path'])
            current = snapshot(course, definitions[lesson['id']])
            if current['input_hash'] != lesson['input_hash']: raise ValueError('Lesson input stale')
            if current['teaching_units']['configured'] and (not lesson.get('teaching_units') or
                    units_fingerprint(current['teaching_units']) != units_fingerprint(lesson['teaching_units'])):
                raise ValueError('Lesson teaching units stale; prepare/commit required')
            path = inside(course, lesson['path'])
            text = path.read_text(encoding='utf-8')
            if lesson.get('semantic_hash'):
                # Teaching content only: re-rendering relation regions is not an edit.
                if digest(semantic(text)) != lesson['semantic_hash']:
                    raise ValueError('讲义教学内容被改动（关系区重渲不算）')
            elif sha256(path) != lesson['output_hash']:
                raise ValueError('Lesson output changed；建议重新 commit 以升级为语义指纹')
            a, _ = find(data, lesson['committed_attempt'])
            if a['state'] != 'committed' or a.get('commit_hash') not in {lesson.get('semantic_hash'), lesson['output_hash']}:
                raise ValueError('Lesson commit evidence missing')
            validate_unit_result(current['teaching_units'], a.get('worker_result', {}),
                                 [b for b in lesson['allowed_blocks'] if b.startswith('EX-')])
            # The lesson's own identity block is defined by the assembler, not by the writer.
            allowed_blocks = list(lesson['allowed_blocks']) + [lesson['id']]
            errors.extend(validate_document(course, text, lesson['allowed_links'], allowed_blocks,
                                            forbid_source_targets=True))
            errors.extend(f"UNLINKED_REFERENCE: 第{item['line']}行 {item['mention']} → {item['entity']}"
                          for item in validate_reference_links(text, lesson.get('reference_targets', []))
                          if item['severity'] <= 2)
        except (OSError, ValueError, KeyError, StopIteration) as exc: errors.append(lesson['id'] + ': ' + str(exc))
    return errors


def record_link_relocation(course, target_moves, changed_paths=None):
    """Record orchestrator-only path/link edits and refresh both fingerprints.

    Byte hashes track the delivered file; semantic hashes track teaching content
    only, so later relation-region re-renders do not invalidate a lesson again.
    """
    path = course / LEDGER
    if not path.exists(): return {'refreshed': 0, 'moves': sorted(target_moves)}
    data = read_json(path)
    if active_records(data): raise ValueError('有未提交的章节草稿，不能搬迁链接')
    definitions = {l['id']: l for l in read_json(course / INDEX)['lessons']}
    def rewrite_key(key):
        target, sep, anchor = key.partition('#')
        return target_moves.get(target, target) + (sep + anchor if sep else '')
    refreshed = []
    for lesson in data['lessons']:
        if lesson['status'] != 'done': continue
        definition = definitions[lesson['id']]
        if changed_paths is not None and definition['path'] not in changed_paths:
            continue
        current = snapshot(course, definition)
        saved_units = lesson.get('teaching_units')
        if ((saved_units and units_fingerprint(current['teaching_units']) != units_fingerprint(saved_units)) or
                (not saved_units and current['teaching_units']['configured'])):
            raise ValueError('Teaching unit design changed; refresh cannot replace prepare/commit')
        lesson['path'] = definition['path']
        lesson['input_hash'] = current['input_hash']
        file_path = inside(course, lesson['path'])
        old_hash, old_semantic = lesson['output_hash'], lesson.get('semantic_hash')
        lesson['output_hash'] = sha256(file_path)
        lesson['semantic_hash'] = digest(semantic(file_path.read_text(encoding='utf-8')))
        lesson['allowed_links'] = [rewrite_key(k) for k in lesson['allowed_links']]
        attempt, _ = find(data, lesson['committed_attempt'])
        attempt.setdefault('link_relocations', []).append(
            {'moves': target_moves, 'before': old_hash, 'after': lesson['output_hash'],
             'before_semantic': old_semantic, 'after_semantic': lesson['semantic_hash']})
        attempt['commit_hash'] = lesson['semantic_hash']
        attempt['commit_bytes'] = lesson['output_hash']
        attempt['input_hash'] = lesson['input_hash']
        refreshed.append(lesson['id'])
    write_json(path, data)
    cards = course / '_工作区/核心卡片状态.json'
    if cards.exists():
        state = read_json(cards)
        if state.get('status') == 'complete':
            from core_cards import inputs
            if changed_paths is None:
                state.update(inputs(course), cards_hash=sha256(course / '核心知识点.md'))
            else:
                from core_cards import semantic_hash
                for item in data['lessons']:
                    if item['path'] in changed_paths and item.get('semantic_hash'):
                        state.setdefault('lesson_hashes', {})[item['id']] = semantic_hash(course, item['path'])
                knowledge_path = document(course, '知识内容.md')
                if knowledge_path.relative_to(course).as_posix() in changed_paths:
                    state['knowledge_hash'] = semantic_hash(course, knowledge_path.relative_to(course).as_posix())
                for field, relative in [('knowledge_index_hash', '_工作区/知识索引.jsonl'), ('exercise_index_hash', '_工作区/练习索引.jsonl')]:
                    if relative in changed_paths and inside(course, relative).is_file():
                        state[field] = sha256(inside(course, relative))
                if '核心知识点.md' in changed_paths:
                    state['cards_hash'] = sha256(course / '核心知识点.md')
            write_json(cards, state)
    return {'refreshed': refreshed, 'moves': sorted(target_moves)}


def refresh(course, moves=None):
    """CLI wrapper: refresh lesson fingerprints after links or paths changed."""
    payload = {}
    if moves:
        payload = read_json(inside(course, moves))
        if not isinstance(payload, dict):
            raise ValueError('--moves 必须是 {旧路径: 新路径} 的 JSON 对象')
    return record_link_relocation(course, payload)


def main():
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('--course', required=True, type=Path)
    sub = p.add_subparsers(dest='command', required=True)
    q = sub.add_parser('prepare'); q.add_argument('--max-attempts', type=int, default=3)
    q = sub.add_parser('commit'); q.add_argument('--lesson', required=True)
    q = sub.add_parser('presentation-candidate'); q.add_argument('--lesson', required=True)
    q = sub.add_parser('refresh')
    q.add_argument('--moves', help='可选：{旧路径: 新路径} 的课程相对 JSON，用于搬迁后的字面量改写')
    sub.add_parser('check'); sub.add_parser('status')
    a = p.parse_args(); course = a.course.resolve()
    from convert_materials import locked
    try:
        with locked(course):
            if a.command == 'prepare': result = prepare(course, a.max_attempts)
            elif a.command == 'commit': result = commit(course, a.lesson)
            elif a.command == 'presentation-candidate': result = commit(course, a.lesson, preview=True)
            elif a.command == 'refresh': result = refresh(course, a.moves)
            elif a.command == 'check': result = {'errors': check(course)}
            else:
                data = read_json(course / LEDGER)
                result = {'engine': data.get('engine', 'main-agent'),
                          'lessons': [{'id': l['id'], 'status': l['status'], 'attempt_count': l['attempt_count'],
                                       'manifest': l.get('manifest'), 'folder': l.get('folder'),
                                       'resume_record': l.get('resume_record')} for l in data['lessons']],
                          'pending': [l['id'] for l in data['lessons'] if l['status'] != 'done'],
                          'active': [{'commit': x['id'], 'lesson': x['lesson_id'], 'state': x['state']}
                                     for x in active_records(data)]}
        from quality_gates import enabled as bounded_enabled
        if bounded_enabled(course) and a.command != 'presentation-candidate':
            report = '_工作区/讲义命令报告.json'
            write_json(course / report, result)
            print(json.dumps({'command': a.command, 'report': report,
                              'errors': len(result.get('errors', [])),
                              'failure_kind': result.get('failure_kind')}, ensure_ascii=False))
        else:
            print(json.dumps(result, ensure_ascii=False))
        return 1 if result.get('errors') or result.get('failure_kind') else 0
    except (OSError, ValueError, KeyError, StopIteration) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False)); return 2


if __name__ == '__main__': raise SystemExit(main())
