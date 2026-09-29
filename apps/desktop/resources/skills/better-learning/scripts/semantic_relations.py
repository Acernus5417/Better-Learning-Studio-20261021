"""Evidence-backed relation decisions, scoped terms and impact analysis.

知识索引.jsonl remains the only authoritative prerequisite graph. This ledger
stores decisions/evidence, never an independently editable duplicate graph.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

from _common import Transaction, course_lock, inside, read_json, read_jsonl, sha256, write_json

STATE = '_工作区/语义关系.json'
INDEX = '_工作区/知识索引.jsonl'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def load(course):
    path = Path(course) / STATE
    return read_json(path) if path.exists() else {
        'schema_version': 1, 'revision': 0, 'candidates': {}, 'terms': {}, 'capabilities': {}}


def knowledge(course):
    rows = read_jsonl(Path(course) / INDEX)
    if len({k['id'] for k in rows}) != len(rows):
        raise ValueError('DUPLICATE_KNOWLEDGE_ID')
    return {k['id']: k for k in rows if k.get('status') != 'merged'}


def evidence(course, ref):
    """Exact character span and both document/span hashes; no title-only proof."""
    path = inside(Path(course), ref['path'])
    text = path.read_text(encoding='utf-8')
    start, end = ref['start'], ref['end']
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(text):
        raise ValueError('INVALID_EVIDENCE_RANGE')
    result = dict(ref, document_hash=sha256(path), span_hash=digest(text[start:end]))
    for key in ('document_hash', 'span_hash'):
        if key in ref and ref[key] != result[key]:
            raise ValueError('STALE_EVIDENCE: ' + ref['path'])
    return result


def prerequisite_pair(dependent, required):
    """The only conversion: existing dep.prerequisites → required-to-dependent."""
    return {'from_k': required, 'to_k': dependent,
            'direction': 'from_required_to_dependent', 'relation': 'prerequisite'}


def _candidate(course, state, dependent, required, refs, method):
    nodes = knowledge(course)
    if dependent == required or dependent not in nodes or required not in nodes:
        raise ValueError('INVALID_RELATION_ENTITY')
    if not refs or method not in {'explicit', 'term', 'capability', 'teaching', 'existing'}:
        raise ValueError('RELATION_EVIDENCE_REQUIRED')
    checked = [evidence(course, ref) for ref in refs]
    cid = 'DEP-' + digest([required, dependent])[:20]
    pair = prerequisite_pair(dependent, required)
    old = state['candidates'].get(cid)
    # Discovering additional evidence never silently erases an unresolved finding.
    current = []
    for item in (old or {}).get('evidence', []):
        try:
            evidence(course, item)
            current.append(item)
        except (ValueError, OSError):
            pass  # Preserved in history below, never mixed into the new version.
    combined = {digest(item): item for item in current + checked}
    payload = dict(pair, evidence=[combined[key] for key in sorted(combined)],
                   methods=sorted(set((old or {}).get('methods', []) + [method])))
    version = digest(payload)
    if old and old['version'] == version:
        return cid
    history = (old or {}).get('history', [])
    if old:
        history = history + [{k: v for k, v in old.items() if k != 'history'}]
    state['candidates'][cid] = dict(payload, id=cid, version=version, status='pending', history=history)
    state['revision'] += 1
    return cid


def propose(course, dependent, required, refs, method='explicit'):
    with course_lock(Path(course)):
        state = load(course)
        cid = _candidate(course, state, dependent, required, refs, method)
        write_json(Path(course) / STATE, state)
    return {'candidate_id': cid, 'status': state['candidates'][cid]['status']}


def discover(course):
    """Multiple recall channels create pending candidates, never confirmed edges."""
    nodes = knowledge(course)
    chapters = read_json(Path(course) / '_工作区/章节索引.json')['chapters']
    from entity_sections import parse_sections, mask_code
    with course_lock(Path(course)):
        state = load(course)
        aliases = {}
        for kid, row in nodes.items():
            for alias in [kid, row.get('title', ''), *row.get('aliases', [])]:
                if alias:
                    aliases.setdefault(alias, set()).add(kid)
        count = 0
        for chapter in chapters:
            path = chapter['path']
            text = inside(Path(course), path).read_text(encoding='utf-8')
            sections = parse_sections(text, None, strict_registry=False)
            for sec in sections.sections.values():
                if sec.kind != 'K' or sec.id not in nodes:
                    continue
                scoped = {name: set(kids) for name, kids in aliases.items()}
                for term in state['terms'].values():
                    if term['scope'] not in {'global', 'course', chapter['id'], sec.id}:
                        continue
                    for alias in [term['name'], *term.get('aliases', [])]:
                        scoped.setdefault(alias, set()).update(term['knowledge_ids'])
                pattern = re.compile(r'(?:前置(?:知识)?|需要先掌握|依赖|先修)(?:为|是|：|:|\s)*('
                    + '|'.join(re.escape(n) for n in sorted(scoped, key=len, reverse=True)) + ')') if scoped else None
                for match in pattern.finditer(mask_code(text[sec.body_start:sec.body_end])) if pattern else []:
                    for required in scoped[match[1]] - {sec.id}:
                        ref = {'path': path, 'start': sec.body_start + match.start(), 'end': sec.body_start + match.end()}
                        _candidate(course, state, sec.id, required, [ref], 'explicit')
                        count += 1
                # Imported reviewed JSONL relations still need evidence review in bounded mode.
                for required in nodes[sec.id].get('prerequisites', []):
                    cid = 'DEP-' + digest([required, sec.id])[:20]
                    if cid not in state['candidates']:
                        _candidate(course, state, sec.id, required,
                                   [{'path': path, 'start': sec.body_start, 'end': sec.body_end}], 'existing')
                        count += 1
        write_json(Path(course) / STATE, state)
    return {'discovered': count, 'revision': state['revision'],
            'note': 'Explicit mentions and imported edges only; missing discovery is not a negative decision.'}


def _acyclic(rows):
    remaining = {k: set(v.get('prerequisites', [])) for k, v in rows.items()}
    while remaining:
        ready = {k for k, deps in remaining.items() if not deps}
        if not ready:
            raise ValueError('DEPENDENCY_CYCLE_OR_UNKNOWN_ENTITY')
        remaining = {k: deps - ready for k, deps in remaining.items() if k not in ready}


def require_evidence_review(course, proof, refs):
    reviewed = {(p['path'], p['sha256']) for p in proof.get('inputs', [])}
    required = {(str(inside(Path(course), ref['path'])), evidence(course, ref)['document_hash']) for ref in refs}
    if proof.get('stage') != 'relations' or not required or not required <= reviewed:
        raise ValueError('RELATION_REVIEW_INPUTS_MISSING')


def verify_relation_review(course, proof):
    from quality_gates import check_retained
    target = Path(proof['artifact']['path']).relative_to(Path(course).resolve()).as_posix()
    receipt = check_retained(course, target)
    if proof.get('stage') != 'relations' or not any(
            {k: v for k, v in retained.items() if k != 'retained_files'} == proof
            for retained in receipt['proofs']):
        raise ValueError('RELATION_REVIEW_BINDING_MISMATCH')
    return read_json(Path(course) / '_工作区/质量证据' / (proof['artifact']['sha256'] + '.txt'))


def decide(course, decision_path):
    """Apply an independently reviewed exact decision and JSONL in one transaction."""
    from bounded_runtime import Runtime
    with course_lock(Path(course)):
        runtime = Runtime(course)
        try:
            proof = runtime.gate_for_artifact(decision_path)
        finally:
            runtime.close()
        decision = read_json(inside(Path(course), decision_path))
        state = load(course)
        row = state['candidates'][decision['candidate_id']]
        if decision.get('candidate_version') != row['version']:
            raise ValueError('STALE_RELATION_DECISION')
        if decision.get('status') not in {'confirmed', 'rejected', 'conflict'} or not decision.get('rationale'):
            raise ValueError('INVALID_RELATION_DECISION')
        for ref in row['evidence']:
            evidence(course, ref)
        require_evidence_review(course, proof, row['evidence'])
        if (row.get('status') == decision['status'] and row.get('rationale') == decision['rationale']
                and row.get('review') == proof):
            return {'candidate_id': row['id'], 'status': row['status'], 'revision': state['revision'], 'idempotent': True}
        old_rows = read_jsonl(Path(course) / INDEX)
        knowledge(course)  # Duplicate IDs must fail before any official write.
        nodes = {k['id']: k for k in old_rows if k.get('status') != 'merged'}
        target = nodes[row['to_k']]
        deps = set(target.get('prerequisites', []))
        if decision['status'] == 'confirmed':
            deps.add(row['from_k'])
        elif decision['status'] == 'rejected':
            deps.discard(row['from_k'])
        target['prerequisites'] = sorted(deps)
        _acyclic(nodes)
        row.update(status=decision['status'], rationale=decision['rationale'], review=proof)
        state['revision'] += 1
        from quality_gates import receipt_state, RECEIPTS
        retained = receipt_state(course, decision_path, inside(Path(course), decision_path).read_text(encoding='utf-8'),
                                 [decision_path], 'G7')
        tx = Transaction(Path(course), Path(course) / '_工作区/事务记录.jsonl')
        if retained is not None:
            tx.write(Path(course) / RECEIPTS, json.dumps(retained, ensure_ascii=False, indent=2) + '\n')
        tx.write(Path(course) / INDEX, ''.join(json.dumps(k, ensure_ascii=False) + '\n' for k in old_rows))
        tx.write(Path(course) / STATE, json.dumps(state, ensure_ascii=False, indent=2) + '\n')
        tx.commit()
    return {'candidate_id': row['id'], 'status': row['status'], 'revision': state['revision'],
            'next': 'rebuild knowledge and recompute affected lesson/task snapshots'}


def register(course, path, kind):
    """Scoped term/capability registration requires a reviewed definition artifact."""
    from bounded_runtime import Runtime
    if kind not in {'terms', 'capabilities'}:
        raise ValueError('INVALID_REGISTRY_KIND')
    with course_lock(Path(course)):
        runtime = Runtime(course)
        try:
            proof = runtime.gate_for_artifact(path)
        finally:
            runtime.close()
        row = read_json(inside(Path(course), path))
        if not all(row.get(k) for k in ('id', 'name', 'definition', 'knowledge_ids', 'scope', 'evidence')):
            raise ValueError('INCOMPLETE_DEFINITION')
        if not set(row['knowledge_ids']) <= set(knowledge(course)):
            raise ValueError('UNKNOWN_KNOWLEDGE')
        row['evidence'] = [evidence(course, ref) for ref in row['evidence']]
        require_evidence_review(course, proof, row['evidence'])
        row['review'] = proof
        state = load(course)
        state[kind][row['id']] = row
        state['revision'] += 1
        from quality_gates import receipt_state, RECEIPTS
        retained = receipt_state(course, path, inside(Path(course), path).read_text(encoding='utf-8'), [path], 'G7')
        tx = Transaction(Path(course), Path(course) / '_工作区/事务记录.jsonl')
        tx.write(Path(course) / STATE, json.dumps(state, ensure_ascii=False, indent=2) + '\n')
        if retained is not None:
            tx.write(Path(course) / RECEIPTS, json.dumps(retained, ensure_ascii=False, indent=2) + '\n')
        tx.commit()
    return {'id': row['id'], 'revision': state['revision']}


def audit(course):
    state, nodes = load(course), knowledge(course)
    issues = []
    def issue(code, target, severity='major'):
        issues.append({'code': code, 'target_id': target, 'severity': severity})
    try:
        _acyclic(nodes)
    except ValueError as exc:
        issue(str(exc), 'knowledge')
    confirmed = set()
    for cid, row in state['candidates'].items():
        if not row.get('evidence'):
            issue('RELATION_EVIDENCE_MISSING', cid)
        if row.get('status') in {'confirmed', 'rejected'} and not (row.get('review') or {}).get('approved'):
            issue('RELATION_REVIEW_MISSING', cid)
        elif row.get('status') in {'confirmed', 'rejected'}:
            try:
                reviewed = verify_relation_review(course, row['review'])
                expected = {'candidate_id': cid, 'candidate_version': row['version'],
                            'status': row['status'], 'rationale': row.get('rationale')}
                if reviewed is not None and any(reviewed.get(k) != value for k, value in expected.items()):
                    raise ValueError('RELATION_REVIEW_BINDING_MISMATCH')
            except (ValueError, OSError, KeyError, TypeError):
                issue('RELATION_REVIEW_STALE', cid)
        if row['status'] in {'pending', 'conflict'}:
            issue('RELATION_' + row['status'].upper(), cid)
        for ref in row['evidence']:
            try:
                if not ref.get('document_hash') or not ref.get('span_hash'):
                    raise ValueError('EVIDENCE_HASH_MISSING')
                evidence(course, ref)
            except (ValueError, OSError):
                issue('STALE_RELATION_EVIDENCE', cid)
        pair = (row['from_k'], row['to_k'])
        exists = row['from_k'] in nodes.get(row['to_k'], {}).get('prerequisites', [])
        if row['status'] == 'confirmed':
            confirmed.add(pair)
            if not exists:
                issue('CONFIRMED_RELATION_MISSING', cid)
        elif row['status'] == 'rejected' and exists:
            issue('REJECTED_RELATION_PRESENT', cid)
    for kid, row in nodes.items():
        for dep in row.get('prerequisites', []):
            if (dep, kid) not in confirmed:
                issue('PREREQUISITE_REVIEW_MISSING', dep + '→' + kid)
        if not row.get('prerequisites'):
            issue('ISOLATED_OR_FOUNDATIONAL_REVIEW', kid, 'info')
    names = {}
    for kind in ('terms', 'capabilities'):
        for rid, definition in state[kind].items():
            if not definition.get('evidence') or not (definition.get('review') or {}).get('approved'):
                issue('DEFINITION_EVIDENCE_MISSING', rid)
            else:
                try:
                    reviewed = verify_relation_review(course, definition['review'])
                    if reviewed is not None:
                        reviewed['evidence'] = [evidence(course, ref) for ref in reviewed['evidence']]
                        if reviewed != {key: value for key, value in definition.items() if key != 'review'}:
                            raise ValueError('DEFINITION_REVIEW_BINDING_MISMATCH')
                except (ValueError, OSError, KeyError, TypeError):
                    issue('DEFINITION_REVIEW_STALE', rid)
            if not set(definition.get('knowledge_ids', [])) <= set(nodes):
                issue('DEFINITION_KNOWLEDGE_MISSING', rid)
            for ref in definition.get('evidence', []):
                try:
                    if not ref.get('document_hash') or not ref.get('span_hash'):
                        raise ValueError('EVIDENCE_HASH_MISSING')
                    evidence(course, ref)
                except (ValueError, OSError):
                    issue('STALE_DEFINITION_EVIDENCE', rid)
    for tid, term in state['terms'].items():
        for name in [term['name'], *term.get('aliases', [])]:
            names.setdefault((term['scope'], name), []).append(tid)
    for key, tids in names.items():
        if len(set(tids)) > 1:
            issue('TERM_AMBIGUITY', '/'.join(key))
    return {'gate_id': 'G3', 'status': 'failed' if any(i['severity'] == 'major' for i in issues) else 'passed',
            'issues': issues, 'metrics': {'candidates': len(state['candidates']), 'confirmed': len(confirmed)},
            'limits': 'Mechanical evidence audit; undiscovered relations remain unknown.'}


def impact(course, changed, change_type='content'):
    nodes = knowledge(course)
    if change_type == 'render':
        return {'content': [], 'review': [], 'render': sorted(changed)}
    affected = set(changed)
    while True:
        expanded = affected | {k for k, row in nodes.items() if affected.intersection(row.get('prerequisites', []))}
        if expanded == affected:
            break
        affected = expanded
    lessons = {l for k in affected if k in nodes for l in nodes[k].get('lesson_ids', [])}
    cards = {nodes[k]['card_id'] for k in affected if k in nodes and nodes[k].get('card_id')}
    exercise_file = Path(course) / '_工作区/练习索引.jsonl'
    exercises = {row['id'] for row in read_jsonl(exercise_file) if affected.intersection(row.get('assesses', []))} if exercise_file.exists() else set()
    return {'content': sorted(affected) if change_type == 'content' else [],
            'review': sorted(affected | lessons | cards | exercises), 'render': sorted(affected | lessons | cards)}


def evaluate(course, gold_path):
    gold = read_json(inside(Path(course), gold_path))
    if not gold.get('annotator') or not gold.get('sampling_method') or not gold.get('pairs'):
        raise ValueError('GOLD_PROVENANCE_REQUIRED')
    rows = gold['pairs']
    if any(type(row.get('prerequisite')) is not bool for row in rows):
        raise ValueError('GOLD_LABEL_REQUIRED')
    pairs = {(r['from_k'], r['to_k']): r['prerequisite'] for r in rows}
    if len(pairs) != len(rows):
        raise ValueError('DUPLICATE_GOLD_PAIR')
    state = load(course)
    recalled = {(r['from_k'], r['to_k']) for r in state['candidates'].values()}
    actual = {(dep, kid) for kid, row in knowledge(course).items() for dep in row.get('prerequisites', [])}
    predicted = {(r['from_k'], r['to_k']) for r in state['candidates'].values() if r['status'] == 'confirmed'} & actual
    positive = {p for p, label in pairs.items() if label}
    tp, fp, fn = len(predicted & positive), len(predicted & {p for p, label in pairs.items() if not label}), len(positive - predicted)
    return {'sample_count': len(pairs), 'annotator': gold['annotator'], 'sampling_method': gold['sampling_method'],
            'candidate_recall': len(recalled & positive) / len(positive) if positive else None,
            'precision': tp / (tp + fp) if tp + fp else None,
            'recall': tp / (tp + fn) if tp + fn else None,
            'limits': 'Metrics apply only to supplied annotated pairs; provenance is not independently certified.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--course', type=Path, required=True)
    parser.add_argument('command', choices=['discover', 'audit', 'decide', 'register-term', 'register-capability', 'impact', 'evaluate'])
    parser.add_argument('--file')
    parser.add_argument('--changed', nargs='*', default=[])
    parser.add_argument('--change-type', choices=['content', 'relation', 'render'], default='content')
    args = parser.parse_args()
    try:
        if args.command == 'decide':
            result = decide(args.course, args.file)
        elif args.command.startswith('register-'):
            result = register(args.course, args.file, 'terms' if args.command.endswith('term') else 'capabilities')
        elif args.command == 'impact':
            result = impact(args.course, args.changed, args.change_type)
        elif args.command == 'evaluate':
            result = evaluate(args.course, args.file)
        else:
            result = globals()[args.command](args.course)
        # Full reports stay on disk. CLI never injects an unbounded issue list.
        report = '_工作区/语义关系报告.json'
        write_json(args.course / report, result)
        print(json.dumps({'status': result.get('status', 'recorded'), 'report': report,
                          'issues': len(result.get('issues', []))}, ensure_ascii=False))
        return int(result.get('status') == 'failed')
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({'status': 'blocked', 'error': str(exc)[:500]}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
