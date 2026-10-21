"""Task-centred teaching units, independent of knowledge identity and discipline."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from _common import read_json, read_jsonl, sha256

CONFIG = '_工作区/教学单元.json'
ROOT = Path(__file__).resolve().parents[1]
DEPTHS = {'reminder', 'standard', 'deep', 'extension'}
FIELDS = {'id', 'title', 'knowledge_ids', 'depth', 'reason', 'goals',
          'success_criteria', 'entry_evidence', 'expansion_triggers', 'stop_when'}


def texts(value, field):
    if (not isinstance(value, list) or not value or
            any(not isinstance(v, str) or not v.strip() for v in value) or
            len(set(value)) != len(value)):
        raise ValueError('Teaching unit requires distinct nonempty ' + field)
    return value


def validate_units(units, knowledge):
    if not isinstance(units, list) or not units:
        raise ValueError('Teaching units must be a nonempty list')
    seen, positions, ids = [], {}, set()
    for position, unit in enumerate(units):
        if not isinstance(unit, dict) or set(unit) - FIELDS:
            raise ValueError('Unknown teaching unit fields')
        uid = unit.get('id', '')
        if not isinstance(uid, str) or not re.fullmatch(r'TU-[A-Za-z0-9-]+', uid) or uid in ids:
            raise ValueError('Invalid/duplicate teaching unit ID')
        ids.add(uid)
        for field in ('title', 'reason'):
            if not isinstance(unit.get(field), str) or not unit[field].strip():
                raise ValueError('Teaching unit requires ' + field)
        if unit.get('depth') not in DEPTHS:
            raise ValueError('Unknown teaching unit depth')
        for field in ('knowledge_ids', 'goals', 'success_criteria', 'stop_when'):
            texts(unit.get(field), field)
        if 'expansion_triggers' in unit:
            texts(unit['expansion_triggers'], 'expansion_triggers')
        if unit['depth'] == 'reminder' and not str(unit.get('entry_evidence', '')).strip():
            raise ValueError('Reminder depth requires entry_evidence')
        if 'entry_evidence' in unit and not isinstance(unit['entry_evidence'], str):
            raise ValueError('entry_evidence must be text')
        for kid in unit['knowledge_ids']:
            if kid not in knowledge or kid in positions:
                raise ValueError('Foreign/duplicate unit knowledge: ' + kid)
            positions[kid] = position
            seen.append(kid)
    if set(seen) != set(knowledge):
        raise ValueError('Teaching units must cover all assigned knowledge')
    for kid, record in knowledge.items():
        for prerequisite in record.get('prerequisites', []):
            if prerequisite in positions and positions[prerequisite] > positions[kid]:
                raise ValueError('Teaching unit prerequisite appears later: ' + prerequisite)
    return units


def resolve(course, lesson_id, knowledge):
    """Resolve only this lesson; other lessons' design does not affect its hash."""
    course = Path(course)
    records = {k['id']: k for k in knowledge}
    file = course / CONFIG
    units, configured = None, False
    if file.exists():
        config = read_json(file)
        if (not isinstance(config, dict) or config.get('schema_version') != 1 or
                set(config) - {'schema_version', 'lessons'} or not isinstance(config.get('lessons'), dict)):
            raise ValueError('Unsupported teaching units schema')
        index_file = course / '_工作区/章节索引.json'
        if index_file.exists():
            known = {l['id'] for l in read_json(index_file).get('lessons', [])}
            if set(config['lessons']) - known or lesson_id not in known:
                raise ValueError('Teaching units reference unknown lessons')
        entry = config['lessons'].get(lesson_id)
        if entry is not None:
            if not isinstance(entry, dict) or set(entry) != {'units'}:
                raise ValueError('Teaching lesson requires only units')
            units = validate_units(entry['units'], records)
            configured = True
    if units is None:
        units = [dict(id=f'TU-{i:03d}', title=k.get('title', kid), knowledge_ids=[kid],
                      depth='standard', reason='旧课程兼容；尚未完成教学单元设计')
                 for i, (kid, k) in enumerate(records.items(), 1)]
    return {'schema_version': 1, 'lesson_id': lesson_id, 'configured': configured,
            'units': units,
            'policy': str(ROOT / 'references/teaching-granularity.md'),
            'policy_hash': sha256(ROOT / 'references/teaching-granularity.md'),
            'resolver_hash': sha256(Path(__file__))}


def fingerprint(plan):
    value = {k: v for k, v in plan.items() if k != 'policy'}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def validate_result(plan, result, reserved):
    """Check review evidence references, not the truth of pedagogical judgments."""
    if not plan.get('configured'):
        return {'configured': False, 'review': 'legacy compatibility'}
    reviews = result.get('unit_reviews')
    if not isinstance(reviews, list):
        raise ValueError('Explicit teaching units require unit_reviews')
    byunit = {}
    for review in reviews:
        if not isinstance(review, dict) or review.get('unit_id') in byunit:
            raise ValueError('Invalid/duplicate unit review')
        byunit[review.get('unit_id')] = review
    if set(byunit) != {u['id'] for u in plan['units']}:
        raise ValueError('Unit review coverage differs from teaching plan')
    exercises = {}
    known = {k for u in plan['units'] for k in u['knowledge_ids']}
    entries = result.get('exercises', [])
    if not isinstance(entries, list):
        raise ValueError('exercises must be a list')
    for entry in entries:
        exid = entry.get('id')
        if exid not in reserved or exid in exercises:
            raise ValueError('Invalid/duplicate unit exercise ID')
        assesses = texts(entry.get('assesses'), 'exercise assesses')
        if set(assesses) - known:
            raise ValueError('Exercise assesses foreign knowledge')
        if not isinstance(entry.get('feedback_heading'), str) or not entry['feedback_heading'].strip():
            raise ValueError('Unit exercise requires feedback_heading')
        exercises[exid] = entry
    for unit in plan['units']:
        review = byunit[unit['id']]
        for field in ('reasoning_check', 'economy_check'):
            if not isinstance(review.get(field), str) or not review[field].strip():
                raise ValueError('Unit review requires ' + field)
        if (not isinstance(review.get('limitations'), list) or
                any(not isinstance(v, str) or not v.strip() for v in review['limitations'])):
            raise ValueError('Unit review requires limitations list (empty when none known)')
        checks = review.get('goal_checks')
        if not isinstance(checks, list) or any(not isinstance(c, dict) for c in checks):
            raise ValueError('Unit review requires goal_checks')
        if (len(checks) != len(unit['goals']) or
                {c.get('goal') for c in checks} != set(unit['goals'])):
            raise ValueError('Unit goal checks must cover planned goals exactly once')
        for check in checks:
            for exid in texts(check.get('exercise_ids'), 'goal exercise_ids'):
                if exid not in exercises or not set(exercises[exid]['assesses']).intersection(unit['knowledge_ids']):
                    raise ValueError('Goal check references absent/unrelated exercise')
            if not isinstance(check.get('criterion'), str) or not check['criterion'].strip():
                raise ValueError('Goal check requires criterion')
    return {'configured': True, 'units_reviewed': len(reviews),
            'exercises_referenced': sorted(exercises), 'semantic_quality': 'author review; not student validation'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--course', type=Path, required=True)
    parser.add_argument('--lesson', required=True)
    args = parser.parse_args()
    knowledge = [k for k in read_jsonl(args.course / '_工作区/知识索引.jsonl')
                 if args.lesson in k.get('lesson_ids', []) and k.get('status') != 'merged']
    print(json.dumps(resolve(args.course, args.lesson, knowledge), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
