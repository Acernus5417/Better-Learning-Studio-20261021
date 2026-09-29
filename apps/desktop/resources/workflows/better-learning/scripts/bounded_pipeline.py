"""Explicit migration and lesson adapters for the existing parts-v1 pipeline."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

from _common import atomic_text, course_lock, inside, read_json, sha256, write_json
from quality_gates import enabled, require_artifacts


def enable(course):
    """Explicit migration; never mark old output as independently reviewed."""
    from bounded_runtime import policy_registry
    for stage in ('knowledge', 'path', 'lesson', 'cards', 'relations', 'quality'):
        policy_registry(stage)
    with course_lock(Path(course)):
        path = Path(course) / '_工作区/课程配置.json'
        config = read_json(path)
        if config.get('layout') == 'packaged':
            raise ValueError('PACKAGED_COURSE_REQUIRES_REOPEN')
        from lesson_tasks import active_records, LEDGER
        ledger = read_json(Path(course) / LEDGER) if (Path(course) / LEDGER).exists() else {}
        if active_records(ledger):
            raise ValueError('ACTIVE_WRITERS_REQUIRE_STOP')
        transcription = Path(course) / '_工作区/转写任务.json'
        if transcription.exists():
            data = read_json(transcription)
            if any(a.get('state') in {'reserved', 'running', 'produced'} for a in data.get('attempts', [])):
                raise ValueError('ACTIVE_WRITERS_REQUIRE_STOP')
        database = Path(course) / '_工作区/bounded-runtime/runtime.sqlite3'
        if database.exists():
            db = sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)
            try:
                if db.execute("SELECT 1 FROM tasks WHERE state IN ('ready','running','candidate') LIMIT 1").fetchone():
                    raise ValueError('ACTIVE_WRITERS_REQUIRE_STOP')
            finally:
                db.close()
        config['execution_profile'] = 'bounded-v1'
        write_json(path, config)
    return {'execution_profile': 'bounded-v1', 'existing_reviews': 'not_assumed',
            'next': 'prepare inputs; register actual host sessions; create and review bounded tasks'}


def provision(course, row, snap):
    """Full content persists on disk; each section gets only its own knowledge."""
    if not enabled(course):
        return
    folder = row['folder'] + '/bounded'
    manifest = read_json(inside(Path(course), row['manifest']))
    by_id = {k['id']: k for k in snap['knowledge'] + snap['prerequisites']}
    slices = dict(snap['slices'], **snap['prerequisite_slices'])
    blueprint = read_json(Path(__file__).resolve().parents[1] / 'assets/templates/lesson-blueprint.json')
    blueprint.update({'schema_version': 1, 'lesson_id': row['id'], 'input_hash': row['input_hash'],
                 'status': 'needs_planning', 'knowledge_order': row['knowledge_ids'],
                 'goals': [], 'exercise_plan': [], 'interfaces': [],
                 'source_map': {kid: by_id[kid].get('source_refs', []) for kid in row['knowledge_ids']}})
    plan_path = folder + '/blueprint.json'
    if inside(Path(course), plan_path).exists():
        previous = read_json(inside(Path(course), plan_path))
        if previous.get('input_hash') == row['input_hash']:
            blueprint = previous
    write_json(inside(Path(course), plan_path), blueprint)
    source_cache = {}
    for section in row['sections']:
        sf = folder + '/' + section['id']
        kids = section['knowledge_ids'] if section['kind'] == 'knowledge' else row['knowledge_ids']
        deps = sorted({dep for kid in kids for dep in by_id[kid].get('prerequisites', [])} - set(kids))
        paths = []
        source_evidence = []
        for kid in kids + deps:
            entry = by_id[kid]
            if entry.get('kind') == 'material' and not entry.get('source_refs'):
                raise ValueError('SOURCE_EVIDENCE_MISSING: ' + kid)
            for ref in entry.get('source_refs', []):
                sid, uid = ref['source_id'], ref['unit_id']
                if any(e['source_id'] == sid and e['unit_id'] == uid for e in source_evidence):
                    continue
                if sid not in source_cache:
                    from transcribe_materials import context
                    source_cache[sid] = context(Path(course), sid)
                source, transcript, mapping, _, _, records = source_cache[sid]
                record = records.get(uid)
                if not record or record['state'] != 'complete':
                    raise ValueError('SOURCE_EVIDENCE_INCOMPLETE: ' + sid + '/' + uid)
                evidence_path = sf + '/source-' + str(len(source_evidence) + 1) + '.md'
                atomic_text(inside(Path(course), evidence_path), record['body'])
                paths.append(evidence_path)
                unit = next(u for u in mapping['units'] if u['id'] == uid)
                source_evidence.append({'source_id': sid, 'unit_id': uid, 'source_hash': source['sha256'],
                                        'transcript': transcript['path'], 'locator': unit.get('locator'),
                                        'path': evidence_path, 'sha256': sha256(inside(Path(course), evidence_path))})
        provenance = sf + '/source-evidence.json'
        write_json(inside(Path(course), provenance), source_evidence)
        paths.append(provenance)
        for name, body in [('knowledge.md', '\n\n'.join(slices[k] for k in kids)),
                           ('prerequisites.md', '\n\n'.join(slices[k] for k in deps)),
                           ('requirements.md', snap['requirements']), ('path.md', snap['path_excerpt'])]:
            if body.strip():
                path = sf + '/' + name
                atomic_text(inside(Path(course), path), body)
                paths.append(path)
        links = manifest['links']
        local_links = {'knowledge': {k: v for k, v in links['knowledge'].items() if k in kids + deps},
                       'prerequisites': {k: v for k, v in links.get('prerequisites', {}).items() if k in deps},
                       'lessons': links.get('lessons', {}), 'learning_path': links.get('learning_path'),
                       'attachments': links.get('attachments', {})}
        allowed_ids = set(kids + deps) | set(local_links['lessons'])
        contract = {'lesson_id': row['id'], 'title': row['title'], 'order': row['order'],
                    'section_id': section['id'], 'kind': section['kind'], 'links': local_links,
                    'reference_targets': [r for r in row.get('reference_targets', [])
                                          if r['id'] in allowed_ids or r['id'].startswith('P-')],
                    'reserved_exercises': manifest['reserved_exercises'] if section['kind'] == 'closing' else [],
                    'system_markup': 'forbidden; assembler owns BL boundaries and identity anchors',
                    'output': {'directory': section['directory'], 'receipt': section['receipt']}}
        contract_path = sf + '/writer-contract.json'
        write_json(inside(Path(course), contract_path), contract)
        paths.append(contract_path)
        spec = {'lesson_id': row['id'], 'section_id': section['id'], 'kind': section['kind'],
                'input_hash': row['input_hash'], 'inputs': paths, 'knowledge_ids': kids,
                'prerequisites': deps, 'blueprint_ref': plan_path,
                'source_evidence': source_evidence,
                'outputs': {'directory': section['directory'], 'receipt': section['receipt']},
                'allowed_actions': ['read_assigned', 'write_candidate'],
                'forbidden_actions': ['shell', 'network', 'spawn', 'write_shared_state'],
                'on_oversize': 'split semantic unit or evidence task; never truncate'}
        write_json(inside(Path(course), sf + '/unit.json'), spec)
        section['bounded_spec'] = sf + '/unit.json'
        row.setdefault('input_hashes', {}).update({p: sha256(inside(Path(course), p))
                                                  for p in paths + [section['bounded_spec']]})
    row['blueprint'] = plan_path


def _row(course, lesson):
    from lesson_tasks import LEDGER
    return next(r for r in read_json(Path(course) / LEDGER)['lessons'] if r['id'] == lesson)


def planning_inputs(course, row):
    inputs = []
    for section in row['sections']:
        if section['kind'] == 'knowledge':
            spec = read_json(inside(Path(course), section['bounded_spec']))
            require_current_sources(course, spec)
            inputs.extend(spec['inputs'])
    return sorted(set(inputs))


def require_current_sources(course, spec):
    from transcribe_materials import context
    sources = {}
    for item in spec.get('source_evidence', []):
        if item['source_id'] not in sources:
            sources[item['source_id']] = context(Path(course), item['source_id'])
        source, _, _, _, _, records = sources[item['source_id']]
        record = records.get(item['unit_id'])
        if (source['sha256'] != item['source_hash'] or not record or record['state'] != 'complete'
                or hashlib.sha256(record['body'].encode('utf-8')).hexdigest() != item['sha256']
                or sha256(inside(Path(course), item['path'])) != item['sha256']):
            raise ValueError('SOURCE_EVIDENCE_STALE')


def require_inputs(course, proof, stage, paths, config=None):
    from bounded_runtime import encoded
    required = {(str(inside(Path(course), p)), sha256(inside(Path(course), p))) for p in paths}
    reviewed = {(item['path'], item['sha256']) for item in proof['inputs']}
    if proof['stage'] != stage or not required <= reviewed:
        raise ValueError('REVIEW_INPUT_BINDING_MISSING: ' + stage)
    if config is not None and proof['config_hash'] != hashlib.sha256(encoded(config)).hexdigest():
        raise ValueError('REVIEW_CONFIG_BINDING_MISSING: ' + stage)


def require_plan(course, row):
    path = row.get('blueprint')
    if not path:
        raise ValueError('BOUND_INPUT_MISSING: rerun prepare after enable')
    if any(sha256(inside(Path(course), p)) != digest for p, digest in row.get('input_hashes', {}).items()):
        raise ValueError('ASSIGNED_INPUTS_CHANGED')
    plan = read_json(inside(Path(course), path))
    if plan.get('status') != 'complete' or plan.get('input_hash') != row['input_hash'] or plan.get('lesson_id') != row['id']:
        raise ValueError('BLUEPRINT_INCOMPLETE_OR_STALE')
    if sorted(plan.get('knowledge_order', [])) != sorted(row['knowledge_ids']):
        raise ValueError('BLUEPRINT_KNOWLEDGE_COVERAGE')
    if not plan.get('goals') or not plan.get('exercise_plan'):
        raise ValueError('BLUEPRINT_GOALS_AND_EXERCISES_REQUIRED')
    proofs = require_artifacts(course, [path])
    if not proofs or proofs[0]['stage'] != 'path':
        raise ValueError('BLUEPRINT_REVIEW_STAGE_MISMATCH')
    require_inputs(course, proofs[0], 'path', planning_inputs(course, row))
    return plan


def section_plan(row, section, plan):
    sid = section['id']
    return {'lesson_id': row['id'], 'section_id': sid, 'goals': plan['goals'],
            'exercise_plan': [e for e in plan['exercise_plan'] if not e.get('section_id') or e['section_id'] == sid],
            'interfaces': [i for i in plan.get('interfaces', []) if sid in i.get('sections', [])]}


def section_config(row, section, spec):
    return {'scope': 'lesson-section', 'lesson_id': row['id'], 'section_id': section['id'],
            'input_hash': row['input_hash'], 'output_contract': spec['outputs']}


def create_section_task(course, lesson, section_id, session_id, task_id):
    from bounded_runtime import Runtime
    row = _row(course, lesson)
    plan = require_plan(course, row)
    section = next(s for s in row['sections'] if s['id'] == section_id)
    spec = read_json(inside(Path(course), section['bounded_spec']))
    require_current_sources(course, spec)
    # A localized plan keeps unrelated chapter metadata out of the worker input.
    local = section['bounded_spec'].removesuffix('unit.json') + 'plan.json'
    write_json(inside(Path(course), local), section_plan(row, section, plan))
    runtime = Runtime(course)
    try:
        return runtime.create_task(task_id, 'lesson', spec['inputs'] + [local, section['bounded_spec']],
                                   section_config(row, section, spec), session_id)
    finally:
        runtime.close()


def require_lesson_reviews(course, row, attempt):
    """Local reviews + explicit interface/goal review evidence; no auto global pass."""
    if not enabled(course):
        return []
    plan = require_plan(course, row)
    paths = [f['path'] for section in attempt['part_progress'].values() for f in section['files']]
    proofs = require_artifacts(course, paths)
    if any(proof['stage'] != 'lesson' for proof in proofs):
        raise ValueError('LESSON_REVIEW_STAGE_MISMATCH')
    by_path = {proof['artifact']['path']: proof for proof in proofs}
    for section in row['sections']:
        spec = read_json(inside(Path(course), section['bounded_spec']))
        require_current_sources(course, spec)
        local = section['bounded_spec'].removesuffix('unit.json') + 'plan.json'
        if read_json(inside(Path(course), local)) != section_plan(row, section, plan):
            raise ValueError('SECTION_PLAN_STALE')
        for item in attempt['part_progress'][section['id']]['files']:
            require_inputs(course, by_path[str(inside(Path(course), item['path']))], 'lesson',
                           spec['inputs'] + [local, section['bounded_spec']], section_config(row, section, spec))
    # These review artifacts are bounded tasks: each must identify exact accepted
    # chunk hashes and an independently verified runtime candidate gate.
    expected = {'goals': paths}
    sections = row['sections']
    for left, right in zip(sections, sections[1:]):
        expected[left['id'] + '-' + right['id']] = [f['path'] for sid in (left['id'], right['id'])
                        for f in attempt['part_progress'][sid]['files']]
    review_paths = []
    for key, inputs in expected.items():
        path = row['folder'] + '/bounded/reviews/' + key + '.json'
        report = read_json(inside(Path(course), path))
        if (report.get('lesson_id') != row['id'] or report.get('scope') != key
                or report.get('input_hash') != row['input_hash']
                or report.get('chunk_hashes') != {p: sha256(inside(Path(course), p)) for p in inputs}
                or report.get('status') != 'passed'
                or any(i.get('severity') in {'critical', 'major'} for i in report.get('issues', []))):
            raise ValueError('LESSON_REVIEW_INCOMPLETE_OR_STALE: ' + key)
        proof = require_artifacts(course, [path])[0]
        reviewed_inputs = {item['path'] for item in proof['inputs']}
        required_inputs = {str(inside(Path(course), p)) for p in inputs + [row['blueprint']]}
        if proof['stage'] != 'quality' or not required_inputs <= reviewed_inputs:
            raise ValueError('LESSON_REVIEW_INPUTS_MISSING: ' + key)
        review_paths.append(path)
    return paths + review_paths + [row['blueprint']]


def continuity(course, row, text=None, transaction=None):
    """Actual section locations/hashes; no invented conclusions from a plan."""
    from entity_sections import parse_sections
    from quality_gates import content_hash
    text = text if text is not None else inside(Path(course), row['path']).read_text(encoding='utf-8')
    parsed = parse_sections(text, None, strict_registry=False)
    sections = [{'id': s.id, 'kind': s.kind, 'start': s.body_start, 'end': s.body_end,
                 'content_hash': content_hash(text[s.body_start:s.body_end])}
                for s in parsed.sections.values() if s.kind in {'TEACH', 'EX'}]
    result = {'schema_version': 1, 'lesson_id': row['id'], 'path': row['path'],
              'content_hash': content_hash(text), 'actual_sections': sections,
              'limits': 'Section presence does not prove a conclusion; retrieve actual section before citing.'}
    path = Path(course) / '_工作区/讲义衔接' / (row['id'] + '.json')
    if transaction is None:
        write_json(path, result)
    else:
        transaction.write(path, json.dumps(result, ensure_ascii=False, indent=2) + '\n')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--course', type=Path, required=True)
    p.add_argument('command', choices=['enable', 'section-task'])
    for arg in ('lesson', 'section', 'session', 'task'):
        p.add_argument('--' + arg)
    a = p.parse_args()
    try:
        result = enable(a.course) if a.command == 'enable' else create_section_task(a.course, a.lesson, a.section, a.session, a.task)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, KeyError, OSError, StopIteration, sqlite3.Error) as exc:
        print(json.dumps({'status': 'blocked', 'error': str(exc)[:500]}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
