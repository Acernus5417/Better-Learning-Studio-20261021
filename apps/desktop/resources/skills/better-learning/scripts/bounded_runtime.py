"""Persistent, fail-closed candidate runtime; never publishes course artifacts.

Budgets use UTF-8 bytes as an uncalibrated accounting unit, not model tokens. Host receipts are supplied
by a trusted adapter; this module cannot itself spawn or prove host isolation.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid

SCHEMA_VERSION = 2
CALL_LIMIT = 131072
SESSION_LIMIT = 524288
READ_LIMIT = 8192
OUTPUT_LIMIT = 32768
TOOL_LIMIT = 16384
PAGE_LIMIT = 50
MAX_FILES = 64
SPEC_LIMIT = 32768
STAGES = {
    'transcription': (['worker-policy.md', 'material-processing.md'], [], ['convert_materials.py']),
    'knowledge': (['knowledge-model.md'], ['knowledge-chapter.md'], ['assemble_knowledge.py']),
    'path': (['learning-path.md'], ['learning-path.md', 'lesson-blueprint.json'], ['validate_package.py']),
    'lesson': (['chapter-writing.md', 'lesson-writing-policy.md', 'lesson-pipeline.md'], ['learning-chapter.md'], ['lesson_tasks.py']),
    'cards': (['core-cards.md'], ['core-card.md'], ['core_cards.py']),
    'relations': (['obsidian-links.md'], [], ['obsidian_links.py']),
    'quality': (['quality-checks.md', 'delivery-layout.md'], [], ['validate_package.py']),
}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def snapshot(path):
    path = Path(path).resolve()
    return {'path': str(path), 'sha256': digest(path), 'bytes': path.stat().st_size}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def bounded_json(path, limit=SPEC_LIMIT):
    require(Path(path).stat().st_size <= limit, 'RECORD_TOO_LARGE')
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def policy_registry(stage, skill_root=None):
    require(stage in STAGES, 'UNKNOWN_STAGE')
    root = Path(skill_root or Path(__file__).resolve().parents[1]).resolve()
    refs, templates, validators = STAGES[stage]
    # Runtime and validator source changes invalidate old task contracts too.
    groups = {
        'policies': [root / 'SKILL.md', root / 'references/host-adapter.md',
                     root / 'references/bounded-pipeline.md'] + [root / 'references' / p for p in refs],
        'templates': [root / 'assets/templates' / p for p in templates],
        'validators': [root / 'scripts' / p for p in validators] + [Path(__file__).resolve(),
                       root / 'scripts/quality_gates.py', root / 'scripts/bounded_pipeline.py',
                       root / 'scripts/semantic_relations.py'],
    }
    return {'schema_version': SCHEMA_VERSION, 'stage': stage,
            **{key: [snapshot(p) for p in paths] for key, paths in groups.items()}}


class Runtime:
    def __init__(self, course, skill_root=None):
        self.course = Path(course).resolve()
        self.skill_root = Path(skill_root or Path(__file__).resolve().parents[1]).resolve()
        folder = self.course / '_工作区' / 'bounded-runtime'
        folder.mkdir(parents=True, exist_ok=True)
        self.db_path = folder / 'runtime.sqlite3'
        self.db = sqlite3.connect(self.db_path, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS meta(version INTEGER NOT NULL);
        INSERT INTO meta SELECT 2 WHERE NOT EXISTS(SELECT 1 FROM meta);
        CREATE TABLE IF NOT EXISTS sessions(
          id TEXT PRIMARY KEY, agent TEXT NOT NULL, evidence TEXT NOT NULL,
          spent INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS tasks(
          id TEXT PRIMARY KEY, stage TEXT NOT NULL, state TEXT NOT NULL,
          spec TEXT NOT NULL, spec_hash TEXT NOT NULL, session TEXT NOT NULL,
          lease TEXT, lease_until REAL, attempt INTEGER NOT NULL DEFAULT 0,
          read_bytes INTEGER NOT NULL DEFAULT 0, candidate TEXT, review TEXT,
          stop TEXT, FOREIGN KEY(session) REFERENCES sessions(id));
        CREATE TABLE IF NOT EXISTS handoffs(
          id TEXT PRIMARY KEY, old_session TEXT NOT NULL, new_session TEXT,
          payload TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS review_attempts(
          task TEXT PRIMARY KEY REFERENCES tasks(id), session TEXT NOT NULL REFERENCES sessions(id),
          token TEXT NOT NULL, scope TEXT NOT NULL, scope_hash TEXT NOT NULL,
          budget INTEGER NOT NULL, read_bytes INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS review_reads(
          task TEXT NOT NULL REFERENCES review_attempts(task), path TEXT NOT NULL,
          start INTEGER NOT NULL, end INTEGER NOT NULL);
        ''')
        require(self.db.execute('SELECT version FROM meta').fetchone()[0] == SCHEMA_VERSION, 'RUNTIME_SCHEMA_MISMATCH')

    def close(self):
        self.db.close()

    @contextmanager
    def _tx(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def _session(self, session_id):
        row = self.db.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
        require(row is not None and row['active'], 'SESSION_UNAVAILABLE')
        self._check_snapshot(json.loads(row['evidence'])['receipt'])
        return row

    def _task(self, task_id):
        row = self.db.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone()
        require(row is not None, 'UNKNOWN_TASK')
        return row

    def _inside(self, path):
        path = (self.course / path).resolve()
        require(path.is_relative_to(self.course), 'PATH_OUTSIDE_COURSE')
        return path

    @staticmethod
    def _check_snapshot(item):
        path = Path(item['path'])
        require(path.is_file() and digest(path) == item['sha256'], 'STALE_INPUT: ' + str(path))

    def _fresh(self, task_id):
        row = self._task(task_id)
        spec = json.loads(row['spec'])
        try:
            require(hashlib.sha256(encoded(spec)).hexdigest() == row['spec_hash'], 'SPEC_HASH_MISMATCH')
            require(spec['config_hash'] == hashlib.sha256(encoded(spec['config'])).hexdigest(), 'CONFIG_HASH_MISMATCH')
            for item in spec['inputs'] + spec['registry']['policies'] + spec['registry']['templates'] + spec['registry']['validators']:
                self._check_snapshot(item)
            require(spec['registry'] == policy_registry(spec['stage'], self.skill_root), 'POLICY_REGISTRY_CHANGED')
            self._check_snapshot(spec['host']['receipt'])
        except (ValueError, OSError):
            self.db.execute("UPDATE tasks SET state='stale' WHERE id=?", (task_id,))
            raise ValueError('STALE_TASK: ' + task_id)
        require(row['state'] != 'stale', 'STALE_TASK: ' + task_id)
        return row, spec

    def register_session(self, evidence):
        """Register an actual adapter receipt, not a generated isolation claim.

        evidence = {receipt_path: path}; receipt JSON fields are documented below.
        The adapter is the trust boundary, not the writer agent.
        """
        receipt = snapshot(self._inside(evidence['receipt_path']))
        data = bounded_json(receipt['path'])
        for key in ('session_id', 'agent_id', 'host', 'event_id', 'issuer'):
            require(isinstance(data.get(key), str) and 0 < len(data[key]) <= 200, 'INVALID_HOST_RECEIPT: ' + key)
        require(data.get('kind') == 'host-session' and data.get('independent_context') is True,
                'INDEPENDENT_SESSION_NOT_ATTESTED')
        require(data.get('can_write') is True and data.get('context_history') == 'none', 'HOST_CAPABILITY_MISSING')
        require(isinstance(data.get('can_review'), bool), 'HOST_CAPABILITY_MISSING')
        record = {'receipt': receipt, 'capabilities': data}
        with self._tx():
            old = self.db.execute('SELECT evidence FROM sessions WHERE id=?', (data['session_id'],)).fetchone()
            if old:
                require(json.loads(old[0]) == record, 'SESSION_ID_REUSED')
            else:
                self.db.execute('INSERT INTO sessions(id,agent,evidence) VALUES(?,?,?)',
                                (data['session_id'], data['agent_id'], encoded(record).decode()))
        return {'session_id': data['session_id'], 'registered': True, 'isolation_attested_by': data['issuer']}

    def create_task(self, task_id, stage, inputs, config, session_id,
                    output_reserve=16384, tool_reserve=8192):
        require(isinstance(task_id, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', task_id), 'INVALID_TASK_ID')
        require(0 < len(inputs) <= MAX_FILES and len(set(inputs)) == len(inputs), 'INPUT_COUNT_LIMIT')
        require(isinstance(config, dict) and len(encoded(config)) <= 8192, 'CONFIG_LIMIT')
        require(type(output_reserve) is int and 0 < output_reserve <= OUTPUT_LIMIT, 'OUTPUT_LIMIT')
        require(type(tool_reserve) is int and 0 < tool_reserve <= TOOL_LIMIT, 'TOOL_LIMIT')
        session = self._session(session_id)
        registry = policy_registry(stage, self.skill_root)
        bound = [snapshot(self._inside(p)) for p in inputs]
        spec = {'schema_version': SCHEMA_VERSION, 'task_id': task_id, 'stage': stage,
                'inputs': bound, 'config': config, 'config_hash': hashlib.sha256(encoded(config)).hexdigest(),
                'registry': registry, 'host': json.loads(session['evidence']),
                'budget': {'unit': 'utf8-bytes', 'call_limit': CALL_LIMIT,
                           'session_limit': SESSION_LIMIT, 'output_reserve': output_reserve,
                           'tool_reserve': tool_reserve}}
        require(len(encoded(spec)) <= SPEC_LIMIT, 'SPEC_LIMIT')
        # Policy and template contents must enter the worker context; validator code need not.
        input_cost = sum(p['bytes'] for p in bound + registry['policies'] + registry['templates']) + READ_LIMIT
        # Reserve the actual immutable specification, not the maximum permitted
        # record size. Slack covers the budget fields inserted below; never
        # lower or omit source/policy content to fit the call limit.
        spec_reserve = len(encoded(spec)) + 512
        reserve = input_cost + spec_reserve + output_reserve + tool_reserve
        require(reserve <= CALL_LIMIT, 'SPLIT_REQUIRED: call budget')
        spec['budget'].update(input_reserve=input_cost, spec_reserve=spec_reserve, total_reserve=reserve)
        packed = encoded(spec).decode()
        require(len(packed.encode('utf-8')) <= SPEC_LIMIT, 'SPEC_LIMIT')
        require(len(packed.encode('utf-8')) <= spec_reserve, 'SPEC_RESERVE_EXCEEDED')
        spec_hash = hashlib.sha256(packed.encode()).hexdigest()
        with self._tx():
            previous = self.db.execute('SELECT spec_hash FROM tasks WHERE id=?', (task_id,)).fetchone()
            if previous:
                require(previous[0] == spec_hash, 'TASK_ID_CONFLICT')
                return {'task_id': task_id, 'spec_hash': spec_hash, 'idempotent': True}
            session = self._session(session_id)
            require(session['spent'] + reserve <= SESSION_LIMIT, 'HANDOFF_REQUIRED: session budget')
            self.db.execute('UPDATE sessions SET spent=spent+? WHERE id=?', (reserve, session_id))
            self.db.execute('INSERT INTO tasks(id,stage,state,spec,spec_hash,session) VALUES(?,?,?,?,?,?)',
                            (task_id, stage, 'ready', packed, spec_hash, session_id))
        return {'task_id': task_id, 'spec_hash': spec_hash, 'state': 'ready', 'reserved': reserve}

    def task_spec(self, task_id):
        return self._fresh(task_id)[1]

    def claim(self, task_id, session_id):
        self._fresh(task_id)
        with self._tx():
            row = self._task(task_id)
            self._session(session_id)
            require(row['session'] == session_id and row['state'] == 'ready', 'TASK_NOT_CLAIMABLE')
            lease = uuid.uuid4().hex
            self.db.execute("UPDATE tasks SET state='running',lease=?,lease_until=?,attempt=attempt+1 WHERE id=?",
                            (lease, time.time() + 900, task_id))
        return {'task_id': task_id, 'lease': lease, 'lease_seconds': 900}

    def _owned(self, task_id, lease):
        row = self._task(task_id)
        self._session(row['session'])
        require(row['state'] == 'running' and row['lease'] == lease, 'LEASE_MISMATCH')
        require(row['lease_until'] > time.time(), 'LEASE_EXPIRED_REQUIRES_STOP_EVIDENCE')
        return row

    def read_input(self, task_id, lease, path, offset=0, limit=READ_LIMIT):
        require(type(offset) is int and offset >= 0 and type(limit) is int and 0 < limit <= READ_LIMIT, 'READ_LIMIT')
        _, spec = self._fresh(task_id)
        path = str(Path(path).resolve()) if Path(path).is_absolute() else str(self._inside(path))
        allowed = spec['inputs'] + spec['registry']['policies'] + spec['registry']['templates']
        items = {p['path']: p for p in allowed}
        require(path in items, 'READ_NOT_IN_SPEC')
        require(offset <= items[path]['bytes'], 'READ_OFFSET_OUTSIDE_FILE')
        charge = max(1, min(limit, items[path]['bytes'] - offset))
        with self._tx():
            row = self._owned(task_id, lease)
            # Reserve before doing the read, including repeated reads; never refund.
            require(row['read_bytes'] + charge <= spec['budget']['input_reserve'], 'READ_BUDGET_EXHAUSTED')
            self.db.execute('UPDATE tasks SET read_bytes=read_bytes+? WHERE id=?', (charge, task_id))
        result = self._read_text(path, offset, limit)
        self._check_snapshot(items[path])
        return result

    @staticmethod
    def _read_text(path, offset, limit):
        with open(path, 'rb') as stream:
            stream.seek(offset)
            raw = stream.read(limit)
        # Offsets are bytes; avoid dropping split Unicode code points.
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError as exc:
            require(exc.end == len(raw) and exc.reason == 'unexpected end of data', 'OFFSET_NOT_UTF8_BOUNDARY')
            raw = raw[:exc.start]
            require(bool(raw), 'READ_LIMIT_TOO_SMALL_FOR_UTF8')
            text = raw.decode('utf-8')
        return {'text': text, 'next_offset': offset + len(raw), 'eof': offset + len(raw) >= Path(path).stat().st_size}

    def _stop(self, row, evidence):
        require(isinstance(row['lease'], str) and bool(row['lease']), 'STOP_REQUIRES_LEASE')
        item = snapshot(self._inside(evidence['receipt_path']))
        data = bounded_json(item['path'])
        session = self.db.execute('SELECT * FROM sessions WHERE id=?', (row['session'],)).fetchone()
        caps = json.loads(session['evidence'])['capabilities']
        require(data.get('kind') == 'host-stop' and data.get('state') in ('completed', 'stopped', 'failed'), 'STOP_NOT_CONFIRMED')
        require(data.get('session_id') == row['session'] and data.get('agent_id') == session['agent']
                and data.get('lease') == row['lease'] and data.get('task_id') == row['id']
                and data.get('issuer') == caps['issuer'] and data.get('event_id'), 'STOP_EVIDENCE_MISMATCH')
        return item

    def submit_candidate(self, task_id, lease, paths, stop_evidence):
        row, spec = self._fresh(task_id)
        require(0 < len(paths) <= MAX_FILES and len(set(paths)) == len(paths), 'CANDIDATE_COUNT_LIMIT')
        candidates = [snapshot(self._inside(p)) for p in paths]
        require(all(Path(p['path']).is_relative_to(self.course / '_工作区') for p in candidates), 'CANDIDATE_MUST_BE_STAGED')
        require(sum(p['bytes'] for p in candidates) <= spec['budget']['output_reserve'], 'OUTPUT_BUDGET_EXCEEDED')
        stop = self._stop(row, stop_evidence)
        with self._tx():
            row = self._task(task_id)
            if row['state'] in ('candidate', 'approved', 'rejected'):
                require(row['lease'] == lease and json.loads(row['candidate']) == candidates, 'CANDIDATE_CONFLICT')
                return {'task_id': task_id, 'state': row['state'], 'idempotent': True}
            require(row['state'] == 'running' and row['lease'] == lease, 'LEASE_MISMATCH')
            self.db.execute("UPDATE tasks SET state='candidate',candidate=?,stop=? WHERE id=?",
                            (encoded(candidates).decode(), encoded(stop).decode(), task_id))
        return {'task_id': task_id, 'state': 'candidate'}

    def _reviewer(self, row, reviewer_session):
        reviewer = self._session(reviewer_session)
        writer = self.db.execute('SELECT * FROM sessions WHERE id=?', (row['session'],)).fetchone()
        require(reviewer['id'] != writer['id'] and reviewer['agent'] != writer['agent'], 'WRITER_CANNOT_SELF_REVIEW')
        require(json.loads(reviewer['evidence'])['capabilities']['can_review'], 'REVIEW_CAPABILITY_MISSING')
        return reviewer

    def _review_scope(self, row, spec):
        require(row['candidate'] is not None, 'NO_CANDIDATE')
        candidates = json.loads(row['candidate'])
        scope = {'inputs': spec['inputs'], 'candidates': candidates,
                 'policies': spec['registry']['policies'], 'templates': spec['registry']['templates']}
        for item in [p for group in scope.values() for p in group]:
            self._check_snapshot(item)
        return scope

    def prepare_review(self, task_id, reviewer_session):
        """Reserve reviewer context before returning a bounded immutable scope manifest."""
        row, spec = self._fresh(task_id)
        self._reviewer(row, reviewer_session)
        scope = self._review_scope(row, spec)
        scope_hash = hashlib.sha256(encoded(scope)).hexdigest()
        # Allow one full read and bounded repeated reads; output includes the receipt.
        read_budget = sum(p['bytes'] for group in scope.values() for p in group) + READ_LIMIT
        scope_bytes = len(encoded(scope))
        require(scope_bytes <= SPEC_LIMIT, 'SPEC_LIMIT: review scope')
        cost = read_budget + scope_bytes + 512 + TOOL_LIMIT
        require(cost <= CALL_LIMIT, 'SPLIT_REQUIRED: review budget')
        with self._tx():
            row = self._task(task_id)
            old = self.db.execute('SELECT * FROM review_attempts WHERE task=?', (task_id,)).fetchone()
            if old:
                require(old['session'] == reviewer_session and old['scope_hash'] == scope_hash, 'REVIEW_ALREADY_ASSIGNED')
                token = old['token']
            else:
                require(row['state'] == 'candidate', 'TASK_NOT_REVIEWABLE')
                reviewer = self._reviewer(row, reviewer_session)
                require(reviewer['spent'] + cost <= SESSION_LIMIT, 'HANDOFF_REQUIRED: reviewer budget')
                token = uuid.uuid4().hex
                self.db.execute('UPDATE sessions SET spent=spent+? WHERE id=?', (cost, reviewer_session))
                self.db.execute('INSERT INTO review_attempts(task,session,token,scope,scope_hash,budget) VALUES(?,?,?,?,?,?)',
                                (task_id, reviewer_session, token, encoded(scope).decode(), scope_hash, read_budget))
        return {'task_id': task_id, 'review_token': token, 'scope': scope, 'scope_hash': scope_hash,
                'spec_hash': row['spec_hash'], 'reserved': cost}

    def _review_attempt(self, task_id, reviewer_session, review_token=None):
        row, spec = self._fresh(task_id)
        self._reviewer(row, reviewer_session)
        attempt = self.db.execute('SELECT * FROM review_attempts WHERE task=?', (task_id,)).fetchone()
        require(attempt is not None and attempt['session'] == reviewer_session, 'REVIEW_NOT_PREPARED')
        if review_token is not None:
            require(attempt['token'] == review_token, 'REVIEW_TOKEN_MISMATCH')
        scope = self._review_scope(row, spec)
        require(encoded(scope).decode() == attempt['scope'] and
                hashlib.sha256(encoded(scope)).hexdigest() == attempt['scope_hash'], 'REVIEW_SCOPE_CHANGED')
        return row, attempt, scope

    def read_review(self, task_id, reviewer_session, review_token, path, offset=0, limit=READ_LIMIT):
        require(type(offset) is int and offset >= 0 and type(limit) is int and 0 < limit <= READ_LIMIT, 'READ_LIMIT')
        row, attempt, scope = self._review_attempt(task_id, reviewer_session, review_token)
        require(row['state'] == 'candidate', 'TASK_NOT_REVIEWABLE')
        path = str(Path(path).resolve()) if Path(path).is_absolute() else str(self._inside(path))
        items = {p['path']: p for group in scope.values() for p in group}
        require(path in items, 'READ_NOT_IN_REVIEW_SCOPE')
        require(offset <= items[path]['bytes'], 'READ_OFFSET_OUTSIDE_FILE')
        charge = max(1, min(limit, items[path]['bytes'] - offset))
        with self._tx():
            attempt = self.db.execute('SELECT * FROM review_attempts WHERE task=?', (task_id,)).fetchone()
            require(attempt['read_bytes'] + charge <= attempt['budget'], 'REVIEW_READ_BUDGET_EXHAUSTED')
            self.db.execute('UPDATE review_attempts SET read_bytes=read_bytes+? WHERE task=?', (charge, task_id))
        result = self._read_text(path, offset, limit)
        self._check_snapshot(items[path])
        self.db.execute('INSERT INTO review_reads(task,path,start,end) VALUES(?,?,?,?)',
                        (task_id, path, offset, result['next_offset']))
        return result

    def _coverage(self, task_id, scope):
        for item in {p['path']: p for group in scope.values() for p in group}.values():
            end = 0
            reads = self.db.execute('SELECT start,end FROM review_reads WHERE task=? AND path=? ORDER BY start,end',
                                    (task_id, item['path'])).fetchall()
            require(bool(reads), 'REVIEW_SCOPE_NOT_FULLY_READ: ' + item['path'])
            for interval in reads:
                if interval['start'] > end:
                    break
                end = max(end, interval['end'])
            require(end >= item['bytes'], 'REVIEW_SCOPE_NOT_FULLY_READ: ' + item['path'])

    def review(self, task_id, reviewer_session, verdict, evidence_paths):
        row, attempt, scope = self._review_attempt(task_id, reviewer_session)
        self._coverage(task_id, scope)
        require(verdict in ('pass', 'fail'), 'INVALID_VERDICT')
        require(0 < len(evidence_paths) <= MAX_FILES and len(set(evidence_paths)) == len(evidence_paths), 'REVIEW_EVIDENCE_REQUIRED')
        candidates = scope['candidates']
        evidence = [snapshot(self._inside(p)) for p in evidence_paths]
        require(sum(p['bytes'] for p in evidence) <= TOOL_LIMIT, 'REVIEW_EVIDENCE_TOO_LARGE')
        # A receipt is structured evidence, never a bare Boolean approval.
        for item in evidence:
            receipt = bounded_json(item['path'], TOOL_LIMIT)
            require(receipt.get('kind') == 'semantic-review' and receipt.get('task_id') == task_id
                    and receipt.get('spec_hash') == row['spec_hash'] and receipt.get('reviewer_session') == reviewer_session
                    and receipt.get('verdict') == verdict and receipt.get('candidate_hashes') == [p['sha256'] for p in candidates]
                    and receipt.get('scope_hash') == attempt['scope_hash']
                    and receipt.get('scope') == scope, 'REVIEW_RECEIPT_MISMATCH')
            checks = ('source_fidelity', 'coverage', 'pedagogy', 'relations')
            findings = receipt.get('findings')
            require(isinstance(findings, list) and 0 < len(findings) <= 100, 'REVIEW_FINDINGS_REQUIRED')
            allowed_paths = {p['path'] for group in scope.values() for p in group}
            for finding in findings:
                require(isinstance(finding, dict) and finding.get('check') in checks
                        and finding.get('path') in allowed_paths and finding.get('result') in ('pass', 'fail')
                        and isinstance(finding.get('detail'), str) and bool(finding['detail'].strip()), 'INVALID_REVIEW_FINDING')
            require({f['check'] for f in findings} == set(checks), 'REVIEW_CHECKS_MISSING')
            require(all(f['result'] == 'pass' for f in findings) if verdict == 'pass'
                    else any(f['result'] == 'fail' for f in findings), 'REVIEW_VERDICT_CONFLICT')
        review = {'session': reviewer_session, 'verdict': verdict, 'evidence': evidence,
                  'candidate_hashes': [p['sha256'] for p in candidates], 'spec_hash': row['spec_hash'],
                  'scope_hash': attempt['scope_hash'], 'reviewer_host': json.loads(self._session(reviewer_session)['evidence'])}
        with self._tx():
            row = self._task(task_id)
            if row['review']:
                require(json.loads(row['review']) == review, 'REVIEW_ALREADY_RECORDED')
                return {'task_id': task_id, 'state': row['state'], 'idempotent': True}
            require(row['state'] == 'candidate', 'TASK_NOT_REVIEWABLE')
            state = 'approved' if verdict == 'pass' else 'rejected'
            self.db.execute('UPDATE tasks SET state=?,review=? WHERE id=?', (state, encoded(review).decode(), task_id))
        return {'task_id': task_id, 'state': state}

    def verify_gate(self, task_id, candidate_paths=None):
        row, spec = self._fresh(task_id)
        require(row['state'] == 'approved' and row['review'], 'INDEPENDENT_REVIEW_REQUIRED')
        candidates = json.loads(row['candidate'])
        review = json.loads(row['review'])
        for item in candidates + review['evidence'] + [json.loads(row['stop']), review['reviewer_host']['receipt']]:
            self._check_snapshot(item)
        scope = self._review_scope(row, spec)
        self._coverage(task_id, scope)
        scope_hash = hashlib.sha256(encoded(scope)).hexdigest()
        require(review['verdict'] == 'pass' and review['spec_hash'] == row['spec_hash']
                and review['candidate_hashes'] == [p['sha256'] for p in candidates]
                and review['scope_hash'] == scope_hash, 'GATE_VERSION_MISMATCH')
        for item in review['evidence']:
            receipt = bounded_json(item['path'], TOOL_LIMIT)
            require(receipt['scope_hash'] == scope_hash and receipt['scope'] == scope
                    and receipt['verdict'] == 'pass' and receipt['spec_hash'] == row['spec_hash']
                    and receipt['reviewer_session'] == review['session'], 'GATE_REVIEW_MISMATCH')
        if candidate_paths is not None:
            require({str(self._inside(p)) for p in candidate_paths} == {p['path'] for p in candidates}, 'GATE_CANDIDATE_MISMATCH')
        return {'schema_version': SCHEMA_VERSION, 'task_id': task_id, 'stage': row['stage'],
                'approved': True, 'spec_hash': row['spec_hash'], 'reviewer_session': review['session'],
                'scope_hash': scope_hash, 'candidates': candidates, 'review_evidence': review['evidence'],
                'inputs': spec['inputs'], 'registry': spec['registry'], 'config_hash': spec['config_hash'],
                'writer_host': spec['host'], 'reviewer_host': review['reviewer_host'],
                'stop_evidence': json.loads(row['stop'])}

    def gate_for_artifact(self, path):
        path = str(self._inside(path))
        # Indexed task lookup by task ID is preferred. This scan remains process-local;
        # no unbounded rows or candidate content are returned to the model.
        found = None
        for row in self.db.execute('SELECT id,candidate FROM tasks WHERE candidate IS NOT NULL ORDER BY rowid DESC'):
            if any(p['path'] == path for p in json.loads(row['candidate'])):
                found = row['id']
                break
        require(found is not None, 'ARTIFACT_NOT_REGISTERED')
        result = self.verify_gate(found)
        result['artifact'] = next(p for p in result['candidates'] if p['path'] == path)
        return result

    def recover(self, task_id, lease, stop_evidence):
        row = self._task(task_id)
        require(row['lease'] == lease, 'LEASE_MISMATCH')
        stop = self._stop(row, stop_evidence)
        with self._tx():
            row = self._task(task_id)
            if row['state'] == 'stopped':
                require(json.loads(row['stop']) == stop, 'RECOVERY_CONFLICT')
                return {'task_id': task_id, 'state': 'stopped', 'idempotent': True}
            require(row['state'] in ('running', 'stale'), 'TASK_NOT_RECOVERABLE')
            self.db.execute("UPDATE tasks SET state='stopped',stop=? WHERE id=?", (encoded(stop).decode(), task_id))
        # Retry is a new, fully budgeted task/spec; never silently reset spent context.
        return {'task_id': task_id, 'state': 'stopped', 'retry_requires_new_task': True}

    def _handoff_idle(self, session_id):
        require(not self.db.execute("SELECT 1 FROM tasks WHERE session=? AND (state='ready' OR (lease IS NOT NULL AND stop IS NULL)) LIMIT 1",
                                    (session_id,)).fetchone(), 'ACTIVE_LEASES_REQUIRE_STOP')
        require(not self.db.execute("SELECT 1 FROM review_attempts r JOIN tasks t ON t.id=r.task WHERE r.session=? AND t.review IS NULL LIMIT 1",
                                    (session_id,)).fetchone(), 'ACTIVE_REVIEWS_REQUIRE_COMPLETION')

    def handoff(self, session_id, payload):
        require(isinstance(payload, dict) and len(encoded(payload)) <= READ_LIMIT, 'HANDOFF_LIMIT')
        with self._tx():
            self._session(session_id)
            self._handoff_idle(session_id)
            key = hashlib.sha256(encoded([session_id, payload])).hexdigest()
            self.db.execute('INSERT OR IGNORE INTO handoffs(id,old_session,payload) VALUES(?,?,?)', (key, session_id, encoded(payload).decode()))
        return {'handoff_id': key, 'requires_actual_new_session': True}

    def accept_handoff(self, handoff_id, session_id):
        with self._tx():
            new = self._session(session_id)
            row = self.db.execute('SELECT * FROM handoffs WHERE id=?', (handoff_id,)).fetchone()
            require(row is not None, 'UNKNOWN_HANDOFF')
            old = self.db.execute('SELECT * FROM sessions WHERE id=?', (row['old_session'],)).fetchone()
            self._check_snapshot(json.loads(old['evidence'])['receipt'])
            require(hashlib.sha256(encoded([row['old_session'], json.loads(row['payload'])])).hexdigest() == handoff_id, 'HANDOFF_TAMPERED')
            require(new['id'] != old['id'] and new['agent'] != old['agent'], 'NEW_HOST_SESSION_REQUIRED')
            require(json.loads(new['evidence'])['capabilities'].get('handoff_id') == handoff_id, 'HANDOFF_HOST_RECEIPT_REQUIRED')
            if row['accepted']:
                require(row['new_session'] == session_id, 'HANDOFF_ALREADY_ACCEPTED')
            else:
                self._handoff_idle(old['id'])
                cost = len(row['payload'].encode('utf-8')) + SPEC_LIMIT
                require(new['spent'] + cost <= SESSION_LIMIT, 'HANDOFF_REQUIRED: new session budget')
                self.db.execute('UPDATE sessions SET spent=spent+? WHERE id=?', (cost, session_id))
                self.db.execute('UPDATE handoffs SET new_session=?,accepted=1 WHERE id=?', (session_id, handoff_id))
                self.db.execute('UPDATE sessions SET active=0 WHERE id=?', (old['id'],))
        return {'handoff_id': handoff_id, 'session_id': session_id, 'payload': json.loads(row['payload'])}

    def status(self, after=0, limit=20):
        require(type(after) is int and after >= 0 and type(limit) is int and 0 < limit <= PAGE_LIMIT, 'PAGE_LIMIT')
        rows = self.db.execute('SELECT rowid,id,stage,state,attempt,session FROM tasks WHERE rowid>? ORDER BY rowid LIMIT ?', (after, limit + 1)).fetchall()
        return {'items': [dict(r) for r in rows[:limit]], 'next_cursor': rows[limit-1]['rowid'] if len(rows) > limit else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--course', required=True)
    parser.add_argument('command', choices=['status', 'registry', 'register-session', 'create', 'spec', 'claim', 'read', 'candidate', 'prepare-review', 'read-review', 'review', 'verify', 'gate-for-artifact', 'recover', 'handoff', 'accept-handoff'])
    parser.add_argument('--request', help='bounded JSON object with method keyword arguments')
    parser.add_argument('--after', type=int, default=0)
    parser.add_argument('--limit', type=int, default=20)
    parser.add_argument('--stage', choices=sorted(STAGES), default='lesson')
    args = parser.parse_args(argv)
    runtime = None
    try:
        runtime = Runtime(args.course)
        if args.command == 'status':
            result = runtime.status(args.after, args.limit)
        elif args.command == 'registry':
            result = policy_registry(args.stage)
        else:
            require(args.request is not None, 'REQUEST_REQUIRED')
            request = bounded_json(args.request)
            methods = {'register-session': 'register_session', 'create': 'create_task', 'claim': 'claim',
                       'spec': 'task_spec', 'read': 'read_input', 'candidate': 'submit_candidate',
                       'prepare-review': 'prepare_review', 'read-review': 'read_review',
                       'review': 'review', 'verify': 'verify_gate', 'gate-for-artifact': 'gate_for_artifact',
                       'recover': 'recover', 'handoff': 'handoff', 'accept-handoff': 'accept_handoff'}
            result = getattr(runtime, methods[args.command])(**request)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, OSError, KeyError, TypeError, sqlite3.Error) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)[:1000]}, ensure_ascii=False))
        return 1
    finally:
        if runtime is not None:
            runtime.close()


if __name__ == '__main__':
    raise SystemExit(main())
