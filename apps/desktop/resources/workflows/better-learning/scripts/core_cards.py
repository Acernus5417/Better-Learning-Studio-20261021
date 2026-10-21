"""Main-agent card consolidation: deterministic IDs, links, and freshness receipts."""
import argparse
import json
from pathlib import Path
import re

from _common import (atomic_text, inside, read_json, read_jsonl, sha256, utc_now, write_json,
                     validation_run)
from entity_sections import parse_sections
from entity_registry import GRAPH_POLICY_VERSION, Registry, document as registry_document, is_v2
from obsidian_links import (block_ids, build_map, parse_wikilinks, relation_spans, render_wikilink,
                            validate_candidate, validate_document, validate_obsidian_links,
                            validate_reference_links)
from relation_policy import ALLOWED
from relation_renderer import render_entity_link, sync_course_relations
from templates import hash_of as template_hash

STATE = '_工作区/核心卡片状态.json'


def cards_path(course):
    return registry_document(course, '核心知识点.md')


def card_sections(text):
    """{card_id: (heading, span)} for BL-KP sections of the card document."""
    index = parse_sections(text, None, strict_registry=False)
    found = {}
    for section in index.sections.values():
        if section.kind != 'KP':
            continue
        body = text[section.body_start:section.body_end]
        match = re.search(r'^#{1,6}[ \t]+(.+?)[ \t]*$', body, re.M)
        found[section.id] = (match.group(1).strip() if match else '', (section.start, section.end))
    return found


def must_link_cards(course, text):
    """Must-link entities for the card document: 前置/后续/关联卡、讲义（error）、覆盖知识（warning）。"""
    plan_path = course / '_工作区/核心卡片计划.json'
    plan = read_json(plan_path).get('cards', []) if plan_path.exists() else []
    index_path = course / '_工作区/知识索引.jsonl'
    by_id = {row['id']: row for row in (read_jsonl(index_path) if index_path.exists() else [])
             if row.get('status') != 'merged'}
    lessons = {lesson['id']: lesson for lesson in read_json(course / '_工作区/章节索引.json')['lessons']}
    sections = card_sections(text)
    registry = Registry(course)
    targets, seen = [], set()
    for entry in plan:
        card_id = entry.get('card_id')
        if card_id in seen:
            continue
        seen.add(card_id)
        heading, own_span = sections.get(card_id, ('', None))
        names = [heading, registry.label(card_id) if registry.has(card_id) else '']
        names += [by_id[kid].get('title', '') for kid in entry.get('knowledge_ids', []) if kid in by_id]
        targets.append({'id': card_id, 'names': [n for n in names if n], 'severity': 2,
                        'skip': [own_span] if own_span else []})
        for lid in (entry.get('links', {}).get('lessons') or {}):
            target = lessons.get(lid, {})
            targets.append({'id': lid, 'names': [target.get('title', '')], 'severity': 2})
        for kid in entry.get('knowledge_ids', []):
            if kid in by_id:
                targets.append({'id': kid, 'names': [by_id[kid].get('title', '')], 'severity': 3})
    return targets


def semantic_hash(course, path):
    from lesson_tasks import semantic
    return sha256_text(semantic(inside(course, path).read_text(encoding='utf-8')))


def sha256_text(text):
    import hashlib
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def inputs(course):
    lessons = read_json(course / '_工作区/章节索引.json')['lessons']
    from teaching_design import resolve, fingerprint
    knowledge = read_jsonl(course / '_工作区/知识索引.jsonl')
    teaching = {l['id']: fingerprint(resolve(course, l['id'],
                [k['id'] for k in knowledge if l['id'] in k.get('lesson_ids', []) and k.get('status') != 'merged']))
                for l in lessons}
    from teaching_units import resolve as resolve_units, fingerprint as units_fingerprint
    units = {l['id']: units_fingerprint(resolve_units(course, l['id'],
             [k for k in knowledge if l['id'] in k.get('lesson_ids', []) and k.get('status') != 'merged']))
             for l in lessons}
    exercise_index = course / '_工作区/练习索引.jsonl'
    return {'lesson_hashes': {l['id']: semantic_hash(course, l['path']) for l in lessons},
            'knowledge_index_hash': sha256(course / '_工作区/知识索引.jsonl'),
            'knowledge_hash': semantic_hash(course, registry_document(course, '知识内容.md')),
            'exercise_index_hash': sha256(exercise_index) if exercise_index.exists() else None,
            'card_template': template_hash('card'), 'lesson_template': template_hash('lesson'),
            'teaching_designs': teaching,
            'teaching_units': units,
            'graph_policy_version': GRAPH_POLICY_VERSION}


def require_lessons(course):
    from lesson_tasks import check
    from assemble_knowledge import require_knowledge
    require_knowledge(course)
    errors = check(course)
    if errors: raise ValueError('全部讲义完成且有效后才能生成卡片：' + '; '.join(errors))


def _exercise_rows(course):
    path = course / '_工作区/练习索引.jsonl'
    return read_jsonl(path) if path.exists() else []


@validation_run
def prepare(course):
    require_lessons(course)
    candidates = read_jsonl(course / '_工作区/核心候选.jsonl')
    index_path = course / '_工作区/知识索引.jsonl'
    knowledge = read_jsonl(index_path); by_id = {k['id']: k for k in knowledge if k.get('status') != 'merged'}
    if not candidates: raise ValueError('主代理须先逐章保存核心候选及 concept_key')
    exercises = {row['id']: row for row in _exercise_rows(course) if row.get('status') == 'used'}
    grouped, membership = {}, {}
    for row in candidates:
        key = row.get('concept_key', '').strip().casefold()
        if not key or not row.get('reason') or not row.get('knowledge_ids'): raise ValueError('Invalid core candidate')
        ids = set(row['knowledge_ids'])
        if not ids <= set(by_id): raise ValueError('Unknown candidate knowledge IDs')
        for kid in ids:
            if kid in membership and membership[kid] != key: raise ValueError('同一知识不得分配给多个概念组')
            membership[kid] = key
        entry = grouped.setdefault(key, {'concept_key': key, 'knowledge_ids': set(), 'reasons': [],
                                         'exercise_ids': set(), 'exercise_reasons': [],
                                         'related_concepts': []})
        entry['knowledge_ids'].update(ids); entry['reasons'].append(row['reason'])
        for related in row.get('related_concepts', []) or []:
            concept = str(related).strip().casefold()
            if concept and concept != key and concept not in entry['related_concepts']:
                entry['related_concepts'].append(concept)
        for exid in row.get('exercise_ids', []):
            entry['exercise_ids'].add(exid)
            if row.get('exercise_reason'):
                entry['exercise_reasons'].append(row['exercise_reason'])
    registry_path = course / '_工作区/核心卡片ID.json'
    registry = read_json(registry_path) if registry_path.exists() else {}
    used = set(registry.values())
    mapping = build_map(course)
    entity_registry = Registry(course)
    cards_file = cards_path(course).removesuffix('.md')
    lessons = read_json(course / '_工作区/章节索引.json')['lessons']
    orders = {l['id']: l['order'] for l in lessons}
    plan = []
    for key, entry in sorted(grouped.items()):
        kids = sorted(entry['knowledge_ids'])
        order = min(orders[lid] for kid in kids for lid in by_id[kid]['lesson_ids'])
        card = registry.get(key)
        if not card:
            n = 1
            while f'KP-{order:02d}-{n:02d}-01' in used: n += 1
            card = f'KP-{order:02d}-{n:02d}-01'; registry[key] = card; used.add(card)
        exids = sorted(entry['exercise_ids'])
        for exid in exids:
            row = exercises.get(exid)
            if row is None:
                raise ValueError('RELATION_PROVENANCE_MISSING: 练习未登记或未使用：' + exid)
            owners = {lid for kid in kids for lid in by_id[kid]['lesson_ids']}
            if row.get('owner_lesson_id') not in owners:
                raise ValueError('RELATION_PROVENANCE_MISSING: 练习不属于本卡任何知识所在讲义：' + exid)
            if not set(row.get('assesses', [])) & set(kids):
                raise ValueError('RELATION_PROVENANCE_MISSING: 练习未考查本卡知识：' + exid)
        entry.update(card_id=card, knowledge_ids=kids, exercise_ids=exids, order=order)
        entry['links'] = {'knowledge': {}, 'exercises': {}}
        for kid in kids:
            location = entity_registry.canonical(kid)
            entry['links']['knowledge'][kid] = render_entity_link(
                location, entity_registry.label(kid), entity_registry.vault_prefix)
        for exid in exids:
            location = entity_registry.canonical(exid)
            entry['links']['exercises'][exid] = render_entity_link(
                location, entity_registry.label(exid), entity_registry.vault_prefix)
        plan.append(entry)

    # --- 卡片间关系与引用清单：由已登记事实推导，写作者只能复制字面量 ---
    # 先把已分配的 KP ID 落盘，注册表才能为它们提供 canonical 落点与标签。
    from teaching_design import resolve
    designs = {l['id']: resolve(course, l['id'],
               [k['id'] for k in knowledge if l['id'] in k.get('lesson_ids', []) and k.get('status') != 'merged'])
               for l in read_json(course / '_工作区/章节索引.json')['lessons']}
    from teaching_units import resolve as resolve_units
    units = {l['id']: resolve_units(course, l['id'],
             [k for k in knowledge if l['id'] in k.get('lesson_ids', []) and k.get('status') != 'merged'])
             for l in lessons}
    write_json(course / '_工作区/核心卡片计划.json',
               {'schema_version': 2, 'graph_policy_version': GRAPH_POLICY_VERSION,
                'teaching_designs': designs, 'teaching_units': units, 'cards': plan})
    entity_registry = Registry(course)
    card_of_concept = {entry['concept_key']: entry['card_id'] for entry in plan}
    card_of_knowledge = {kid: entry['card_id'] for entry in plan for kid in entry['knowledge_ids']}
    lesson_by_id = {lesson['id']: lesson for lesson in lessons}
    for entry in plan:
        upstream = set()
        for kid in entry['knowledge_ids']:
            for dependency in by_id[kid].get('prerequisites', []):
                target = card_of_knowledge.get(dependency)
                if target and target != entry['card_id']:
                    upstream.add(target)
        related = set()
        for concept in sorted(entry.get('related_concepts', [])):
            target = card_of_concept.get(concept)
            if target is None:
                raise ValueError('RELATION_PROVENANCE_MISSING: related_concepts 指向未知概念键：' + concept)
            if target != entry['card_id']:
                related.add(target)
        if len(related) > 5:
            raise ValueError('关联卡片不得超过 5 张：' + entry['card_id'])
        entry['prerequisites'] = sorted(upstream)
        entry['related_cards'] = sorted(related)
        entry.pop('related_concepts', None)
        card_targets = entry['prerequisites'] + entry['related_cards']
        entry['links']['cards'] = {
            card_id: render_entity_link(entity_registry.canonical(card_id),
                                        entity_registry.label(card_id), entity_registry.vault_prefix)
            for card_id in card_targets if entity_registry.has(card_id)}
        lesson_ids = sorted({lid for kid in entry['knowledge_ids']
                             for lid in by_id[kid].get('lesson_ids', [])},
                            key=lambda lid: orders.get(lid, 0))
        entry['links']['lessons'] = {
            lid: render_entity_link(entity_registry.canonical(lid),
                                    entity_registry.label(lid), entity_registry.vault_prefix)
            for lid in lesson_ids[:4] if entity_registry.has(lid)}
        entry['lessons_truncated'] = max(0, len(lesson_ids) - 4)
        entry['links']['all'] = sorted(set(entry['links']['knowledge'].values())
                                       | set(entry['links']['exercises'].values())
                                       | set(entry['links']['cards'].values())
                                       | set(entry['links']['lessons'].values()))
    for k in knowledge:
        k.update(core=False); k.pop('card_id', None); k.pop('card_anchor', None); k.pop('core_reason', None)
    for entry in plan:
        for kid in entry['knowledge_ids']:
            by_id[kid].update(core=True, card_id=entry['card_id'], card_anchor=entry['card_id'],
                              core_reason='; '.join(entry['reasons']))
    atomic_text(index_path, ''.join(json.dumps(k, ensure_ascii=False) + '\n' for k in knowledge))
    write_json(registry_path, registry)
    write_json(course / '_工作区/核心卡片计划.json',
               {'schema_version': 2, 'graph_policy_version': GRAPH_POLICY_VERSION,
                'teaching_designs': designs, 'teaching_units': units, 'cards': plan})
    # Relations are derived, not patched into the knowledge file.
    from assemble_knowledge import rebuild_knowledge
    rebuild_knowledge(course)
    write_json(course / STATE, {'status': 'prepared', **inputs(course), 'cards': [e['card_id'] for e in plan]})
    return {'cards': len(plan), 'plan': '_工作区/核心卡片计划.json',
            'template': 'assets/templates/core-card.md',
            'next': '主代理按计划与卡片模板统一写核心知识点.md（只使用计划中的 canonical K/EX 字面量）；'
                    '写完先运行 obsidian_links.py rebuild 重渲全课程关系区，再运行 core_cards.py finalize、'
                    'core_cards.py check 与 validate_package.py --mode final'}


def add_relations(course, knowledge=None, mapping=None):
    """Compatibility entry: relation regions are always renderer output."""
    report = sync_course_relations(course, phase='working')
    return {'rendered': report['changed'], 'edges': report['edges']}


@validation_run
def finalize(course):
    from quality_gates import enabled, check_retained
    if enabled(course):
        check_retained(course, cards_path(course))
    require_lessons(course)
    state = read_json(course / STATE)
    if any(state.get(k) != v for k, v in inputs(course).items()):
        raise ValueError('卡片输入已变化，请重新全局整理')
    relative = cards_path(course)
    entity_registry = Registry(course)
    if is_v2(course):
        # Cards are still 'staged' here: render every callout in the staged phase,
        # otherwise the knowledge base would lack the K→KP edges that finalize checks.
        sync_course_relations(course, phase='staged')
        entity_registry = Registry(course)
    text = inside(course, relative).read_text(encoding='utf-8')
    if is_v2(course):
        index = parse_sections(text, None, strict_registry=False)
        actual = sorted(section.id for section in index.sections.values() if section.kind == 'KP')
        problems = validate_candidate(course, {relative: text}, phase='staged',
                                     forbid_source_targets=True)
        if problems: raise ValueError('; '.join(problems))
        unlinked = validate_reference_links(text, must_link_cards(course, text))
        blocking = [item for item in unlinked if item['severity'] <= 2]
        if blocking:
            raise ValueError('UNLINKED_REFERENCE: ' + '; '.join(
                f"第{item['line']}行 {item['mention']} → {item['entity']}" for item in blocking[:10]))
        relinked, graph = None, None
        from obsidian_links import sync_candidate
        if any(location.section_kind == 'KP' for entity in entity_registry.entities.values()
               for location in entity.locations):
            documents, graph = sync_candidate(course, {relative: text}, phase='staged')
            if documents.get(relative) != text:
                atomic_text(inside(course, relative), documents[relative])
                text = documents[relative]
        kp_targets = {target for (source, target) in ALLOWED if source == 'KP'}
        for entity in entity_registry.active_entities('KP', ('active', 'staged')):
            for edge in (graph.outgoing(entity.id) if graph else []):
                if entity_registry.type_of(edge['target_id']) not in kp_targets:
                    raise ValueError('KP_TARGET_FORBIDDEN: ' + entity.id + ' → ' + edge['target_id'])
    else:
        actual = [b for b in block_ids(text) if b.startswith('KP-')]
        problems = validate_document(course, text) + validate_obsidian_links(course)
        if problems: raise ValueError('; '.join(problems))
    if sorted(actual) != sorted(state['cards']):
        raise ValueError('卡片 block ID 与全局分配结果不一致')
    state.update(status='complete', cards_hash=sha256(inside(course, relative)))
    write_json(course / STATE, state)
    return {'complete': True, 'cards': len(actual)}


@validation_run
def check(course):
    try:
        from quality_gates import enabled, check_retained
        if enabled(course):
            check_retained(course, cards_path(course))
        from lesson_tasks import check as check_lessons
        lesson_errors = check_lessons(course)
        if lesson_errors: return ['核心卡片上游讲义已失效：' + '; '.join(lesson_errors)]
        state = read_json(course / STATE)
        if state.get('status') != 'complete': return ['核心卡片尚未统一完成或已失效']
        if any(state.get(k) != v for k, v in inputs(course).items()): return ['核心卡片基于旧讲义或旧知识生成']
        relative = cards_path(course)
        if sha256(inside(course, relative)) != state.get('cards_hash'):
            return ['核心卡片正文已修改，需重新 finalize']
        if is_v2(course):
            problems = validate_candidate(course, {relative: inside(course, relative).read_text(encoding='utf-8')},
                                          phase='working')
            if problems: return ['核心卡片关系或结构不一致：' + '; '.join(problems)]
        return []
    except (OSError, KeyError, ValueError) as exc: return ['核心卡片快照缺失/不可用：' + str(exc)]


def planned_literals(course):
    """Every literal the writer may copy, from the card plan."""
    plan_path = course / '_工作区/核心卡片计划.json'
    plan = read_json(plan_path).get('cards', []) if plan_path.exists() else []
    allowed = set()
    for entry in plan:
        allowed.update(entry.get('links', {}).get('all') or [])
    return allowed


def _card_links(text):
    """Body wikilinks of the card document (relation regions excluded)."""
    rel = relation_spans(text)
    return [link for link in parse_wikilinks(text)
            if not any(begin <= link['span'][0] and link['span'][1] <= finish for begin, finish in rel)]


def planned_keys(course):
    """Normalized link keys (``path#^block``) the plan authorizes."""
    keys = set()
    for literal in planned_literals(course):
        for link in parse_wikilinks(literal):
            keys.add(link['key'])
    return keys


def _offending_links(course, text):
    allowed = planned_keys(course)
    return [link for link in _card_links(text)
            if link['key'] not in allowed and not link['embed']]


def lint(course):
    """Read-only pre-flight for 核心知识点.md: forbidden literals + missing links."""
    relative = cards_path(course)
    path = inside(course, relative)
    if not path.is_file():
        raise ValueError('缺少 ' + relative + '；先按计划写卡片')
    text = path.read_text(encoding='utf-8')
    offending = _offending_links(course, text)
    problems = [{'code': 'MANIFEST_LINK_VIOLATION', 'line': text.count('\n', 0, link['span'][0]) + 1,
                 'literal': link['key'],
                 'hint': '改为计划字面量（plan.links.*），或运行 flatten --apply 转成纯文本'}
                for link in offending]
    unlinked = validate_reference_links(text, must_link_cards(course, text))
    for item in unlinked:
        problems.append({'code': 'UNLINKED_REFERENCE', 'line': item['line'], 'literal': item['mention'],
                         'entity': item['entity'], 'severity': item['severity'],
                         'hint': '在名称位置使用计划中的 canonical 字面量' if item['severity'] <= 2
                                 else '术语型提及，可视情况补链接'})
    blocking = [item for item in problems if item.get('severity', 2) <= 2]
    return {'cards': relative, 'links': len(_card_links(text)), 'allowed': len(planned_literals(course)),
            'problems': problems, 'errors': [f"{item['code']}: 第{item['line']}行 {item['literal']}"
                                             for item in blocking],
            'next': '修正 errors 后运行 finalize；warning 不阻断'}


def flatten(course, apply=False):
    """Turn plan-外 wikilinks in the card body into plain text (audit kept)."""
    relative = cards_path(course)
    path = inside(course, relative)
    text = path.read_text(encoding='utf-8')
    offending = sorted(_offending_links(course, text), key=lambda link: link['span'][0], reverse=True)
    records = []
    for link in offending:
        label = link.get('label') or link.get('block') or link['target']
        records.append({'file': relative, 'literal': link['key'], 'replacement': label,
                        'line': text.count('\n', 0, link['span'][0]) + 1, 'at': utc_now()})
        start, end = link['span']
        text = text[:start] + label + text[end:]
    if records and apply:
        atomic_text(path, text)
        audit = course / '_工作区/卡片链接规范化记录.jsonl'
        previous = read_jsonl(audit) if audit.exists() else []
        atomic_text(audit, ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in previous + records))
    return {'file': relative, 'flattened': len(records), 'applied': bool(records and apply),
            'preview': records[:20],
            'next': '已写回并留审计' if apply else '这是预览；加 --apply 才会改写文件'}


def main():
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('--course', required=True, type=Path)
    p.add_argument('command', choices=['prepare', 'finalize', 'check', 'lint', 'flatten'])
    p.add_argument('--apply', action='store_true', help='flatten 时真正写回文件')
    a = p.parse_args(); course = a.course.resolve()
    from convert_materials import locked
    try:
        with locked(course):
            if a.command == 'check': result = {'errors': check(course)}
            elif a.command == 'flatten': result = flatten(course, a.apply)
            else: result = globals()[a.command](course)
        print(json.dumps(result, ensure_ascii=False)); return 1 if result.get('errors') else 0
    except (OSError, ValueError, KeyError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False)); return 2


if __name__ == '__main__': raise SystemExit(main())
