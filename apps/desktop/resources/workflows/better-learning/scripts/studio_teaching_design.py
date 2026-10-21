"""Resolve Studio teaching selections using knowledge IDs from the saved indexes."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from _common import read_json, read_jsonl
import teaching_design as design


def inspect(course, lesson_id=None, *, require_config=False):
    """Validate all saved overrides; callers cannot supply their own knowledge IDs."""
    course = Path(course)
    index = course / '_工作区/章节索引.json'
    index_data = read_json(index) if index.exists() else {}
    if not isinstance(index_data, dict):
        raise ValueError('Invalid teaching lesson index')
    lessons = index_data.get('lessons', [])
    if not isinstance(lessons, list) or any(not isinstance(row, dict) or not isinstance(row.get('id'), str)
                                          for row in lessons):
        raise ValueError('Invalid teaching lesson index')
    ids = [row['id'] for row in lessons]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate teaching lesson ID')
    config, configured = design.load_config(course, design.catalog())
    if require_config and not configured:
        raise ValueError('请依据可靠转写与已确认需求保存 _工作区/教学设计.json，再验证教学设计')
    if config.get('lessons') and not ids:
        raise ValueError('Teaching lesson overrides require the saved lesson index')
    if lesson_id is not None and lesson_id not in ids:
        raise ValueError('Unknown teaching lesson ID: ' + lesson_id)
    knowledge_file = course / '_工作区/知识索引.jsonl'
    knowledge = read_jsonl(knowledge_file) if knowledge_file.exists() else []
    if any(not isinstance(row, dict) or not isinstance(row.get('id'), str)
           or not isinstance(row.get('lesson_ids', []), list)
           or any(not isinstance(lid, str) for lid in row.get('lesson_ids', [])) for row in knowledge):
        raise ValueError('Invalid teaching knowledge index')
    resolved = {}
    for lid in ids:
        assigned = [row['id'] for row in knowledge
                    if lid in row.get('lesson_ids', []) and row.get('status') != 'merged']
        resolved[lid] = design.resolve(course, lid, assigned)
    default = design.resolve(course)
    return (default if lesson_id is None else resolved[lesson_id]), {
        'ok': True, 'configured': configured, 'lessons': len(ids),
        'fingerprints': {'default': design.fingerprint(default),
                         'lessons': {lid: design.fingerprint(item) for lid, item in resolved.items()}},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['resolve', 'validate'])
    parser.add_argument('--course', type=Path, required=True)
    parser.add_argument('--lesson')
    parser.add_argument('--require-config', action='store_true')
    args = parser.parse_args()
    try:
        resolved, report = inspect(args.course, args.lesson, require_config=args.require_config)
        print(json.dumps(resolved if args.command == 'resolve' else report, ensure_ascii=False))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
