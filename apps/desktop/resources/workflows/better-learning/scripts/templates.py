"""Course document templates: the single source of truth for their paths.

Each stage keeps a shared base. Selected discipline, activity and goal overlays
are resolved by teaching_design.py and tracked in per-lesson input snapshots.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

TEMPLATES = {
    'knowledge': 'assets/templates/knowledge-chapter.md',
    'path': 'assets/templates/learning-path.md',
    'lesson': 'assets/templates/learning-chapter.md',
    'card': 'assets/templates/core-card.md',
}

# (使用阶段, 使用者) — 默认由主代理使用；bounded-v1 使用局部任务。
STAGES = {
    'knowledge': ('知识分片与 知识内容.md', '主代理'),
    'path': ('学习路径', '主代理'),
    'lesson': ('章级学习文档共用骨架 + teaching_design 选中模板', '主代理'),
    'card': ('核心知识点卡片', '主代理'),
}


def path(name: str) -> Path:
    if name not in TEMPLATES:
        raise ValueError('Unknown template: ' + name)
    return ROOT / TEMPLATES[name]


def hash_of(name: str) -> str:
    from _common import sha256
    return sha256(path(name))


def snapshot(names=None) -> dict:
    return {name: hash_of(name) for name in (names or sorted(TEMPLATES))}


def check() -> dict:
    missing = [name for name in sorted(TEMPLATES) if not path(name).exists()]
    from teaching_design import check as check_teaching
    teaching = check_teaching()
    return {'ok': not missing and teaching['ok'], 'missing': missing,
            'hashes': snapshot() if not missing else {}, 'teaching_templates': teaching}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['list', 'check'])
    args = parser.parse_args()
    if args.command == 'check':
        result = check()
    else:
        result = {'templates': {name: {'path': TEMPLATES[name], 'stage': STAGES[name][0],
                                       'author': STAGES[name][1], 'hash': hash_of(name)}
                                for name in sorted(TEMPLATES)}}
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result.get('missing') else 0


if __name__ == '__main__':
    raise SystemExit(main())
