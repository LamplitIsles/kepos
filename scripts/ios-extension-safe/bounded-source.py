#!/usr/bin/env python3
"""Fetch and inspect one pinned source archive into the existing iOS build tree."""
import argparse
import gzip
import hashlib
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import urllib.request

BASE = Path(__file__).resolve().parents[2] / '.build/ios-deps'
TOTAL_LIMIT = 8 * 1024**3
SAFETY_RESERVE = 512 * 1024**2


class LimitError(Exception):
    pass


class Meter:
    def __init__(self, stream, limit):
        self.stream = stream
        self.limit = limit
        self.count = 0

    def read(self, size=-1):
        available = self.limit - self.count
        if available <= 0:
            raise LimitError('expanded stream limit reached')
        result = self.stream.read(available if size < 0 else min(size, available))
        self.count += len(result)
        return result


def usage():
    paths = [str(BASE), str(Path.home() / '.npm')]
    lines = subprocess.check_output(['du', '-sb', *paths], text=True).splitlines()
    return sum(int(line.split()[0]) for line in lines)


def guard(additional):
    current = usage()
    if current + additional + SAFETY_RESERVE > TOTAL_LIMIT:
        raise LimitError(f'insufficient total budget: used={current} pending={additional}')


def inspect(archive, root, unpacked_limit):
    seen = set()
    files = 0
    total = 0
    with archive.open('rb') as raw, gzip.GzipFile(fileobj=raw) as gz:
        meter = Meter(gz, unpacked_limit + 16 * 1024**2)
        with tarfile.open(fileobj=meter, mode='r|') as tar:
            for member in tar:
                parts = PurePosixPath(member.name).parts
                if (member.name.startswith('/') or not parts or parts[0] != root
                        or any(part in ('.', '..') for part in parts)):
                    raise ValueError('unsafe archive path ' + member.name)
                if member.name in seen:
                    raise ValueError('duplicate archive entry ' + member.name)
                seen.add(member.name)
                if not (member.isfile() or member.isdir()):
                    raise ValueError('unsupported link or special member ' + member.name)
                if member.isfile():
                    files += 1
                    total += member.size
                    if files > 50000 or total > unpacked_limit:
                        raise LimitError('archive member budget exceeded')
            while meter.read(65536):
                pass
    return files, total


def extract(archive, root, target, unpacked_limit):
    with archive.open('rb') as raw, gzip.GzipFile(fileobj=raw) as gz:
        meter = Meter(gz, unpacked_limit + 16 * 1024**2)
        with tarfile.open(fileobj=meter, mode='r|') as tar:
            for member in tar:
                parts = PurePosixPath(member.name).parts
                if (not parts or parts[0] != root or any(p in ('.', '..') for p in parts)
                        or not (member.isdir() or member.isfile())):
                    raise ValueError('invalid archive member')
                if len(parts) == 1:
                    continue
                dest = target.joinpath(*parts[1:])
                if member.isdir():
                    dest.mkdir(parents=True, exist_ok=True)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                with dest.open('xb') as output:
                    remaining = member.size
                    while remaining:
                        chunk = source.read(min(65536, remaining))
                        if not chunk:
                            raise ValueError('short archive file')
                        output.write(chunk)
                        remaining -= len(chunk)
                os.chmod(dest, 0o755 if member.mode & 0o111 else 0o644)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('repo')
    parser.add_argument('commit')
    parser.add_argument('--compressed-mib', type=int, required=True)
    parser.add_argument('--unpacked-mib', type=int, required=True)
    args = parser.parse_args()
    if len(args.commit) != 40 or any(c not in '0123456789abcdef' for c in args.commit):
        raise ValueError('full lowercase commit required')
    if (len(args.repo.split('/')) != 2 or any(
            not part.replace('-', '').replace('_', '').isalnum() for part in args.repo.split('/'))):
        raise ValueError('invalid repo')
    if args.compressed_mib <= 0 or args.unpacked_mib <= 0:
        raise ValueError('limits must be positive')
    owner, name = args.repo.split('/')
    root = f'{name}-{args.commit}'
    sources = BASE / 'src'
    archives = sources / 'archives'
    target = sources / name
    archive = archives / (root + '.tar.gz')
    if target.exists() or archive.exists():
        raise FileExistsError('refusing pre-existing source or archive')
    manifest = Path(__file__).resolve().with_name('source-archives.sha256')
    expected = {line.split()[1]: line.split()[0] for line in manifest.read_text().splitlines()}
    if archive.name not in expected:
        raise ValueError('source revision is not pinned')
    cap = args.compressed_mib * 1024**2
    unpacked = args.unpacked_mib * 1024**2
    guard(cap + unpacked)
    archives.mkdir(parents=True, exist_ok=True)
    url = f'https://codeload.github.com/{owner}/{name}/tar.gz/{args.commit}'
    request = urllib.request.Request(url, headers={'User-Agent': 'kepos-bounded-source/1'})
    digest = hashlib.sha256()
    count = 0
    with urllib.request.urlopen(request, timeout=30) as response, archive.open('xb') as output:
        if not response.geturl().startswith('https://codeload.github.com/'):
            raise ValueError('unexpected download origin')
        while True:
            chunk = response.read(min(65536, cap - count + 1))
            if not chunk:
                break
            if len(chunk) > cap - count:
                raise LimitError('compressed download limit exceeded')
            output.write(chunk)
            digest.update(chunk)
            count += len(chunk)
    if digest.hexdigest() != expected[archive.name]:
        raise ValueError('source archive SHA-256 mismatch')
    files, size = inspect(archive, root, unpacked)
    guard(size)
    target.mkdir()
    extract(archive, root, target, unpacked)
    print('repo', args.repo, 'commit', args.commit, 'archive', archive,
          'compressed', count, 'sha256', digest.hexdigest(), 'files', files,
          'unpacked', size, 'combined_usage', usage(), flush=True)


if __name__ == '__main__':
    main()
