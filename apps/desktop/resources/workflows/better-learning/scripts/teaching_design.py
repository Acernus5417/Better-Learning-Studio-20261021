"""Resolve selected pedagogical templates; never infer a discipline from a title."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from _common import read_json, sha256

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'assets/templates/subjects/catalog.json'
CONFIG = '_工作区/教学设计.json'
FIELDS = {'subject', 'secondary_subjects', 'modules', 'mode', 'level', 'reason'}
DEFAULT = {'subject': 'generic', 'secondary_subjects': [], 'modules': [],
           'mode': 'understanding', 'level': '未指定', 'reason': '旧课程兼容回退；尚未选择学科模板'}


def catalog():
    data = read_json(CATALOG)
    if data.get('schema_version') != 1:
        raise ValueError('Unsupported teaching template catalog')
    return data


def resource(relative):
    result = (ROOT / relative).resolve()
    if not result.is_relative_to(ROOT.resolve()) or not result.is_file():
        raise ValueError('Missing/outside teaching template: ' + str(relative))
    return result


def validate_spec(spec, data, *, chapter=False):
    if not isinstance(spec, dict):
        raise ValueError('Teaching selection must be an object')
    extra = set(spec) - FIELDS - ({'knowledge_overrides'} if chapter else set())
    if extra:
        raise ValueError('Unknown teaching fields: ' + ', '.join(sorted(extra)))
    for field, group in [('subject', 'subjects'), ('mode', 'modes')]:
        if field in spec and (not isinstance(spec[field], str) or spec[field] not in data[group]):
            raise ValueError('Unknown teaching ' + field + ': ' + str(spec[field]))
    for field, group in [('secondary_subjects', 'subjects'), ('modules', 'modules')]:
        if field not in spec:
            continue
        values = spec[field]
        if (not isinstance(values, list) or any(not isinstance(v, str) or v not in data[group] for v in values)
                or len(set(values)) != len(values)):
            raise ValueError('Invalid teaching ' + field)
    for field in ('level', 'reason'):
        if field in spec and (not isinstance(spec[field], str) or not spec[field].strip()):
            raise ValueError('Teaching ' + field + ' must be nonempty text')
    if chapter:
        overrides = spec.get('knowledge_overrides', {})
        if not isinstance(overrides, dict):
            raise ValueError('knowledge_overrides must be an object')
        for kid, item in overrides.items():
            if not isinstance(kid, str) or not kid.startswith('K-'):
                raise ValueError('Invalid teaching knowledge ID: ' + str(kid))
            validate_spec(item, data)


def load_config(course, data):
    file = Path(course) / CONFIG
    if not file.exists():
        return {'schema_version': 1, 'default': DEFAULT, 'lessons': {}}, False
    config = read_json(file)
    if not isinstance(config, dict) or config.get('schema_version') != 1:
        raise ValueError('Unsupported teaching design schema')
    if set(config) - {'schema_version', 'default', 'lessons'} or 'default' not in config:
        raise ValueError('Teaching design requires default and only known fields')
    validate_spec(config['default'], data)
    if 'subject' not in config['default']:
        raise ValueError('Teaching design default requires subject')
    overrides = config.get('lessons', {})
    if not isinstance(overrides, dict):
        raise ValueError('Teaching lessons must be an object')
    for lid, spec in overrides.items():
        if not isinstance(lid, str) or not lid.startswith('L-'):
            raise ValueError('Invalid teaching lesson ID: ' + str(lid))
        validate_spec(spec, data, chapter=True)
    index = Path(course) / '_工作区/章节索引.json'
    if index.exists():
        known = {row['id'] for row in read_json(index).get('lessons', [])}
        unknown = set(overrides) - known
        if unknown:
            raise ValueError('Teaching overrides reference unknown lessons: ' + ', '.join(sorted(unknown)))
    return config, True


def merge(base, override):
    result = dict(base)
    result.update({k: v for k, v in override.items() if k in FIELDS})
    if result['subject'] in result['secondary_subjects']:
        raise ValueError('Primary subject repeated as secondary')
    return result


def bundle(selection, data):
    files = [('routing', 'references/subject-routing.md')]
    files += [('subject:' + sid, data['subjects'][sid]['path'])
              for sid in [selection['subject']] + selection['secondary_subjects']]
    files += [('module:' + mid, data['modules'][mid]['path']) for mid in selection['modules']]
    files.append(('mode:' + selection['mode'], data['modes'][selection['mode']]['path']))
    return {'selection': selection,
            'resources': [{'id': key, 'relative_path': relative, 'path': str(resource(relative)),
                           'sha256': sha256(resource(relative))} for key, relative in files]}


def resolve(course, lesson_id=None, knowledge_ids=None):
    data = catalog()
    config, configured = load_config(course, data)
    index = Path(course) / '_工作区/章节索引.json'
    if lesson_id is not None and index.exists():
        if lesson_id not in {row['id'] for row in read_json(index).get('lessons', [])}:
            raise ValueError('Unknown teaching lesson ID: ' + lesson_id)
    defaults = dict(DEFAULT, reason='依据已保存教学选择；具体理由未记录') if configured else DEFAULT
    base = merge(defaults, config['default'])
    override = config.get('lessons', {}).get(lesson_id, {})
    selection = merge(base, override)
    local = override.get('knowledge_overrides', {})
    if knowledge_ids is not None and set(local) - set(knowledge_ids):
        raise ValueError('Teaching knowledge override not assigned to lesson: ' + str(lesson_id))
    return {'schema_version': 1, 'configured': configured,
            'lesson': bundle(selection, data),
            'knowledge': {kid: bundle(merge(selection, spec), data) for kid, spec in local.items()}}


def fingerprint(resolved):
    """Only effective selections and selected content; ignore absolute installation paths."""
    def compact(item):
        return {'selection': item['selection'],
                'resources': {r['id']: r['sha256'] for r in item['resources']}}
    return {'configured': resolved['configured'], 'lesson': compact(resolved['lesson']),
            'knowledge': {kid: compact(item) for kid, item in resolved['knowledge'].items()}}


def check():
    data = catalog()
    total = 0
    for group in ('subjects', 'modules', 'modes'):
        for key, entry in data[group].items():
            if not entry.get('label'):
                raise ValueError('Missing template label: ' + key)
            resource(entry['path'])
            total += 1
    resource('references/subject-routing.md')
    registered = {entry['path'] for group in ('subjects', 'modules', 'modes')
                  for entry in data[group].values()}
    actual = {p.relative_to(ROOT).as_posix() for folder in ('subjects', 'modules', 'modes')
              for p in (ROOT / 'assets/templates' / folder).glob('*.md')}
    if registered != actual:
        raise ValueError('Unregistered/missing template files: ' + str(registered ^ actual))
    return {'ok': True, 'subjects': len(data['subjects']) - 1,
            'fallbacks': 1, 'modules': len(data['modules']), 'modes': len(data['modes']), 'resources': total}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['catalog', 'check', 'resolve'])
    parser.add_argument('--course', type=Path)
    parser.add_argument('--lesson')
    parser.add_argument('--knowledge', nargs='*')
    args = parser.parse_args()
    try:
        if args.command == 'catalog':
            result = catalog()
        elif args.command == 'check':
            result = check()
        else:
            if args.course is None:
                parser.error('resolve requires --course')
            result = resolve(args.course, args.lesson, args.knowledge)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, KeyError, OSError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
