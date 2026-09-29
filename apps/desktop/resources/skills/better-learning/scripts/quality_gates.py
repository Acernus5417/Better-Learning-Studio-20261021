"""Retained independent review evidence; never infer semantics from file existence."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import sqlite3

from _common import atomic_text, inside, read_json, read_jsonl, sha256, write_json

RECEIPTS = '_工作区/质量回执.json'


def validate_proof(proof):
    required = ('task_id', 'stage', 'spec_hash', 'reviewer_session', 'scope_hash',
                'candidates', 'review_evidence', 'inputs', 'registry', 'config_hash',
                'writer_host', 'reviewer_host', 'stop_evidence', 'artifact')
    if proof.get('schema_version') != 2 or proof.get('approved') is not True or not all(proof.get(k) for k in required):
        raise ValueError('SEMANTIC_REVIEW_MISSING: incomplete runtime proof')
    writer, reviewer = proof['writer_host']['capabilities'], proof['reviewer_host']['capabilities']
    if writer['agent_id'] == reviewer['agent_id'] or writer['session_id'] == reviewer['session_id']:
        raise ValueError('SEMANTIC_REVIEW_MISSING: self review')
    if proof['artifact'] not in proof['candidates']:
        raise ValueError('SEMANTIC_REVIEW_MISSING: candidate identity')


def verify_retained_proof(course, proof):
    try:
        return _verify_retained_proof(course, proof)
    except (sqlite3.Error, KeyError, TypeError, AttributeError) as exc:
        raise ValueError('SEMANTIC_REVIEW_STALE: invalid runtime evidence') from exc


def _verify_retained_proof(course, proof):
    """Bind a retained projection to its approved runtime transaction and evidence."""
    validate_proof(proof)
    database = Path(course) / '_工作区/bounded-runtime/runtime.sqlite3'
    db = sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        row = db.execute('SELECT * FROM tasks WHERE id=?', (proof['task_id'],)).fetchone()
        if not row or row['state'] != 'approved' or row['spec_hash'] != proof['spec_hash']:
            raise ValueError('SEMANTIC_REVIEW_STALE: runtime approval')
        review, spec = json.loads(row['review']), json.loads(row['spec'])
        if (proof['stage'] != row['stage'] or proof['registry'] != spec['registry']
                or proof['inputs'] != spec['inputs'] or proof['config_hash'] != spec['config_hash']
                or proof['candidates'] != json.loads(row['candidate'])
                or proof['review_evidence'] != review['evidence']
                or proof['reviewer_session'] != review['session']
                or proof['scope_hash'] != review['scope_hash']
                or proof['writer_host'] != spec['host']
                or proof['reviewer_host'] != review['reviewer_host']
                or proof['stop_evidence'] != json.loads(row['stop']) or review['verdict'] != 'pass'):
            raise ValueError('SEMANTIC_REVIEW_STALE: evidence binding')
    finally:
        db.close()
    for item in proof['review_evidence']:
        archived = inside(Path(course), '_工作区/质量证据/' + item['sha256'] + '.txt')
        receipt = read_json(archived)
        if (receipt.get('verdict') != 'pass' or receipt.get('task_id') != proof['task_id']
                or receipt.get('spec_hash') != proof['spec_hash']
                or receipt.get('scope_hash') != proof['scope_hash']
                or receipt.get('reviewer_session') != proof['reviewer_session']
                or receipt.get('candidate_hashes') != [c['sha256'] for c in proof['candidates']]):
            raise ValueError('SEMANTIC_REVIEW_STALE: archived review')
    config = read_json(Path(course) / '_工作区/课程配置.json')
    index_path = Path(course) / '_工作区/章节索引.json'
    index = read_json(index_path) if index_path.exists() else {}
    rendered_inputs = {str(inside(Path(course), entry['path'])) for group in ('lessons', 'chapters')
                       for entry in index.get(group, [])}
    for item in proof['inputs']:
        source = Path(item['path'])
        if source.is_file() and sha256(source) == item['sha256']:
            continue
        archived = Path(course) / '_工作区/质量证据' / (item['sha256'] + '.txt')
        if str(source) in rendered_inputs and source.is_file():
            if content_hash(source.read_text(encoding='utf-8')) == content_hash(archived.read_text(encoding='utf-8')):
                continue  # Generated relation regions/canonical paths can be re-rendered.
        if config.get('layout') == 'packaged' and not source.exists():
            from convert_materials import PURGE, DOC_FILES, DOC_DIR
            if any(source.is_relative_to(Path(course) / folder) for folder in PURGE):
                continue  # These exact inputs were archived before staging cleanup.
            if source.parent == Path(course) and source.name in DOC_FILES:
                destination = Path(course) / DOC_DIR / source.name
                if destination.exists() and content_hash(destination.read_text(encoding='utf-8')) == content_hash(archived.read_text(encoding='utf-8')):
                    continue
        raise ValueError('SEMANTIC_REVIEW_STALE: current input')


def enabled(course):
    path = Path(course) / '_工作区/课程配置.json'
    return path.exists() and read_json(path).get('execution_profile') == 'bounded-v1'


def content_hash(text):
    """Ignore deterministic relation rendering and relocation, retain prose/labels."""
    from lesson_tasks import semantic
    text = semantic(text)
    # Only canonical block links have a relocation-independent identity.
    text = re.sub(r'\[\[[^\]\n]+#\^([A-Za-z0-9-]+)(\|[^\]\n]*)?\]\]',
                  lambda m: '[[#^' + m[1] + (m[2] or '') + ']]', text)
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def require_artifacts(course, paths):
    if not enabled(course):
        return []
    from bounded_runtime import Runtime
    runtime = Runtime(course)
    try:
        return [runtime.gate_for_artifact(path) for path in paths]
    finally:
        runtime.close()


def check_stage_contract(course, target, gate_id, proofs):
    """An approval for a different stage cannot discharge a delivery gate."""
    stages = {proof['stage'] for proof in proofs}
    index_path = Path(course) / '_工作区/章节索引.json'
    index = read_json(index_path) if index_path.exists() else {}
    lesson = next((row for row in index.get('lessons', []) if row['path'] == target), None)
    expected = None
    if lesson:
        if gate_id != 'G6' or stages != {'lesson', 'path', 'quality'}:
            raise ValueError('SEMANTIC_REVIEW_STALE: lesson stage contract')
        return
    if any(row['path'] == target for row in index.get('chapters', [])):
        expected = 'knowledge'
    elif Path(target).name == '学习路径.md':
        expected = 'path'
    elif Path(target).name == '核心知识点.md':
        expected = 'cards'
    elif target.replace('\\', '/').startswith('资料转写/'):
        expected = 'transcription'
    if expected and (gate_id != 'G7' or stages != {expected}):
        raise ValueError('SEMANTIC_REVIEW_STALE: target stage contract: ' + expected)


def receipt_state(course, target, text, paths, gate_id='G5', separator='\n\n'):
    """Call after deterministic checks. Reviews must already have passed."""
    if not enabled(course):
        return
    proofs = require_artifacts(course, paths)
    if not proofs:
        raise ValueError('SEMANTIC_REVIEW_MISSING: no reviewed inputs')
    check_stage_contract(course, target, gate_id, proofs)
    assembly = None
    if gate_id == 'G7':
        assembled = separator.join(Path(p['artifact']['path']).read_text(encoding='utf-8') for p in proofs)
        if content_hash(assembled) != content_hash(text):
            raise ValueError('REVIEWED_CANDIDATE_MISMATCH')
        assembly = {'separator': separator, 'artifacts': [p['artifact'] for p in proofs]}
    retained = []
    for proof in proofs:
        validate_proof(proof)
        copies = []
        # Preserve exact evidence before package removes lesson staging. These
        # are internal audit artifacts, not additional learner-visible outputs.
        artifacts = proof.get('candidates', []) + proof.get('review_evidence', []) + proof.get('inputs', [])
        artifacts += [proof[key]['receipt'] for key in ('writer_host', 'reviewer_host') if key in proof]
        if proof.get('stop_evidence'):
            artifacts.append(proof['stop_evidence'])
        for item in artifacts:
            source = Path(item['path'])
            if sha256(source) != item['sha256']:
                raise ValueError('SEMANTIC_REVIEW_STALE: evidence changed')
            dest = '_工作区/质量证据/' + item['sha256'] + '.txt'
            # Runtime candidates/evidence are UTF-8 text. Copy via atomic_text
            # preserves the exact bytes for that contract (including CRLF).
            raw = source.read_bytes()
            atomic_text(inside(Path(course), dest), raw.decode('utf-8'))
            if sha256(inside(Path(course), dest)) != item['sha256']:
                raise ValueError('EVIDENCE_COPY_MISMATCH')
            copies.append({'path': dest, 'sha256': item['sha256']})
        retained.append(dict(proof, retained_files=copies))
    path = Path(course) / RECEIPTS
    state = read_json(path) if path.exists() else {'schema_version': 1, 'artifacts': {}}
    # The retained receipt is a projection of runtime evidence, not a new review.
    state['artifacts'][target] = {
        'gate_id': gate_id, 'target_id': target, 'status': 'passed',
        'content_hash': content_hash(text),
        'reviewed_artifacts': list(paths), 'proofs': retained, 'assembly': assembly,
        'metrics': {'structure_checks_passed': True, 'semantic_review_passed': True}}
    return state


def retain(course, target, paths, gate_id='G5', separator='\n\n'):
    if enabled(course):
        state = receipt_state(course, target, inside(Path(course), target).read_text(encoding='utf-8'), paths, gate_id, separator)
        write_json(Path(course) / RECEIPTS, state)


def accept(course, target, candidate):
    """Retain a review for a mechanically published identical artifact."""
    if content_hash(inside(Path(course), target).read_text(encoding='utf-8')) != content_hash(
            inside(Path(course), candidate).read_text(encoding='utf-8')):
        raise ValueError('REVIEWED_CANDIDATE_MISMATCH')
    retain(course, target, [candidate], 'G7')
    return {'target': target, 'review_retained': True}


def accept_chunks(course, target, candidates, separator='\n\n'):
    """Check an exact lossless assembly of bounded candidates (K/KP/path).

    This proves reviewed chunk coverage, not a new global semantic review.
    Cross-unit relations still go through semantic_relations and final gates.
    """
    if not candidates or len(set(candidates)) != len(candidates):
        raise ValueError('DUPLICATE_OR_EMPTY_CANDIDATES')
    full = separator.join(inside(Path(course), p).read_text(encoding='utf-8') for p in candidates)
    if content_hash(inside(Path(course), target).read_text(encoding='utf-8')) != content_hash(full):
        raise ValueError('REVIEWED_CANDIDATE_MISMATCH')
    retain(course, target, candidates, 'G7', separator)
    return {'target': target, 'review_retained': True, 'chunks': len(candidates)}


def check_retained(course, target):
    path = Path(course) / RECEIPTS
    state = read_json(path) if path.exists() else {}
    receipt = state.get('artifacts', {}).get(target)
    if not receipt or not receipt.get('proofs') or receipt.get('status') != 'passed':
        raise ValueError('SEMANTIC_REVIEW_MISSING: ' + target)
    if content_hash(inside(course, target).read_text(encoding='utf-8')) != receipt.get('content_hash'):
        raise ValueError('SEMANTIC_REVIEW_STALE: ' + target)
    expected_paths = {str(inside(Path(course), p)) for p in receipt.get('reviewed_artifacts', [])}
    if (not expected_paths or expected_paths != {p['artifact']['path'] for p in receipt['proofs']}
            or len(expected_paths) != len(receipt['proofs'])):
        raise ValueError('SEMANTIC_REVIEW_MISSING: incomplete artifact proofs')
    if receipt.get('gate_id') == 'G6':
        from lesson_tasks import LEDGER
        ledger = read_json(Path(course) / LEDGER)
        lesson = next((row for row in ledger['lessons'] if row['path'] == target), None)
        attempt = next((row for row in ledger['commits']
                        if lesson and row['id'] == lesson.get('committed_attempt')), None)
        if not attempt or set(attempt.get('reviewed_artifacts', [])) != set(receipt['reviewed_artifacts']):
            raise ValueError('SEMANTIC_REVIEW_MISSING: lesson publication proof coverage')
    for proof in receipt['proofs']:
        verify_retained_proof(course, proof)
        expected_hashes = {item['sha256'] for item in proof['candidates'] + proof['review_evidence'] + proof['inputs']
                           + [proof['writer_host']['receipt'], proof['reviewer_host']['receipt'], proof['stop_evidence']]}
        if {item['sha256'] for item in proof.get('retained_files', [])} != expected_hashes:
            raise ValueError('SEMANTIC_REVIEW_MISSING: incomplete retained evidence')
        for item in proof.get('retained_files', []):
            if sha256(inside(Path(course), item['path'])) != item['sha256']:
                raise ValueError('SEMANTIC_REVIEW_STALE: retained evidence')
        for group in ('policies', 'templates', 'validators'):
            for item in proof.get('registry', {}).get(group, []):
                if not Path(item['path']).is_file() or sha256(Path(item['path'])) != item['sha256']:
                    raise ValueError('SEMANTIC_REVIEW_STALE: policy or validator changed')
    check_stage_contract(course, target, receipt.get('gate_id'), receipt['proofs'])
    if receipt.get('gate_id') == 'G7':
        assembly = receipt.get('assembly') or {}
        if assembly.get('artifacts') != [p['artifact'] for p in receipt['proofs']]:
            raise ValueError('SEMANTIC_REVIEW_STALE: assembly coverage')
        content = assembly['separator'].join((Path(course) / '_工作区/质量证据' / (p['sha256'] + '.txt')).read_text(
            encoding='utf-8') for p in assembly['artifacts'])
        if content_hash(content) != receipt['content_hash']:
            raise ValueError('SEMANTIC_REVIEW_STALE: assembly content')
    return receipt


def relocate(course, moves):
    if not enabled(course):
        return
    path = Path(course) / RECEIPTS
    if not path.exists():
        raise ValueError('SEMANTIC_REVIEW_MISSING: package receipt')
    state = read_json(path)
    changed = {}
    for target, receipt in state['artifacts'].items():
        destination = moves.get(target, target)
        # Validate semantic equivalence before recording a new path.
        if content_hash(inside(course, destination).read_text(encoding='utf-8')) != receipt['content_hash']:
            raise ValueError('SEMANTIC_REVIEW_STALE: relocation changed content: ' + target)
        changed[destination] = dict(receipt, target_id=destination)
    state['artifacts'] = changed
    write_json(path, state)


def final_errors(course, packaged=False):
    if not enabled(course):
        return []
    errors = []
    try:
        index = read_json(Path(course) / '_工作区/章节索引.json')
        targets = [row['path'] for row in index.get('lessons', [])]
        targets += [row['path'] for row in index.get('chapters', [])]
        transcripts = read_json(Path(course) / '_工作区/转写索引.json')
        targets += [row['path'] for row in transcripts.get('sources', [])]
        for name in ('学习路径.md', '核心知识点.md'):
            targets.append(name if (Path(course) / name).exists() else '课程文档/' + name)
        for target in targets:
            try:
                check_retained(course, target)
            except (ValueError, OSError, KeyError) as exc:
                errors.append(str(exc))
        from semantic_relations import audit
        relation_report = audit(course)
        errors.extend(f"{issue['code']}: {issue['target_id']}" for issue in relation_report['issues']
                      if issue['severity'] in {'critical', 'major'})
    except (ValueError, OSError, KeyError) as exc:
        errors.append('QUALITY_GATE_BLOCKED: ' + str(exc))
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--course', type=Path, required=True)
    parser.add_argument('command', choices=['accept', 'accept-chunks', 'check'])
    parser.add_argument('--target')
    parser.add_argument('--candidate')
    parser.add_argument('--manifest', help='JSON {candidates: [course-relative paths], separator: string}')
    args = parser.parse_args()
    try:
        from _common import course_lock
        with course_lock(args.course):
            if args.command == 'accept-chunks':
                manifest = read_json(inside(args.course, args.manifest))
                result = accept_chunks(args.course, args.target, manifest['candidates'], manifest.get('separator', '\n\n'))
            else:
                if args.command == 'accept':
                    result = accept(args.course, args.target, args.candidate)
                else:
                    errors = final_errors(args.course)
                    report = '_工作区/质量门禁报告.json'
                    write_json(args.course / report, {'errors': errors})
                    result = {'errors': len(errors), 'report': report}
        print(json.dumps(result, ensure_ascii=False))
        return int(bool(result.get('errors')))
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({'error': str(exc)[:500]}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
