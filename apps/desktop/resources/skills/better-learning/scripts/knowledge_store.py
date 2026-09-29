"""Rebuildable, bounded retrieval over authoritative course files (no model calls)."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

from _common import inside, read_json, read_jsonl, sha256
from entity_sections import parse_sections

SCHEMA = 2
DB_PATH = '_工作区/知识检索.sqlite3'
TOKEN_METHOD = 'utf8_bytes_upper_bound_not_actual_tokens'


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def file_digest(path):
    return sha256(path) if path.is_file() else None


def _json(course, relative, manifest, default):
    path = inside(course, relative)
    manifest[str(path)] = file_digest(path)
    if not path.exists():
        return default
    return read_jsonl(path) if relative.endswith('.jsonl') else read_json(path)


def _text(course, relative, manifest):
    path = inside(course, relative)
    manifest[str(path)] = file_digest(path)
    # Offsets always refer to decoded UTF-8 with newline translation disabled.
    with path.open(encoding='utf-8', newline='') as stream:
        return stream.read()


def _add(db, key, kind, body, metadata, chapter='', source='', status='', search_extra=''):
    db.execute('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?)',
               (key, kind, chapter, source, status, body, digest(body), packed(metadata),
                (body + '\n' + search_extra).casefold()))


def _coverage(row, source_hash, knowledge, registered_ids, body, transcript_state):
    status = row.get('status', 'unprocessed')
    reasons = []
    if row and row.get('source_hash') != source_hash:
        reasons.append('coverage_source_hash_mismatch')
    if row and status not in {'covered', 'duplicate', 'non_teaching'}:
        reasons.append('coverage_not_resolved')
    ids = row.get('knowledge_ids', [])
    if status in {'covered', 'duplicate'}:
        if not ids or not set(ids) <= knowledge.keys():
            reasons.append('coverage_knowledge_missing')
        if any(not knowledge[k]['body_available'] for k in ids if k in knowledge):
            reasons.append('coverage_knowledge_body_missing')
        if any(knowledge[k]['status'] != 'verified' for k in ids if k in knowledge):
            reasons.append('coverage_knowledge_needs_review')
        if set(ids) != set(registered_ids):
            reasons.append('coverage_backlink_mismatch')
        if transcript_state != 'complete':
            reasons.append('transcript_not_complete')
    if status in {'duplicate', 'non_teaching'} and not row.get('reason'):
        reasons.append('exclusion_reason_missing')
    if status == 'non_teaching' and not row.get('evidence'):
        reasons.append('exclusion_evidence_missing')
    if status == 'non_teaching' and (ids or registered_ids):
        reasons.append('excluded_unit_has_knowledge_links')
    if not row and registered_ids:
        reasons.append('coverage_ledger_missing')
    if transcript_state == 'unresolved':
        reasons.append('transcript_needs_review')
    # These are mechanical ledger claims, never semantic correctness evidence.
    resolved = not reasons and status in {'covered', 'duplicate', 'non_teaching'}
    state = ('needs_review' if reasons else
             'incorporated' if status == 'covered' else
             'excluded' if status in {'duplicate', 'non_teaching'} else
             'transcribed' if transcript_state == 'complete' else 'unprocessed')
    return {'ledger_status': status, 'state': state, 'resolved': resolved, 'reasons': reasons,
            'knowledge_ids': ids, 'registered_knowledge_ids': sorted(registered_ids),
            'available_chars': len(body), 'transcript_state': transcript_state,
            'available_ranges': [[0, len(body)]] if body else [],
            'covered_ranges': None, 'coverage_granularity': 'source_unit_ledger_claim',
            'content_unavailable': not body, 'range_basis': 'decoded_source_unit_text',
            'semantic_quality_verified': False, 'ledger': row}


def build(course: Path):
    """Atomically rebuild SQLite; JSON/JSONL and Markdown remain authoritative."""
    course = course.resolve()
    manifest = {}
    sources = _json(course, '_工作区/资料索引.json', manifest, {'sources': []})['sources']
    chapters = _json(course, '_工作区/章节索引.json', manifest, {'chapters': []})['chapters']
    entries = _json(course, '_工作区/知识索引.jsonl', manifest, [])
    coverage = _json(course, '_工作区/覆盖台账.jsonl', manifest, [])
    transcripts = _json(course, '_工作区/转写索引.json', manifest, {'sources': []})['sources']
    task_ledger = _json(course, '_工作区/转写任务.json', manifest, {})
    task_units = {(s['id'], u['id']): u for s in task_ledger.get('sources', [])
                  for u in s.get('units', [])}
    _json(course, '_工作区/课程配置.json', manifest, {})
    crows = {}
    for row in coverage:
        key = (row['source_id'], row['unit_id'])
        if key in crows:
            raise ValueError('DUPLICATE_COVERAGE: ' + str(key))
        crows[key] = row
    active = [entry for entry in entries if entry.get('status') != 'merged']
    kids = {entry['id'] for entry in active}
    if len(kids) != len(active):
        raise ValueError('DUPLICATE_KNOWLEDGE_ID')
    target = inside(course, DB_PATH)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix='.knowledge-', suffix='.sqlite3', dir=target.parent)
    os.close(handle)
    db = sqlite3.connect(temporary)
    stats = {'source_units': 0, 'resolved_units': 0, 'unprocessed_units': 0,
             'missing_mappings': 0, 'knowledge_items': 0, 'missing_knowledge_bodies': 0,
             'orphan_coverage_rows': 0, 'invalid_knowledge_refs': 0,
             'states': {s: 0 for s in ('unprocessed', 'transcribed', 'incorporated', 'excluded', 'needs_review')}}
    try:
        db.executescript('''CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE documents (key TEXT PRIMARY KEY, kind TEXT NOT NULL,
          chapter TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
          body TEXT NOT NULL, hash TEXT NOT NULL, metadata TEXT NOT NULL, search TEXT NOT NULL);
          CREATE INDEX scope ON documents(kind, chapter, source, status);
          CREATE TABLE source_links (key TEXT NOT NULL, source TEXT NOT NULL,
          PRIMARY KEY(key, source));''')
        section_bodies = {}
        knowledge = {}
        reverse_refs = {}
        for chapter in chapters:
            body = _text(course, chapter['path'], manifest)
            _add(db, 'chapter:' + chapter['id'], 'chapter', body, chapter,
                 chapter=chapter['id'], status=chapter.get('status', ''))
            index = parse_sections(body, strict_registry=False)
            for section in index.sections.values():
                if section.kind == 'K':
                    if section.id in section_bodies:
                        raise ValueError('DUPLICATE_KNOWLEDGE_SECTION: ' + section.id)
                    section_bodies[section.id] = (chapter['id'], body[section.start:section.end],
                                                {'path': chapter['path'], 'start': section.start,
                                                 'end': section.end, 'offset_unit': 'unicode_codepoint'})
        for entry in entries:
            key = 'knowledge:' + entry['id']
            _add(db, 'metadata:' + key, 'metadata', packed(entry), {'owner': key},
                 chapter=entry.get('chapter_id', ''), status=entry.get('status', ''))
            if entry.get('status') == 'merged':
                continue
            found = section_bodies.get(entry['id'])
            if found and found[0] != entry.get('chapter_id'):
                raise ValueError('KNOWLEDGE_CHAPTER_MISMATCH: ' + entry['id'])
            if not found:
                stats['missing_knowledge_bodies'] += 1
            knowledge[entry['id']] = {'body_available': bool(found), 'status': entry.get('status')}
            for ref in entry.get('source_refs', []):
                reverse_refs.setdefault((ref['source_id'], ref['unit_id']), set()).add(entry['id'])
            body = found[1] if found else ''
            metadata = dict(entry, source_span=found[2] if found else None,
                            body_status='available' if found else 'missing_explicit_boundary')
            _add(db, key, 'knowledge', body, metadata, chapter=entry.get('chapter_id', ''),
                 status=entry.get('status', ''), search_extra=packed({
                     field: entry.get(field, []) for field in ('title', 'terms', 'aliases')}))
            for sid in {ref['source_id'] for ref in entry.get('source_refs', [])}:
                db.execute('INSERT INTO source_links VALUES (?,?)', (key, sid))
            stats['knowledge_items'] += 1
        observed = set()
        sids = set()
        for source in sources:
            sid = source['id']
            if sid in sids:
                raise ValueError('DUPLICATE_SOURCE_ID: ' + sid)
            sids.add(sid)
            raw = Path(source['path'])
            raw = (raw if raw.is_absolute() else course / raw).resolve()
            manifest[str(raw)] = file_digest(raw)
            if manifest[str(raw)] != source['sha256']:
                raise ValueError('SOURCE_CHANGED: ' + sid)
            relative = f"_工作区/提取内容/{sid}/{source['sha256']}/定位映射.json"
            mapping = _json(course, relative, manifest, None)
            if mapping is None:
                stats['missing_mappings'] += 1
                _add(db, 'coverage:' + sid, 'coverage', packed({'source_id': sid,
                     'resolved': False, 'reason': 'mapping_missing', 'total_units': None}), source,
                     source=sid, status='unprocessed')
                continue
            if mapping.get('source_hash') != source['sha256']:
                raise ValueError('MAPPING_STALE: ' + sid)
            units = mapping['units']
            if mapping.get('total_units') != len(units) or len({u['id'] for u in units}) != len(units):
                raise ValueError('MAPPING_RANGE_INCOMPLETE: ' + sid)
            records = {}
            transcript_entry = next((t for t in transcripts if t['source_id'] == sid), None)
            if transcript_entry:
                _text(course, transcript_entry['path'], manifest)
                # Reuse existing hash/order/BL-PAGE and v2 source shell validation.
                from transcribe_materials import context, BLOCK, V2_UNIT, V2_TEXT
                _, _, _, _, transcript_text, records = context(course, sid)
            for unit in units:
                uid = unit['id']
                observed.add((sid, uid))
                record = records.get(uid)
                spans = []
                chunks = []
                position = 0
                # Retain every extraction chunk, even when a reviewed transcript exists.
                for i, relative in enumerate(unit.get('chunks', [])):
                    text = _text(course, relative, manifest)
                    chunk_key = f'extraction:{sid}:{uid}:{i}'
                    _add(db, chunk_key, 'extraction', text, {'path': relative, 'start': 0,
                         'end': len(text), 'source_id': sid, 'unit_id': uid,
                         'source_hash': source['sha256'], 'extraction_status': unit.get('status')},
                         source=sid, status=unit.get('status', 'pending'))
                    spans.append({'path': relative, 'start': 0, 'end': len(text),
                                  'body_start': position, 'body_end': position + len(text)})
                    chunks.append(text)
                    position += len(text)
                body = record['body'] if record else ''.join(chunks)
                state = record['state'] if record else 'unprocessed'
                if record:
                    if transcript_entry.get('shell') == 'v2':
                        container = V2_UNIT.match(transcript_text, record['span'][0])
                        payload = V2_TEXT.search(container[2]) if container else None
                        payload_start = container.start(2) + payload.start(2) if payload else -1
                    else:
                        container = BLOCK.match(transcript_text, record['span'][0])
                        payload_start = container.start(5) if container else -1
                    if payload_start < 0 or transcript_text[payload_start:payload_start + len(body)] != body:
                        raise ValueError('TRANSCRIPT_PAYLOAD_SPAN_MISSING')
                    spans = [{'path': transcript_entry['path'], 'start': payload_start,
                              'end': payload_start + len(body), 'newline_mode': 'universal',
                              'container_start': record['span'][0],
                              'container_end': record['span'][1], 'payload_hash': digest(body)}]
                meta = {'source_id': sid, 'unit_id': uid, 'source_hash': source['sha256'],
                        'locator': unit.get('locator'), 'ordinal': unit.get('ordinal'),
                        'spans': spans, 'offset_unit': 'unicode_codepoint', 'transcript_state': state,
                        'extraction_status': unit.get('status'), 'unit': unit}
                _add(db, f'source:{sid}:{uid}', 'source', body, meta, source=sid, status=state)
                cov = _coverage(crows.get((sid, uid), {}), source['sha256'], knowledge,
                                reverse_refs.get((sid, uid), set()), body, state)
                if task_ledger:
                    task_status = task_units.get((sid, uid), {}).get('status')
                    cov['task_status'] = task_status
                    if task_status not in {'done', 'non_teaching', 'duplicate'}:
                        cov['resolved'] = False
                        cov['state'] = 'needs_review' if record or crows.get((sid, uid)) else 'unprocessed'
                        cov['reasons'].append('task_unit_not_complete')
                cov.update(source_id=sid, unit_id=uid, source_hash=source['sha256'])
                _add(db, f'coverage:{sid}:{uid}', 'coverage', packed(cov), meta, source=sid,
                     status=cov['state'])
                stats['source_units'] += 1
                stats['states'][cov['state']] += 1
                stats['resolved_units' if cov['resolved'] else 'unprocessed_units'] += 1
        for key, row in crows.items():
            if key not in observed:
                stats['orphan_coverage_rows'] += 1
                _add(db, 'orphan-coverage:' + ':'.join(key), 'coverage', packed(row),
                     {'reason': 'unit_not_in_current_source_mapping'}, source=key[0], status='orphan')
        for entry in active:
            refs = entry.get('source_refs', [])
            invalid = [ref for ref in refs if (ref['source_id'], ref['unit_id']) not in observed]
            stats['invalid_knowledge_refs'] += len(invalid)
            claims = [{'source_id': sid, 'unit_id': uid, 'status': row.get('status')}
                      for (sid, uid), row in crows.items() if entry['id'] in row.get('knowledge_ids', [])]
            matrix = {'knowledge_id': entry['id'], 'source_refs': refs,
                      'ledger_claims': claims, 'invalid_source_refs': invalid,
                      'body_available': knowledge[entry['id']]['body_available'],
                      'semantic_quality_verified': False}
            matrix_key = 'knowledge-coverage:' + entry['id']
            _add(db, matrix_key, 'coverage', packed(matrix), {'knowledge_id': entry['id']},
                 chapter=entry.get('chapter_id', ''), status='needs_review' if invalid else 'matrix')
            for sid in {ref['source_id'] for ref in refs}:
                db.execute('INSERT INTO source_links VALUES (?,?)', (matrix_key, sid))
        # No file may change between parsing and publishing the derived snapshot.
        if any(file_digest(Path(path)) != value for path, value in manifest.items()):
            raise ValueError('INPUT_CHANGED_DURING_BUILD')
        version = digest(packed({'schema': SCHEMA, 'manifest': manifest}))
        for key, value in {'schema': SCHEMA, 'version': version, 'manifest': manifest,
                           'stats': stats}.items():
            db.execute('INSERT INTO meta VALUES (?,?)', (key, packed(value)))
        db.commit()
        db.close()
        os.replace(temporary, target)
        return {'version': version, 'index': DB_PATH, **stats, 'semantic_quality_verified': False}
    finally:
        db.close()
        if os.path.exists(temporary):
            os.unlink(temporary)


def _open(course):
    path = inside(course.resolve(), DB_PATH)
    if not path.exists():
        raise ValueError('INDEX_MISSING: run build')
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        meta = {row['key']: json.loads(row['value']) for row in db.execute('SELECT * FROM meta')}
        if meta['schema'] != SCHEMA:
            raise ValueError('INDEX_SCHEMA_CHANGED: run build')
        if any(file_digest(Path(path)) != value for path, value in meta['manifest'].items()):
            raise ValueError('INDEX_STALE: authoritative input changed; run build')
        return db, meta
    except Exception:
        db.close()
        raise


def _cursor(version, signature, key, offset):
    return base64.urlsafe_b64encode(packed([version, signature, key, offset]).encode()).decode()


def _decode_cursor(value, version, signature):
    try:
        v, s, key, offset = json.loads(base64.b64decode(value, altchars=b'-_', validate=True))
        if v != version or s != signature:
            raise ValueError('CURSOR_STALE_OR_QUERY_CHANGED')
        if not isinstance(key, str) or type(offset) is not int or offset < 0:
            raise ValueError('INVALID_CURSOR')
        return key, offset
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ValueError('INVALID_CURSOR_OR_QUERY_VERSION: ' + str(exc)) from exc


def _envelope(version, items, next_cursor):
    result = {'version': version, 'items': items, 'returned_items': len(items),
              'returned_tokens': 0, 'token_method': TOKEN_METHOD,
              'truncated': next_cursor is not None, 'has_more': next_cursor is not None,
              'next_cursor': next_cursor}
    # Count the complete compact JSON response, including this field and cursor.
    while True:
        size = len(packed(result).encode('utf-8'))
        if size == result['returned_tokens']:
            return result
        result['returned_tokens'] = size


def query(course: Path, *, terms=(), kind='knowledge', chapter=None, source=None,
          status=None, key=None, metadata=False, max_items=8, max_tokens=12000, cursor=None):
    """Return contiguous ranges; continue until has_more is false to read all matches.

    Terms use literal Unicode substring AND matching over body and registered
    title/terms/aliases; no implicit stemming, external search or semantic recall.
    """
    if not 1 <= max_items <= 100 or not 1024 <= max_tokens <= 1000000:
        raise ValueError('BUDGET_INVALID: max_items 1..100; max_tokens 1024..1000000')
    spec = dict(terms=sorted(set(t.casefold() for t in terms if t)), kind=kind,
                chapter=chapter, source=source, status=status, key=key, metadata=metadata)
    signature = digest(packed(spec))
    db, meta = _open(course)
    try:
        version = meta['version']
        last_key, offset = _decode_cursor(cursor, version, signature) if cursor else ('', 0)
        predicates, args = ['key >= ?'], [last_key]
        for name, value in [('kind', kind if not key else None), ('chapter', chapter),
                            ('status', status), ('key', key)]:
            if value is not None:
                predicates.append(name + ' = ?')
                args.append(value)
        if source is not None:
            predicates.append('(source = ? OR key IN (SELECT key FROM source_links WHERE source = ?))')
            args.extend([source, source])
        for term in spec['terms']:
            predicates.append('instr(search, ?) > 0')
            args.append(term)
        rows = db.execute('SELECT * FROM documents WHERE ' + ' AND '.join(predicates) + ' ORDER BY key', args)
        if cursor:
            scoped = db.execute('SELECT key FROM documents WHERE ' + ' AND '.join(predicates)
                                + ' AND key = ?', [*args, last_key]).fetchone()
            if scoped is None:
                raise ValueError('INVALID_CURSOR_KEY')
        items = []
        def finish(next_key=None, next_offset=0):
            continuation = _cursor(version, signature, next_key, next_offset) if next_key is not None else None
            result = _envelope(version, items, continuation)
            # A next key may serialize longer than the preceding key. Rewind a
            # complete returned range if its continuation metadata needs room.
            while result['returned_tokens'] > max_tokens and items:
                rewind = items.pop()
                result = _envelope(version, items, _cursor(version, signature, rewind['key'], rewind['range'][0]))
            if not items and result['has_more']:
                raise ValueError('BUDGET_TOO_SMALL_FOR_RECORD: increase max_tokens')
            return result
        for row in rows:
            body = row['metadata'] if metadata else row['body']
            content_hash = digest(body) if metadata else row['hash']
            start = offset if row['key'] == last_key else 0
            if start > len(body):
                raise ValueError('INVALID_CURSOR_RANGE')
            if start == len(body) and len(body) > 0:
                continue
            while start < len(body) or not body:
                if len(items) >= max_items:
                    return finish(row['key'], start)
                def candidate(end):
                    item = {'key': row['key'], 'kind': row['kind'], 'field': 'metadata' if metadata else 'body',
                            'range': [start, end], 'total_chars': len(body),
                            'content_hash': content_hash, 'text': body[start:end]}
                    return _envelope(version, items + [item], _cursor(version, signature, row['key'], end))
                # At least one UTF-8 byte per codepoint. Bound the candidate
                # window before serializing; never rescan a million-char tail.
                lo, hi = start, min(len(body), start + max_tokens)
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    if candidate(mid)['returned_tokens'] <= max_tokens:
                        lo = mid
                    else:
                        hi = mid - 1
                result = candidate(lo)
                if result['returned_tokens'] > max_tokens or (lo == start and body):
                    if not items:
                        raise ValueError('BUDGET_TOO_SMALL_FOR_RECORD: increase max_tokens')
                    return finish(row['key'], start)
                items = result['items']
                start = lo
                if start < len(body):
                    return result
                break
        if key and not items and not cursor:
            raise ValueError('KEY_NOT_FOUND: ' + key)
        return finish()
    finally:
        db.close()


def read(course: Path, key: str, **kwargs):
    return query(course, key=key, **kwargs)


def audit(course: Path):
    db, meta = _open(course)
    try:
        stats = meta['stats']
        return {'version': meta['version'], **stats,
                'mechanical_coverage_complete': bool(stats['source_units']) and not any(
                    stats[k] for k in ('unprocessed_units', 'missing_mappings', 'orphan_coverage_rows',
                                      'missing_knowledge_bodies', 'invalid_knowledge_refs')),
                'semantic_quality_verified': False,
                'details': 'query --kind coverage; read --metadata for complete provenance'}
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--course', required=True, type=Path)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('build')
    sub.add_parser('audit')
    for command in ('query', 'read'):
        p = sub.add_parser(command)
        p.add_argument('--max-items', type=int, default=8)
        p.add_argument('--max-tokens', type=int, default=12000)
        p.add_argument('--cursor')
        p.add_argument('--metadata', action='store_true')
        if command == 'read':
            p.add_argument('--key', required=True)
        else:
            p.add_argument('--term', action='append', default=[], dest='terms')
            p.add_argument('--kind', default='knowledge',
                           choices=['knowledge', 'chapter', 'source', 'extraction', 'coverage', 'metadata'])
            p.add_argument('--chapter')
            p.add_argument('--source')
            p.add_argument('--status')
    args = vars(parser.parse_args())
    command = args.pop('command')
    course = args.pop('course')
    try:
        result = globals()[command](course, **args)
        # No extra newline: the complete successful stdout equals the budgeted JSON.
        sys.stdout.write(packed(result))
        return 0
    except (OSError, ValueError, KeyError, sqlite3.Error) as exc:
        print(packed({'error': str(exc)}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
