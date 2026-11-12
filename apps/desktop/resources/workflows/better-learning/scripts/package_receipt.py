"""Low-cost delivery receipts: stage validation once, metadata checks at packaging."""
from pathlib import Path
import os
import stat

from _common import read_json, utc_now, write_json

SNAPSHOT = '_工作区/链接校验报告.json'
POLICY = 'metadata-v1'
CONTROLS = (
    '课程配置.json', '实体注册表.json', '链接映射.json', '资料索引.json',
    '转写任务.json', '转写索引.json', '章节索引.json', '讲义任务.json',
    '核心卡片状态.json', '核心卡片计划.json', '知识索引.jsonl',
    '路径索引.json', '管理文档索引.json', '练习索引.jsonl', '教学设计.json', '教学单元.json',
    '质量回执.json', '事务记录.jsonl',
)


def stamp_info(info):
    return {'bytes': info.st_size, 'modified_ns': str(info.st_mtime_ns),
            'changed_ns': str(info.st_ctime_ns), 'identity': str(info.st_ino)}


def stamp(path):
    """Read identity and change metadata only; no file contents or hashes."""
    return stamp_info(path.stat())


def delivery_metadata(course):
    """One directory pass, skipping private trees before descent and reading each Markdown stat once."""
    result, pending = {}, [(Path(course), '')]
    while pending:
        folder, prefix = pending.pop()
        with os.scandir(folder) as entries:
            for entry in entries:
                if entry.name.startswith('.') or entry.name in {'_工作区', '原始资料', '笔记'}:
                    continue
                if entry.is_symlink():
                    continue
                relative = prefix + entry.name
                if entry.is_dir(follow_symlinks=False):
                    info = entry.stat(follow_symlinks=False)
                    if getattr(info, 'st_reparse_tag', 0) not in {0xA0000003, 0xA000000C}:
                        pending.append((Path(entry.path), relative + '/'))
                elif entry.name.lower().endswith('.md') and entry.is_file(follow_symlinks=False):
                    info = entry.stat(follow_symlinks=False)
                    if getattr(info, 'st_reparse_tag', 0) not in {0xA0000003, 0xA000000C}:
                        result[relative] = stamp_info(info)
    return result


def delivery_files(course):
    for relative in sorted(delivery_metadata(course)):
        yield relative, Path(course) / relative


def control_metadata(course, names):
    result = {}
    work = Path(course) / '_工作区'
    if work.is_symlink() or work.exists() and getattr(work.lstat(), 'st_reparse_tag', 0) in {0xA0000003, 0xA000000C}:
        raise ValueError('Invalid workflow metadata directory')
    for name in names:
        try:
            info = (work / name).lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(info.st_mode) and getattr(info, 'st_reparse_tag', 0) not in {0xA0000003, 0xA000000C}:
            result['_工作区/' + name] = stamp_info(info)
    return result


def record_snapshot(course, mode='final', links_checked=False):
    """Capture post-validation metadata, refreshing paths after deterministic relocation."""
    course = Path(course).resolve()
    report_path = course / '_工作区/结构检查.json'
    report = read_json(report_path) if report_path.is_file() else {}
    if mode == 'packaged' and (report.get('mode') != 'final' or report.get('passed') is not True):
        raise ValueError('FINAL_RECEIPT_MISSING: 需要保留已通过的 final 验收结果')
    controls = control_metadata(course, CONTROLS)
    if mode == 'packaged':
        controls['_工作区/结构检查.json'] = stamp(report_path)
    receipt = {'schema_version': 2, 'integrity': POLICY, 'mode': mode,
               'recorded_at': utc_now(), 'files': delivery_metadata(course),
               'controls': controls, 'checks': {'links': bool(links_checked)},
               'counts': report.get('counts', {}), 'graph_policy_version': report.get('graph_policy_version')}
    write_json(course / SNAPSHOT, receipt)
    return receipt


def verify_snapshot(course, receipt, mode):
    """Reject ordinary edits, replacements and inventory changes without rereading file contents."""
    problems = []
    if (receipt.get('schema_version') != 2 or receipt.get('integrity') != POLICY
            or receipt.get('mode') != mode or not isinstance(receipt.get('files'), dict)
            or not receipt.get('files') or not isinstance(receipt.get('controls'), dict)):
        return ['STALE_MANIFEST: 缺少新版轻量验收回执，请先重新运行 final 验收']
    current = delivery_metadata(course)
    if set(current) != set(receipt['files']):
        problems.append('STALE_MANIFEST: 验收后 Markdown 文件清单发生变化，请重新运行 final 验收')
    for name, expected in receipt['files'].items():
        if name not in current:
            problems.append('MISSING_TARGET_BLOCK: 验收后缺少文件：' + name)
        elif current[name] != expected:
            problems.append('STALE_MANIFEST: 验收后文件发生变化：' + name)
    controls = control_metadata(course, (*CONTROLS, '结构检查.json'))
    for name, expected in receipt['controls'].items():
        if name not in controls or controls[name] != expected:
            problems.append('STALE_MANIFEST: 验收后台账发生变化：' + name)
    return problems


def require_final(course):
    """Reuse an accepted final report only while its delivered files and control ledgers are unchanged."""
    report_path = course / '_工作区/结构检查.json'
    snapshot_path = course / SNAPSHOT
    report = read_json(report_path) if report_path.is_file() else {}
    receipt = read_json(snapshot_path) if snapshot_path.is_file() else {}
    problems = verify_snapshot(course, receipt, 'final')
    if report.get('mode') != 'final' or report.get('passed') is not True:
        problems.append('FINAL_RECEIPT_MISSING: 打包前需要通过 final 验收')
    if problems:
        raise ValueError('; '.join(problems))
    return report


def changed_paths(course, receipt, moves):
    """Select only files affected by relocation or an observed metadata change."""
    result = set(moves.values())
    current = {**delivery_metadata(course), **control_metadata(course, CONTROLS)}
    for old, expected in {**receipt['files'], **receipt['controls']}.items():
        relative = moves.get(old, old)
        if current.get(relative) != expected:
            result.add(relative)
    return result


def packaged_report(course):
    """Packaging checks a link-audited receipt and metadata; content review remains a prior-stage result."""
    snapshot_path = course / SNAPSHOT
    receipt = read_json(snapshot_path) if snapshot_path.is_file() else {}
    if receipt.get('schema_version') == 1 and receipt.get('mode') == 'packaged':
        receipt = upgrade_completed_receipt(course, receipt)
    errors = verify_snapshot(course, receipt, 'packaged')
    if receipt.get('checks', {}).get('links') is not True:
        errors.append('LINKS: 缺少移动后链接检查结果，请重新完成打包')
    return {'schema_version': 2, 'mode': 'packaged', 'passed': not errors,
            'integrity': POLICY, 'snapshot': SNAPSHOT, 'errors': errors, 'warnings': [],
            'counts': receipt.get('counts', {}), 'layout': 'packaged',
            'graph_policy_version': receipt.get('graph_policy_version')}


def upgrade_completed_receipt(course, receipt):
    """Adopt an already accepted old package only while files predate its accepted report."""
    accepted = course / '_工作区/打包检查.json'
    packaged = course / '_工作区/打包回执.json'
    final = course / '_工作区/结构检查.json'
    if not all(path.is_file() for path in (accepted, packaged, final)):
        return receipt
    result, package, original = read_json(accepted), read_json(packaged), read_json(final)
    if (result.get('mode') != 'packaged' or result.get('passed') is not True
            or package.get('report', {}).get('passed') is not True
            or original.get('mode') != 'final' or original.get('passed') is not True):
        return receipt
    cutoff = accepted.stat().st_mtime_ns
    files = list(delivery_files(course))
    current = {name for name, _ in files}
    if not receipt.get('files') or any(name not in current for name in receipt['files']
                                     if not name.startswith('笔记/')):
        return receipt
    if any(path.stat().st_mtime_ns > cutoff for _, path in files):
        return receipt
    if any((course / '_工作区' / name).stat().st_mtime_ns > cutoff
           for name in CONTROLS if (course / '_工作区' / name).is_file()):
        return receipt
    backup = course / '_工作区/链接校验报告.v1.json'
    if not backup.exists():
        write_json(backup, receipt)
    return record_snapshot(course, 'packaged', links_checked=True)

