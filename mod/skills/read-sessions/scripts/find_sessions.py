#!/usr/bin/env python3
"""find_sessions.py: find and read your other Claude Code sessions.

  panel  [--cwd DIR]                     the sessions the Claude Sessions panel shows in this window
  recent [--days N] [--topic T] [--files F ...]   sessions active in the last N days (default 7)
  all    [--topic T] [--files F ...]     every session on this machine, ranked by topic
  digest ID [--turns N]                  one session's title, state, files touched and conversation

Topic T: words, and "quoted phrases"; a session ranks by how often they appear in its title,
its messages and the paths it touched. --files ranks sessions that touched those files.
Sessions come from every ~/.claude*/projects folder (one per config dir), plus the Windows
side under WSL. Headless (claude -p) and subagent transcripts are left out unless
--include-headless. Times are taken from inside each transcript, never from file times.
"""
import argparse, glob, json, os, re, sys, time
from datetime import datetime, timezone

HOME = os.path.expanduser('~')
CACHE = os.path.join(HOME, '.cache', 'claude-sessions-panel', 'session-index.json')
SNAPSHOTS = os.path.join(HOME, '.claude', 'sessions-panel')
HEADLESS = {'sdk-cli', 'sdk-ts', 'sdk-py', 'sdk'}
NOISE = ('<ide_opened_file>', '<ide_selection>', '<command-name>', '<command-message>', '<local-command',
         '<system-reminder>', '<task-notification>', '<bash-stdout>', '<bash-stderr>', '<bash-input>',
         'This session is being continued from a previous conversation', 'Caveat: The messages below')
PATH_KEYS = ('file_path', 'path', 'notebook_path')
PARSER = 2  # bump when parse() changes, so cached entries are rebuilt


def roots():
    out = sorted(glob.glob(os.path.join(HOME, '.claude*', 'projects')))
    if os.path.exists('/mnt/c/Windows/System32/cmd.exe'):
        out += sorted(glob.glob('/mnt/c/Users/*/.claude/projects'))
    return [r for r in out if os.path.isdir(r)]


def transcripts():
    for r in roots():
        for p in glob.glob(os.path.join(r, '*', '*.jsonl')):
            yield p


def clean(text):
    text = re.sub(r'<(system-reminder|ide_selection|ide_opened_file)>.*?</\1>', '', text, flags=re.S)
    text = re.sub(r'</?pasted_content[^>]*>', '', text)  # keep what was pasted, drop the wrapper
    return text.strip()


def human_text(rec):
    """The words a person typed in a user record, or None for tool results and injections."""
    if rec.get('isMeta') or rec.get('isSidechain'):
        return None
    content = (rec.get('message') or {}).get('content')
    if isinstance(content, str):
        parts = [content]
    elif isinstance(content, list):
        if any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content):
            return None
        parts = [b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text']
    else:
        return None
    text = clean('\n'.join(parts))
    if not text or text.startswith(NOISE):
        return None
    return text


def assistant_text(rec):
    content = (rec.get('message') or {}).get('content')
    if not isinstance(content, list):
        return '', []
    texts, paths = [], []
    for b in content:
        if not isinstance(b, dict):
            continue
        if b.get('type') == 'text':
            texts.append(b.get('text', ''))
        elif b.get('type') == 'tool_use':
            inp = b.get('input') or {}
            for k in PATH_KEYS:
                v = inp.get(k)
                if isinstance(v, str) and v:
                    paths.append(v)
    return '\n'.join(texts).strip(), paths


def parse(path):
    """One pass over a transcript: what the index needs."""
    s = {'path': path, 'id': os.path.basename(path)[:-6], 'title': '', 'cwd': '', 'entry': '',
         'start': None, 'end': None, 'turns': 0, 'first': '', 'last': '', 'reply': '', 'files': [],
         'firstUuid': None, 'words': ''}
    files, words = {}, []
    ai_title = ''
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            t = rec.get('type')
            if t == 'custom-title' and rec.get('customTitle'):
                s['title'] = rec['customTitle']
            elif t == 'ai-title' and (rec.get('aiTitle') or rec.get('title')):
                ai_title = rec.get('aiTitle') or rec.get('title')
            elif t == 'summary' and rec.get('summary') and not ai_title:
                ai_title = rec['summary']
            if t not in ('user', 'assistant'):
                continue
            ts = rec.get('timestamp')
            if ts:
                s['start'] = s['start'] or ts
                s['end'] = ts
            s['cwd'] = s['cwd'] or rec.get('cwd', '')
            s['entry'] = s['entry'] or rec.get('entrypoint', '')
            if t == 'user':
                text = human_text(rec)
                if text:
                    s['turns'] += 1
                    if not s['first']:
                        s['first'], s['firstUuid'] = text[:600], rec.get('uuid')
                    s['last'] = text[:600]
                    words.append(text[:4000])
            else:
                text, paths = assistant_text(rec)
                if text:
                    s['reply'] = text[-800:]
                for p in paths:
                    files[p] = files.get(p, 0) + 1
    s['title'] = s['title'] or ai_title
    s['files'] = sorted(files, key=lambda p: -files[p])[:60]
    s['words'] = '\n'.join(words)[:60000]
    return s


def index():
    """Every transcript's summary, re-parsed only when the file changed since the last run."""
    try:
        with open(CACHE) as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    out, changed = {}, False
    for p in transcripts():
        try:
            st = os.stat(p)
        except OSError:
            continue
        key = f'{PARSER}:{st.st_size}:{int(st.st_mtime)}'
        hit = cache.get(p)
        if hit and hit.get('key') == key:
            out[p] = hit
            continue
        try:
            s = parse(p)
        except OSError:
            continue
        s['key'] = key
        out[p] = s
        changed = True
    if changed or len(out) != len(cache):
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        tmp = CACHE + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(out, f)
        os.replace(tmp, CACHE)
    sessions = [s for s in out.values() if s['turns']]
    # The same id on two roots: keep the longer copy. A fork shares its parent's first message:
    # keep the one that went furthest, note the rest.
    by_id = {}
    for s in sessions:
        if s['id'] not in by_id or s['turns'] > by_id[s['id']]['turns']:
            by_id[s['id']] = s
    by_first = {}
    for s in by_id.values():
        if s['firstUuid']:
            by_first.setdefault(s['firstUuid'], []).append(s)
    for group in by_first.values():
        if len(group) > 1:
            group.sort(key=lambda x: x['end'] or '', reverse=True)
            for g in group[1:]:
                g['forkOf'] = group[0]['id']
    return list(by_id.values())


def live_sessions():
    """Session id -> status for every running Claude Code process (all config dirs)."""
    out = {}
    for f in glob.glob(os.path.join(HOME, '.claude*', 'sessions', '*.json')):
        try:
            with open(f) as fh:
                r = json.load(fh)
            os.kill(int(r['pid']), 0)
        except (OSError, ValueError, KeyError, TypeError):
            continue
        out[r.get('sessionId')] = r.get('status', 'idle')
    return out


def ts(iso):
    if not iso:
        return 0
    try:
        return datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp()
    except ValueError:
        return 0


def when(iso):
    t = ts(iso)
    return datetime.fromtimestamp(t).strftime('%m-%d %H:%M') if t else '?'


def terms_of(topic):
    if not topic:
        return []
    phrases = re.findall(r'"([^"]+)"', topic)
    rest = re.sub(r'"[^"]+"', ' ', topic)
    return [p.lower() for p in phrases] + [w.lower() for w in re.findall(r'[\w./-]{3,}', rest)]


def score(s, terms, files):
    if not terms and not files:
        return 0
    title, first, body = s['title'].lower(), s['first'].lower(), s['words'].lower()
    paths = ' '.join(s['files']).lower()
    n = 0
    for t in terms:
        n += 6 * title.count(t) + 3 * first.count(t) + min(body.count(t), 15) + 2 * min(paths.count(t), 5)
    for f in files:
        f = os.path.abspath(os.path.expanduser(f)).lower()
        n += 8 * sum(1 for p in s['files'] if p.lower() == f or p.lower().endswith(f.rsplit('/', 1)[-1]))
    return n


def row(s, live, sc=None):
    state = live.get(s['id'])
    return {
        'id': s['id'], 'title': s['title'] or s['first'][:80].replace('\n', ' '), 'cwd': s['cwd'],
        'start': s['start'], 'end': s['end'], 'turns': s['turns'], 'state': state or 'ended',
        'forkOf': s.get('forkOf'), 'score': sc, 'path': s['path'],
        'first': s['first'][:240].replace('\n', ' '), 'last': s['last'][:240].replace('\n', ' '),
    }


def show(rows, as_json, heading):
    if as_json:
        print(json.dumps(rows, indent=1))
        return
    print(heading)
    for r in rows:
        bits = [r['id'][:8], f"{when(r['start'])} → {when(r['end'])}", f"{r['turns']} turns", r['state']]
        if r.get('score') is not None:
            bits.append(f"score {r['score']}")
        if r.get('forkOf'):
            bits.append(f"fork of {r['forkOf'][:8]}")
        if r.get('panelState'):
            bits.append(f"panel: {r['panelState']}")
        print(f"- {r['title'][:90]}  [{' · '.join(bits)}]")
        print(f"    {r['cwd']}  {r['path']}")
        print(f"    first: {r['first'][:160]}")
        if r['last'] and r['last'] != r['first']:
            print(f"    last:  {r['last'][:160]}")


def pick_snapshot(cwd):
    snaps = []
    for f in glob.glob(os.path.join(SNAPSHOTS, '*.json')):
        try:
            with open(f) as fh:
                snaps.append(json.load(fh))
        except (OSError, ValueError):
            continue
    if not snaps:
        return None
    cwd = os.path.abspath(cwd)

    def fit(sn):
        best = 0
        for folder in sn.get('folders') or []:
            folder = folder.rstrip('/')
            if cwd == folder or cwd.startswith(folder + '/'):
                best = max(best, len(folder))
        return best
    snaps.sort(key=lambda sn: (fit(sn), sn.get('updatedAt', 0)), reverse=True)
    return snaps[0]


def cmd_panel(a, live):
    sn = pick_snapshot(a.cwd)
    if not sn:
        print('No panel snapshot found (~/.claude/sessions-panel/). Is the Claude Sessions panel 0.10 or later installed and open? Fall back to: recent --days 2')
        return 1
    by_id = {s['id']: s for s in index()}
    rows = []
    for p in sn.get('rows', []):
        s = by_id.get(p['id'])
        r = row(s, live) if s else {'id': p['id'], 'title': p.get('name', ''), 'cwd': p.get('cwd', ''), 'start': None, 'end': None,
                                    'turns': 0, 'state': 'no transcript', 'path': '', 'first': '', 'last': ''}
        r['title'] = p.get('name') or r['title']
        r['panelState'] = p.get('state') + (f" · in folder {p['folder']}" if p.get('folder') else '')
        rows.append(r)
    age = int((time.time() * 1000 - sn.get('updatedAt', 0)) / 60000)
    head = f"Panel ({', '.join(os.path.basename(f) for f in sn.get('folders') or []) or 'no folder'}"
    head += f"{', all windows' if sn.get('showAll') else ''}; list last changed {age} min ago): {len(rows)} sessions"
    show(rows, a.json, head)
    return 0


def cmd_search(a, live, days):
    terms, files = terms_of(a.topic), a.files or []
    cutoff = time.time() - days * 86400 if days else 0
    rows = []
    for s in index():
        if not a.include_headless and s['entry'] in HEADLESS:
            continue
        if cutoff and ts(s['end']) < cutoff:
            continue
        sc = score(s, terms, files)
        if (terms or files) and sc == 0:
            continue
        rows.append(row(s, live, sc if (terms or files) else None))
    if terms or files:
        rows.sort(key=lambda r: (r['score'], r['end'] or ''), reverse=True)
    else:
        rows.sort(key=lambda r: r['end'] or '', reverse=True)
    total = len(rows)
    rows = rows[:a.limit]
    scope = f'last {days} days' if days else 'all sessions'
    show(rows, a.json, f"{scope}{' matching ' + repr(a.topic) if a.topic else ''}{' touching ' + ', '.join(files) if files else ''}: "
                       f"{total} found, showing {len(rows)}")
    return 0


def cmd_digest(a, live):
    matches = [s for s in index() if s['id'].startswith(a.id)]
    if not matches:
        print(f'No session {a.id}')
        return 1
    s = max(matches, key=lambda x: x['turns'])
    print(f"# {s['title'] or '(untitled)'}\nid {s['id']} · {s['cwd']} · {when(s['start'])} → {when(s['end'])} · "
          f"{s['turns']} turns · {live.get(s['id'], 'ended')}\n{s['path']}\n")
    if s['files']:
        print('Files touched (most first): ' + ', '.join(s['files'][:25]) + '\n')
    turns = []
    reply = ''
    with open(s['path'], encoding='utf-8', errors='replace') as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get('type') == 'user':
                text = human_text(rec)
                if text:
                    if turns:
                        turns[-1][1] = reply
                    turns.append([text, ''])
                    reply = ''
            elif rec.get('type') == 'assistant':
                t, _ = assistant_text(rec)
                if t:
                    reply = t
    if turns:
        turns[-1][1] = reply
    # The first two turns (what it set out to do) and the last ones (where it ended up).
    if a.turns <= 0 or len(turns) <= a.turns:
        shown = turns
    else:
        shown = turns[:2] + turns[-(a.turns - 2):]
    skipped = len(turns) - len(shown)
    for i, (u, r) in enumerate(shown):
        if i == 2 and skipped:
            print(f'… {skipped} earlier turns skipped (use --turns 0 for all) …\n')
        print(f'## You\n{u[:a.chars]}\n\n## Claude\n{r[-a.chars:]}\n')
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('panel'); p.add_argument('--cwd', default=os.getcwd())
    for name in ('recent', 'all'):
        p = sub.add_parser(name)
        p.add_argument('--topic', default='')
        p.add_argument('--files', nargs='*')
        p.add_argument('--limit', type=int, default=40)
        p.add_argument('--include-headless', action='store_true')
        if name == 'recent':
            p.add_argument('--days', type=float, default=7)
    p = sub.add_parser('digest'); p.add_argument('id'); p.add_argument('--turns', type=int, default=12); p.add_argument('--chars', type=int, default=1500)
    for p in sub.choices.values():
        p.add_argument('--json', action='store_true')
    a = ap.parse_args()
    live = live_sessions()
    if a.cmd == 'panel':
        return cmd_panel(a, live)
    if a.cmd == 'recent':
        return cmd_search(a, live, a.days)
    if a.cmd == 'all':
        return cmd_search(a, live, 0)
    return cmd_digest(a, live)


if __name__ == '__main__':
    sys.exit(main())
