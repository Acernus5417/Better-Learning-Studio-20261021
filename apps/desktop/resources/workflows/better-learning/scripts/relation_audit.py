"""Evidence-backed, deterministic relation omission audit (not semantic proof)."""
from __future__ import annotations

import re

from entity_sections import blank_spans, mask_code, parse_sections, SectionError
from relation_policy import (DEP, NAV, RelationError, lesson_dependencies,
                             record_hash, validate_dep_dag)


def audit_relations(data, registry, graph, documents=None, evidence=()):
    """Return pending candidates and issues; never mutate confirmed prerequisites.

    Evidence may contain dependent_k/prerequisite_k/evidence_ref records from
    an independent source audit. Body discovery deliberately recognizes only
    explicit prerequisite phrases; ordinary co-occurrence proves nothing.
    """
    documents = documents or {}
    issues, candidates = [], {}
    edges = graph.edges + graph.deferred
    keys = {(e['type'], e['subtype'], e['source_id'], e['target_id']) for e in edges}
    seen = set()
    for edge in edges:
        if edge['relation_key'] in seen:
            issues.append({'code': 'DUPLICATE_RELATION', 'relation_key': edge['relation_key'],
                           'severity': 'major'})
        seen.add(edge['relation_key'])
    try:
        validate_dep_dag(edges)
    except RelationError as exc:
        issues.append({'code': exc.code, 'severity': 'major', 'message': exc.message})
    for (source, target), proofs in lesson_dependencies(data).items():
        if (DEP, 'prerequisite', source, target) not in keys:
            issues.append({'code': 'MISSING_LESSON_DEPENDENCY', 'source_id': source,
                           'target_id': target, 'evidence': proofs, 'severity': 'major'})
    ordered = sorted(data.get('lessons', []), key=lambda l: (l.get('order', 0), l['id']))
    nav = set()
    for index, lesson in enumerate(ordered):
        for offset, subtype in [(-1, 'previous'), (1, 'next')]:
            if 0 <= index + offset < len(ordered):
                nav.add((NAV, subtype, lesson['id'], ordered[index + offset]['id']))
    actual = {key for key in keys if key[0] == NAV and key[1] in {'previous', 'next'}
              and registry.type_of(key[2]) == 'L'}
    for key in sorted(nav ^ actual):
        issues.append({'code': 'NAV_DIRECTION_MISMATCH', 'expected': key in nav,
                       'relation': list(key), 'severity': 'major'})

    knowledge = {k['id']: k for k in data.get('knowledge', []) if k.get('status') != 'merged'}
    for kid, item in knowledge.items():
        for target in sorted(set(item.get('prerequisites', []))):
            if (DEP, 'prerequisite', kid, target) not in keys:
                issues.append({'code': 'MISSING_KNOWLEDGE_DEPENDENCY', 'source_id': kid,
                               'target_id': target, 'severity': 'major'})
    names = {}
    for kid, item in knowledge.items():
        for name in [kid, item.get('title', ''), *item.get('aliases', [])]:
            if name:
                names.setdefault(name, set()).add(kid)

    def candidate(source, targets, proof):
        targets = sorted(set(targets) - {source})
        if not targets:
            return
        if len(targets) == 1 and targets[0] in knowledge.get(source, {}).get('prerequisites', []):
            return
        key = record_hash({'source': source, 'targets': targets, 'evidence': proof})
        candidates[key] = {'candidate_id': 'RC-' + key[:20], 'dependent_k': source,
                           'prerequisite_candidates': targets, 'status': 'pending',
                           'evidence': proof}

    for item in evidence:
        if not item.get('evidence_ref'):
            issues.append({'code': 'RELATION_PROVENANCE_MISSING', 'severity': 'major',
                           'message': 'independent evidence requires evidence_ref'})
            continue
        source, target = item.get('dependent_k'), item.get('prerequisite_k')
        if source not in knowledge or target not in knowledge:
            issues.append({'code': 'UNKNOWN_ENTITY', 'severity': 'major', 'evidence': item})
            continue
        candidate(source, [target], item)

    if names:
        names_pattern = '|'.join(re.escape(name) for name in sorted(names, key=lambda n: (-len(n), n)))
        # Anchored to an explicit claim, not proximity between arbitrary concepts.
        explicit = re.compile(r'(?:前置(?:知识)?|依赖|需要先掌握|先修)(?:为|是|：|:|\s)*'
                              r'(?:\[\[[^\]\n]*?\|)?('
                              + names_pattern + r')(?![A-Za-z0-9-])')
        from obsidian_links import relation_spans
        for path, text in sorted(documents.items()):
            try:
                index = parse_sections(text, None, strict_registry=False)
            except SectionError as exc:
                issues.append({'code': exc.code, 'file': path, 'severity': 'major'})
                continue
            hidden = relation_spans(text) + [m.span() for m in re.finditer(r'<!--.*?-->', text, re.S)]
            masked = blank_spans(mask_code(text), hidden)
            for kid in knowledge:
                section = index.get('K', kid)
                if section is None:
                    continue
                body = masked[section.body_start:section.body_end]
                for match in explicit.finditer(body):
                    start = section.body_start + match.start()
                    candidate(kid, names[match[1]], {'kind': 'explicit_prerequisite_mention',
                              'file': path, 'line': text.count('\n', 0, start) + 1,
                              'span': [start, section.body_start + match.end()],
                              'text': match.group(), 'document_hash': record_hash(text)})
    from obsidian_links import resolve_lesson_references
    for lesson in ordered:
        path = registry.canonical(lesson['id']).path
        if path in documents:
            _, refs = resolve_lesson_references(documents[path], lesson['id'], registry, graph)
            issues.extend(dict(item, file=path, severity='major') for item in refs)
    pending = sorted(candidates.values(), key=lambda item: item['candidate_id'])
    issues.extend({'code': 'POSSIBLE_MISSING_PREREQUISITE', 'severity': 'major',
                   'candidate_id': c['candidate_id'], 'source_id': c['dependent_k'],
                   'target_ids': c['prerequisite_candidates'], 'status': 'pending'} for c in pending)
    return {'schema_version': 1, 'gate_id': 'relation_audit',
            'status': 'failed' if issues else 'passed', 'issues': issues, 'candidates': pending,
            'metrics': {'edges': len(edges), 'pending_candidates': len(pending)},
            'limits': 'Deterministic discoverable omissions only; no semantic completeness or recall claim.'}
