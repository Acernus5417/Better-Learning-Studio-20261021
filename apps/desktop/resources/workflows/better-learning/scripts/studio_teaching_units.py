"""Resolve teaching units against every lesson's saved knowledge assignments."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from _common import read_json, read_jsonl
from entity_registry import is_v2
import teaching_units as units


def inspect(course, lesson_id=None):
    """Validate every configured lesson; report unconfigured lessons as legacy."""
    course = Path(course)
    index = read_json(course / '_工作区/章节索引.json')
    lessons = index.get('lessons') if isinstance(index, dict) else None
    if (not isinstance(lessons, list) or not lessons or
            any(not isinstance(row, dict) or not isinstance(row.get('id'), str) for row in lessons)):
        raise ValueError('Teaching units require a saved lesson index')
    ids = [row['id'] for row in lessons]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate teaching unit lesson ID')
    if lesson_id is not None and lesson_id not in ids:
        raise ValueError('Unknown teaching unit lesson ID')
    knowledge = read_jsonl(course / '_工作区/知识索引.jsonl')
    if (not knowledge or any(not isinstance(row, dict) or not isinstance(row.get('id'), str)
                             or not isinstance(row.get('lesson_ids'), list) for row in knowledge)):
        raise ValueError('Teaching units require a saved knowledge index')
    if len({row['id'] for row in knowledge}) != len(knowledge):
        raise ValueError('Duplicate teaching unit knowledge ID')
    plans = {}
    for lid in ids:
        assigned = [row for row in knowledge if lid in row['lesson_ids'] and row.get('status') != 'merged']
        if not assigned or any(row.get('status') != 'verified' for row in assigned):
            raise ValueError('Teaching units require verified assigned knowledge: ' + lid)
        plans[lid] = units.resolve(course, lid, assigned)
    if any(plan['configured'] for plan in plans.values()) and not is_v2(course):
        raise ValueError('Teaching units require v2 course migration before use')
    return (plans.get(lesson_id) if lesson_id is not None else None), {
        'ok': True, 'lessons': len(plans),
        'configured_lessons': [lid for lid, plan in plans.items() if plan['configured']],
        'legacy_lessons': [lid for lid, plan in plans.items() if not plan['configured']],
        'fingerprints': {lid: units.fingerprint(plan) for lid, plan in plans.items()},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['resolve', 'validate'])
    parser.add_argument('--course', type=Path, required=True)
    parser.add_argument('--lesson')
    args = parser.parse_args()
    try:
        if args.command == 'resolve' and args.lesson is None:
            raise ValueError('Teaching unit resolve requires --lesson')
        plan, report = inspect(args.course, args.lesson)
        print(json.dumps(plan if args.command == 'resolve' else report, ensure_ascii=False))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
