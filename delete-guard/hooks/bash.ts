// Bash (Linux, WSL, Git Bash unter Windows): Befehlszeile zerlegen und jede
// Löschung auf ihre Ziele zurückführen. Lieber zu streng: was sich nicht
// auflösen lässt (Variablen, $(…), unbekannte Pipeline-Eingaben), landet in
// `unknowns` und braucht damit ebenfalls die Zustimmung.

import {
  type Ctx, type Out, type State, type Val, type Mode, type Run,
  DELETE_CMDS, absolute, addTarget, decodeEncoded, fork, inlineCode, lang, parentOf,
} from './common'

type Part =
  | { t: 'lit'; v: string; q: boolean }
  | { t: 'var'; name: string; q: boolean; def?: string }
  | { t: 'sub'; src: string }
  | { t: 'dyn'; what: string }
  | { t: 'tilde'; user: string }

type Word = { parts: Part[]; raw: string }
type Heredoc = { body: string }
type Tok =
  | { k: 'w'; w: Word }
  | { k: 'op'; op: string }
  | { k: 'redir'; op: string }
  | { k: 'heredoc'; doc: Heredoc }

type Cmd = { words: Word[]; docs: Heredoc[]; herestrings: Word[]; stdin: Word | null; prev: Cmd | null }

const OPS = ['&&', '||', ';;&', ';;', ';&', '|&', '&>>', '&>', '>>', '>|', '>&', '<&', '<<<', '<<-', '<<', '<>', '>', '<', ';', '&', '|', '(', ')']
const REDIRS = new Set(['&>>', '&>', '>>', '>|', '>&', '<&', '<<<', '<>', '>', '<'])

/** Index hinter der schließenden Klammer zu `s[i]` (`(`), Anführungen beachtet. */
function balanced(s: string, i: number, open = '(', close = ')'): number {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === '\\') { j++; continue }
    if (c === "'") { j = s.indexOf("'", j + 1); if (j < 0) return s.length; continue }
    if (c === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === '\\') j++
      continue
    }
    if (c === open) depth++
    else if (c === close && --depth === 0) return j + 1
  }
  return s.length
}

export function lex(s: string): Tok[] {
  const toks: Tok[] = []
  let parts: Part[] = []
  let raw = ''
  let start = 0
  let inWord = false
  const pending: { doc: Heredoc; delim: string; strip: boolean }[] = []

  const lit = (v: string, q: boolean) => {
    const last = parts[parts.length - 1]
    if (last && last.t === 'lit' && last.q === q) last.v += v
    else parts.push({ t: 'lit', v, q })
    inWord = true
  }
  const endWord = (at: number) => {
    if (inWord) toks.push({ k: 'w', w: { parts, raw: s.slice(start, at) } })
    parts = []
    raw = ''
    inWord = false
  }
  const begin = (i: number) => { if (!inWord) { start = i; inWord = true } }

  const dollar = (i: number, q: boolean): number => {
    const n = s[i + 1]
    if (n === '(' && s[i + 2] === '(') { const e = balanced(s, i + 1); parts.push({ t: 'dyn', what: s.slice(i, e) }); return e }
    if (n === '(') { const e = balanced(s, i + 1); parts.push({ t: 'sub', src: s.slice(i + 2, e - 1) }); return e }
    if (n === '{') {
      const e = balanced(s, i + 1, '{', '}')
      const inner = s.slice(i + 2, e - 1)
      const m = /^([A-Za-z_]\w*|\d+|[@*#?$!-])$/.exec(inner)
      const d = /^([A-Za-z_]\w*):?[-=](.*)$/.exec(inner)
      if (m) parts.push({ t: 'var', name: inner, q })
      else if (d) parts.push({ t: 'var', name: d[1] ?? '', q, def: d[2] ?? '' })
      else parts.push({ t: 'dyn', what: `\${${inner}}` })
      return e
    }
    const name = /^([A-Za-z_]\w*|\d|[@*#?$!-])/.exec(s.slice(i + 1))
    if (name) { parts.push({ t: 'var', name: name[1] ?? '', q }); return i + 1 + (name[1] ?? '').length }
    lit('$', q)
    return i + 1
  }
  const backtick = (i: number): number => {
    let j = i + 1
    let src = ''
    for (; j < s.length && s[j] !== '`'; j++) {
      if (s[j] === '\\' && j + 1 < s.length) { src += s[++j]; continue }
      src += s[j]
    }
    parts.push({ t: 'sub', src })
    return j + 1
  }
  const readHeredocs = (i: number): number => {
    for (const p of pending) {
      const lines: string[] = []
      while (i < s.length) {
        const nl = s.indexOf('\n', i)
        const end = nl < 0 ? s.length : nl
        let line = s.slice(i, end)
        i = end + 1
        if (p.strip) line = line.replace(/^\t+/, '')
        if (line === p.delim) break
        lines.push(line)
      }
      p.doc.body = lines.join('\n')
    }
    pending.length = 0
    return i
  }

  let i = 0
  while (i < s.length) {
    const c = s[i] ?? ''
    if (c === '\n') { endWord(i); toks.push({ k: 'op', op: ';' }); i = readHeredocs(i + 1); continue }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(i); i++; continue }
    if (c === '\\' && s[i + 1] === '\n') { i += 2; continue }
    if (c === '#' && !inWord) { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '\\') { begin(i); lit(s[i + 1] ?? '', true); i += 2; continue }
    if (c === "'") {
      begin(i)
      const e = s.indexOf("'", i + 1)
      lit(s.slice(i + 1, e < 0 ? s.length : e), true)
      i = e < 0 ? s.length : e + 1
      continue
    }
    if (c === '$' && s[i + 1] === "'") {
      begin(i)
      let j = i + 2
      let v = ''
      for (; j < s.length && s[j] !== "'"; j++) {
        if (s[j] === '\\') { const n = s[++j] ?? ''; v += n === 'n' ? '\n' : n === 't' ? '\t' : n; continue }
        v += s[j]
      }
      lit(v, true)
      i = j + 1
      continue
    }
    if (c === '"' || (c === '$' && s[i + 1] === '"')) {
      begin(i)
      let j = c === '$' ? i + 2 : i + 1
      lit('', true)
      while (j < s.length && s[j] !== '"') {
        const d = s[j] ?? ''
        if (d === '\\') {
          const n = s[j + 1] ?? ''
          lit('$`"\\\n'.includes(n) ? (n === '\n' ? '' : n) : `\\${n}`, true)
          j += 2
        } else if (d === '$') j = dollar(j, true)
        else if (d === '`') j = backtick(j)
        else { lit(d, true); j++ }
      }
      i = j + 1
      continue
    }
    if (c === '$') { begin(i); i = dollar(i, false); continue }
    if (c === '`') { begin(i); i = backtick(i); continue }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      begin(i)
      const e = balanced(s, i + 1)
      parts.push({ t: 'sub', src: s.slice(i + 2, e - 1) })
      i = e
      continue
    }
    if (c === '~' && (!inWord || /[=:]$/.test(s.slice(start, i)))) {
      const m = /^~([A-Za-z0-9_.-]*)(?=\/|$|\s|;|&|\||\))/.exec(s.slice(i))
      if (m) { begin(i); parts.push({ t: 'tilde', user: m[1] ?? '' }); i += m[0].length; continue }
    }
    if (';&|()<>'.includes(c)) {
      if (inWord && (c === '<' || c === '>') && /^\d+$/.test(s.slice(start, i))) { parts = []; inWord = false }
      endWord(i)
      const op = OPS.find(o => s.startsWith(o, i)) ?? c
      i += op.length
      if (op === '<<' || op === '<<-') {
        while (s[i] === ' ' || s[i] === '\t') i++
        const m = /^(['"]?)([^\s;&|<>'"]+)\1/.exec(s.slice(i))
        const doc: Heredoc = { body: '' }
        if (m) {
          pending.push({ doc, delim: m[2] ?? '', strip: op === '<<-' })
          i += m[0].length
        }
        toks.push({ k: 'heredoc', doc })
      } else if (REDIRS.has(op)) toks.push({ k: 'redir', op })
      else toks.push({ k: 'op', op })
      continue
    }
    begin(i)
    lit(c, false)
    i++
  }
  endWord(s.length)
  return toks
}

function parse(toks: Tok[]): Cmd[] {
  const cmds: Cmd[] = []
  const fresh = (prev: Cmd | null): Cmd => ({ words: [], docs: [], herestrings: [], stdin: null, prev })
  let cur = fresh(null)
  let redir: string | null = null
  const finish = (prev: boolean) => {
    if (cur.words.length || cur.docs.length) cmds.push(cur)
    cur = fresh(prev && (cur.words.length || cur.docs.length) ? cur : null)
  }
  for (const t of toks) {
    if (t.k === 'w') {
      if (redir === '<') cur.stdin = t.w
      else if (redir === '<<<') cur.herestrings.push(t.w)
      else if (redir === null) cur.words.push(t.w)
      redir = null
    } else if (t.k === 'redir') redir = t.op
    else if (t.k === 'heredoc') cur.docs.push(t.doc)
    else finish(t.op === '|' || t.op === '|&')
  }
  finish(false)
  return cmds
}

// ---------------------------------------------------------------- Auswertung

const MAX_DEPTH = 6

/** Alle $(…)/`…` eines Worts als eigene Befehle prüfen. */
function scanSubs(words: Word[], st: State, run: Run): void {
  for (const w of words)
    for (const p of w.parts) if (p.t === 'sub') analyzeIn(p.src, fork(st), run)
}

function lookup(name: string, st: State, ctx: Ctx): Val[] | null {
  if (st.vars.has(name)) return st.vars.get(name) ?? null
  if (name === 'HOME') return ctx.home ? [{ s: ctx.home, glob: false }] : null
  if (name === 'PWD') return st.cwd ? [{ s: st.cwd, glob: false }] : null
  if (name === 'CLAUDE_PROJECT_DIR') return [{ s: ctx.root, glob: false }]
  if (!/^[A-Za-z_]\w*$/.test(name)) return null
  const v = ctx.env(name)
  return v === undefined ? null : [{ s: v, glob: false }]
}

function braces(v: string): string[] {
  const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/s.exec(v)
  if (!m) return [v]
  const [, a = '', mid = '', b = ''] = m
  return mid.split(',').flatMap(x => braces(a + x + b)).slice(0, 64)
}

/** Ein Wort auswerten; null, wenn ein Teil unbekannt ist. */
function expand(w: Word, st: State, ctx: Ctx): Val[] | null {
  let acc: Val[] = [{ s: '', glob: false }]
  const join = (alts: Val[]) => {
    acc = acc.flatMap(a => alts.map(b => ({ s: a.s + b.s, glob: a.glob || b.glob }))).slice(0, 64)
  }
  for (const p of w.parts) {
    if (p.t === 'lit') {
      if (p.q) join([{ s: p.v, glob: false }])
      else join(braces(p.v).map(s => ({ s, glob: /[*?[]|\{[^}]*\.\.[^}]*\}/.test(s) })))
    } else if (p.t === 'var') {
      const v = lookup(p.name, st, ctx) ?? (p.def !== undefined ? [{ s: p.def, glob: false }] : null)
      if (!v) return null
      join(v.map(x => ({ s: x.s, glob: x.glob || (!p.q && /[*?[]/.test(x.s)) })))
    } else if (p.t === 'tilde') {
      if (p.user !== '' || !ctx.home) return null
      join([{ s: ctx.home, glob: false }])
    } else if (p.t === 'sub') {
      const v = evalSub(p.src, st, ctx)
      if (!v) return null
      join([{ s: v, glob: false }])
    } else return null
  }
  return acc
}

/** $(pwd), $(dirname X), $(realpath X), $(cd X && pwd): gängige Pfad-Ausdrücke. */
function evalSub(src: string, st: State, ctx: Ctx): string | null {
  const cmds = parse(lex(src))
  const words = (c: Cmd | undefined) => c?.words ?? []
  const [a, b] = cmds
  const n = (c: Cmd | undefined) => nameOf(one(words(c)[0], st, ctx) ?? '')
  const arg = (c: Cmd | undefined) => {
    const rest = words(c).slice(1).filter(w => !(one(w, st, ctx) ?? '-').startsWith('-'))
    const v = rest.length === 1 ? one(rest[0], st, ctx) : null
    return v === null ? null : absolute(v, st.cwd, ctx, false)
  }
  if (cmds.length === 1 && n(a) === 'pwd') return st.cwd
  if (cmds.length === 1 && n(a) === 'dirname') { const p = arg(a); return p && parentOf(p) }
  if (cmds.length === 1 && (n(a) === 'realpath' || n(a) === 'readlink')) return arg(a)
  if (cmds.length === 2 && n(a) === 'cd' && n(b) === 'pwd') return arg(a)
  return null
}

const one = (w: Word | undefined, st: State, ctx: Ctx): string | null => {
  if (!w) return null
  const v = expand(w, st, ctx)
  return v && v.length === 1 ? (v[0]?.s ?? null) : null
}

const nameOf = (s: string) =>
  s.replace(/^\\/, '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()

/** Optionen überspringen; `withValue` nimmt ein Argument. Liefert den Rest. */
function skipOpts(words: Word[], st: State, ctx: Ctx, withValue: Set<string>, stopAtFirst = true): Word[] {
  let i = 0
  while (i < words.length) {
    const s = one(words[i], st, ctx)
    if (s === null || !s.startsWith('-') || s === '-') break
    i++
    if (s === '--') break
    if (withValue.has(s)) i++
    if (!stopAtFirst) continue
  }
  return words.slice(i)
}

/** Argumente als Löschziele aufnehmen (Optionen übersprungen). */
function pathArgs(args: Word[], st: State, run: Run, via: string, mode: Mode, valueOpts = new Set<string>()): void {
  let opts = true
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    if (!w) continue
    const vals = expand(w, st, run.ctx)
    if (vals === null) { run.out.unknowns.push(`${via}: ${w.raw} (nicht auflösbar)`); continue }
    for (const v of vals) {
      if (opts && v.s === '--') { opts = false; continue }
      if (opts && v.s.startsWith('-') && v.s.length > 1) {
        if (valueOpts.has(v.s)) i++
        continue
      }
      addTarget(run.out, v, st, run.ctx, via, mode, false, via === 'rm' || via === 'rmdir')
    }
  }
}

/** Was eine Pipeline in xargs/bash hineinreicht, als Ziele; null = unbekannt. */
function producer(cmd: Cmd | null, st: State, run: Run): Val[] | null {
  if (!cmd) return null
  if (cmd.stdin) return null
  const words = stripWrappers(cmd.words, st, run.ctx)
  const name = nameOf(one(words[0], st, run.ctx) ?? '')
  const args = words.slice(1)
  const dirs = (list: Word[], dflt = '.'): Val[] | null => {
    const vals: Val[] = []
    for (const w of list) {
      const v = expand(w, st, run.ctx)
      if (!v) return null
      for (const x of v) if (!x.s.startsWith('-')) vals.push({ s: `${x.s.replace(/\/$/, '')}/*`, glob: true })
    }
    return vals.length ? vals : [{ s: `${dflt}/*`, glob: true }]
  }
  switch (name) {
    case 'find': return dirs(findStarts(args))
    case 'fd': case 'fdfind': return dirs(fdPaths(args, st, run.ctx))
    case 'ls': return dirs(args)
    case 'git': return [{ s: `${gitDir(args, st, run.ctx) ?? '.'}/*`, glob: true }]
    case 'echo': case 'printf': {
      const vals: Val[] = []
      for (const w of name === 'printf' ? args.slice(1) : args) {
        const v = expand(w, st, run.ctx)
        if (!v) return null
        vals.push(...v.filter(x => !x.s.startsWith('-')))
      }
      return vals
    }
    case 'grep': case 'rg': case 'ag': case 'egrep': case 'fgrep': {
      const rest = skipOpts(args, st, run.ctx, new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-g', '-t', '--glob', '--type']), false)
      const files = rest.slice(1)
      return files.length ? dirs(files) : producer(cmd.prev, st, run)
    }
    case 'sort': case 'uniq': case 'head': case 'tail': case 'tac': case 'shuf': case 'tee': case 'cat':
      return args.some(w => !(one(w, st, run.ctx) ?? 'x').startsWith('-')) && name === 'cat' ? null : producer(cmd.prev, st, run)
    default: return null
  }
}

function findStarts(args: Word[]): Word[] {
  const out: Word[] = []
  let i = 0
  while (i < args.length && /^-[HLP]$|^-D$|^-O\d$/.test(args[i]?.raw ?? '')) i += args[i]?.raw === '-D' ? 2 : 1
  for (; i < args.length; i++) {
    const r = args[i]?.raw ?? ''
    if (/^[-(!,]/.test(r) || r === '\\(' || r === '\\!') break
    const w = args[i]
    if (w) out.push(w)
  }
  return out
}

function fdPaths(args: Word[], st: State, ctx: Ctx): Word[] {
  const valued = new Set(['-e', '--extension', '-t', '--type', '-d', '--max-depth', '--min-depth', '-E', '--exclude', '-S', '--size', '-x', '--exec', '-X', '--exec-batch', '-j', '--threads', '--changed-within', '--changed-before', '-o', '--owner', '--base-directory', '--search-path'])
  const pos: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const s = one(args[i], st, ctx) ?? ''
    if (s === '-x' || s === '--exec' || s === '-X' || s === '--exec-batch') break
    if (s.startsWith('-')) { if (valued.has(s)) i++; continue }
    const w = args[i]
    if (w) pos.push(w)
  }
  return pos.slice(1)
}

function gitDir(args: Word[], st: State, ctx: Ctx): string | null {
  let dir = st.cwd
  for (let i = 0; i < args.length; i++) {
    const s = one(args[i], st, ctx)
    if (s === '-C') { const d = one(args[++i], st, ctx); dir = d === null ? null : absolute(d, dir, ctx, false) }
    else if (s?.startsWith('--work-tree=')) dir = absolute(s.slice(12), dir, ctx, false)
    else if (s === '-c' || s === '--git-dir' || s === '--work-tree') i++
    else if (!s?.startsWith('-')) break
  }
  return dir
}

const WRAP_VALUED: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  exec: new Set(['-a']),
  time: new Set(['-f', '-o']),
  npx: new Set(['-p', '--package', '-c', '--call']),
  bunx: new Set(['-p', '--package']),
  pnpx: new Set([]),
  setsid: new Set([]),
  nohup: new Set([]),
  builtin: new Set([]),
  command: new Set([]),
  chronic: new Set([]),
  unbuffer: new Set([]),
  caffeinate: new Set(['-t', '-w']),
  busybox: new Set([]),
}

/** sudo, env, nice, timeout, npx … abstreifen; liefert den eigentlichen Befehl. */
function stripWrappers(words: Word[], st: State, ctx: Ctx): Word[] {
  let w = words
  for (let guard = 0; guard < 10 && w.length; guard++) {
    const first = one(w[0], st, ctx)
    if (first === null) return w
    const n = nameOf(first)
    if (/^[A-Za-z_]\w*\+?=/.test(first) && w[0]?.parts[0]?.t === 'lit' && !w[0].parts[0].q) { w = w.slice(1); continue }
    if (['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'fi', 'done', 'esac'].includes(first)) { w = w.slice(1); continue }
    if (n === 'env') {
      let i = 1
      while (i < w.length) {
        const s = one(w[i], st, ctx) ?? ''
        if (s === '-u' || s === '--unset') i += 2
        else if (s === '-C' || s === '--chdir') {
          const d = one(w[i + 1], st, ctx)
          st.cwd = d === null ? null : absolute(d, st.cwd, ctx, false)
          i += 2
        } else if (s.startsWith('-') || /^[A-Za-z_]\w*=/.test(s)) i++
        else break
      }
      w = w.slice(i)
      continue
    }
    if (n === 'pnpm' || n === 'yarn' || n === 'npm') {
      const sub = one(w[1], st, ctx)
      if (sub === 'dlx' || sub === 'exec' || sub === 'x') { w = skipOpts(w.slice(2), st, ctx, new Set()); continue }
      return w
    }
    if (n === 'command' && ['-v', '-V'].includes(one(w[1], st, ctx) ?? '')) return []
    if (n === 'timeout') {
      const rest = skipOpts(w.slice(1), st, ctx, WRAP_VALUED.timeout ?? new Set())
      w = rest.slice(1)
      continue
    }
    const valued = WRAP_VALUED[n]
    if (!valued) return w
    w = skipOpts(w.slice(1), st, ctx, valued)
  }
  return w
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish', 'su'])
const INTERP: Record<string, string[]> = {
  python: ['-c'], python3: ['-c'], py: ['-c'], pypy: ['-c'], pypy3: ['-c'],
  node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval'], bun: ['-e', '--eval'],
  perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'],
}

function runCmd(cmd: Cmd, st: State, run: Run, words0: Word[] = cmd.words): void {
  const { ctx, out } = run
  scanSubs(words0, st, run)

  // Zuweisungen am Anfang: alleinstehend = Shell-Variable.
  const assigns: [string, Word][] = []
  let k = 0
  for (; k < words0.length; k++) {
    const w = words0[k]
    const p0 = w?.parts[0]
    const m = p0?.t === 'lit' && !p0.q ? /^([A-Za-z_]\w*)=/.exec(p0.v) : null
    if (!w || !m || !p0 || p0.t !== 'lit') break
    assigns.push([m[1] ?? '', { raw: w.raw, parts: [{ ...p0, v: p0.v.slice(m[0].length) }, ...w.parts.slice(1)] }])
  }
  if (k === words0.length) {
    for (const [n, w] of assigns) st.vars.set(n, expand(w, st, ctx))
    return
  }

  const words = stripWrappers(words0, st, ctx)
  if (!words.length) return
  const head = one(words[0], st, ctx)
  if (head === null) {
    if (/rm|del|unlink|shred|trash|remove/i.test(words[0]?.raw ?? '')) out.unknowns.push(`Befehl nicht auflösbar: ${words[0]?.raw}`)
    return
  }
  const name = nameOf(head)
  const args = words.slice(1)

  if (name === 'export' || name === 'local' || name === 'declare' || name === 'typeset' || name === 'readonly') {
    for (const w of args) {
      const p0 = w.parts[0]
      const m = p0?.t === 'lit' ? /^([A-Za-z_]\w*)=/.exec(p0.v) : null
      if (m && p0 && p0.t === 'lit') st.vars.set(m[1] ?? '', expand({ raw: w.raw, parts: [{ ...p0, v: p0.v.slice(m[0].length) }, ...w.parts.slice(1)] }, st, ctx))
    }
    return
  }
  if (name === 'read' || name === 'mapfile' || name === 'readarray') {
    for (const w of args) { const s = one(w, st, ctx); if (s && /^[A-Za-z_]\w*$/.test(s)) st.vars.set(s, null) }
    return
  }
  if (name === 'for') {
    const v = one(args[0], st, ctx)
    if (v && one(args[1], st, ctx) === 'in') {
      const vals: Val[] = []
      let known = true
      for (const w of args.slice(2)) {
        const x = expand(w, st, ctx)
        if (!x) { known = false; break }
        vals.push(...x)
      }
      st.vars.set(v, known ? vals : null)
    } else if (v) st.vars.set(v, null)
    return
  }
  if (name === 'cd' || name === 'pushd' || name === 'chdir') {
    const rest = skipOpts(args, st, ctx, new Set())
    const target = rest.length ? one(rest[0], st, ctx) : ctx.home
    if (name === 'pushd') st.stack.push(st.cwd)
    st.cwd = target === null || target === '-' ? null : absolute(target, st.cwd, ctx, false)
    return
  }
  if (name === 'popd') { st.cwd = st.stack.length ? (st.stack.pop() ?? null) : null; return }

  // Pipeline-Eingabe (xargs): ihre Ziele zählen zu den Löschzielen.
  const piped = st.pipe

  if (DELETE_CMDS.has(name) || name === 'del') {
    const valued = name === 'shred' ? new Set(['-n', '-s', '--iterations', '--size', '--random-source']) : new Set<string>()
    pathArgs(args, st, run, name, 'exact', valued)
    if (piped !== undefined) {
      if (piped === null) out.unknowns.push(`${name}: Eingabe aus der Pipeline nicht bestimmbar`)
      else out.targets.push(...piped.map(t => ({ ...t, via: name })))
    }
    return
  }
  if (name === 'gio' || name === 'kioclient' || name === 'kioclient5') {
    const sub = one(args[0], st, ctx)
    if (sub === 'trash' || sub === 'remove' || sub === 'rm' || sub === 'del') pathArgs(args.slice(1), st, run, `${name} ${sub}`, 'exact')
    return
  }
  if (name === 'find') return findCmd(args, st, run)
  if (name === 'fd' || name === 'fdfind') {
    const raws = args.map(w => one(w, st, ctx) ?? '')
    const x = raws.findIndex(r => ['-x', '--exec', '-X', '--exec-batch'].includes(r))
    if (x >= 0 && DELETE_CMDS.has(nameOf(raws[x + 1] ?? ''))) {
      const paths = fdPaths(args, st, ctx)
      if (!paths.length) addTarget(out, { s: '.', glob: false }, st, ctx, name, 'children', false)
      pathArgs(paths, st, run, name, 'children')
    }
    return
  }
  if (name === 'xargs' || name === 'parallel') {
    const valued = new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-e', '-I', '-i', '-L', '-l', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '-j', '--jobs'])
    let j = 0
    let fromFile = false
    while (j < args.length) {
      const s = one(args[j], st, ctx)
      if (s === null || !s.startsWith('-')) break
      if (s === '-a' || s === '--arg-file' || s.startsWith('--arg-file=')) fromFile = true
      j += valued.has(s) ? 2 : 1
    }
    const rest = args.slice(j)
    const inner = fork(st)
    inner.pipe = fromFile || cmd.stdin ? null : (() => {
      const p = producer(cmd.prev, st, run)
      if (!p) return null
      const o: Out = { targets: [], unknowns: [], scripts: [] }
      for (const v of p) addTarget(o, v, st, ctx, 'xargs', 'exact', false, true)
      return o.unknowns.length ? null : o.targets
    })()
    if (rest.length) runCmd({ ...cmd, words: rest, prev: null }, inner, run)
    return
  }
  if (name === 'rsync') return rsyncCmd(args, st, run)
  if (name === 'git') return gitCmd(args, st, run)
  if (name === 'dd') {
    for (const w of args) { const s = one(w, st, ctx); if (s?.startsWith('of=')) addTarget(out, { s: s.slice(3), glob: false }, st, ctx, 'dd', 'exact', false) }
    return
  }
  if (/^mkfs(\.|$)|^wipefs$|^mke2fs$/.test(name)) return pathArgs(args, st, run, name, 'exact', new Set(['-t', '-L', '-b', '-n', '-O', '-o']))
  if (name === 'eval') {
    const parts: string[] = []
    for (const w of args) { const s = one(w, st, ctx); if (s === null) return void out.unknowns.push(`eval mit unbekanntem Inhalt: ${w.raw}`); parts.push(s) }
    return analyzeIn(parts.join(' '), st, run)
  }
  if (SHELLS.has(name) || name === 'wsl' || name === 'wsl.exe') return shellCmd(name, cmd, args, st, run)
  if (name === 'watch') {
    const rest = skipOpts(args, st, ctx, new Set(['-n', '--interval', '-d', '-q']))
    return analyzeIn(rest.map(w => one(w, st, ctx) ?? '').join(' '), st, run)
  }
  if (name === 'powershell' || name === 'pwsh' || name === 'cmd') {
    const vals = args.map(w => one(w, st, ctx))
    return nested(name, vals, st, run, cmd)
  }
  const flags = INTERP[name.replace(/[\d.]+$/, '')] ?? INTERP[name]
  if (flags) return interpCmd(name, flags, cmd, args, st, run)
  if (name === 'deno' && one(args[0], st, ctx) === 'eval') {
    const code = one(args[1], st, ctx)
    if (code !== null) inlineCode(code, [], st, ctx, out, 'deno eval')
    return
  }
  if (name === 'source' || name === '.') {
    const p = one(args[0], st, ctx)
    const abs = p === null ? null : absolute(p, st.cwd, ctx, false)
    if (abs) out.scripts.push({ path: abs, lang: 'bash' })
    return
  }
  // ./skript.sh direkt ausgeführt
  if (/\.(sh|bash)$/.test(head) || (head.includes('/') && !head.startsWith('/usr/') && !head.startsWith('/bin/'))) {
    const abs = absolute(head, st.cwd, ctx, false)
    if (abs && /\.(sh|bash)$/.test(abs)) out.scripts.push({ path: abs, lang: 'bash' })
    if (abs && /\.ps1$/i.test(abs)) out.scripts.push({ path: abs, lang: 'ps' })
    if (abs && /\.(cmd|bat)$/i.test(abs)) out.scripts.push({ path: abs, lang: 'cmd' })
  }
}

function findCmd(args: Word[], st: State, run: Run): void {
  const { ctx } = run
  const raws = args.map(w => one(w, st, ctx))
  let deletes = raws.includes('-delete')
  for (let i = 0; i < raws.length && !deletes; i++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(raws[i] ?? '')) continue
    const inner: string[] = []
    for (let j = i + 1; j < raws.length && raws[j] !== ';' && raws[j] !== '+'; j++) inner.push(raws[j] ?? '?')
    const stripped = stripWrappers(args.slice(i + 1, i + 1 + inner.length), st, ctx)
    const n = nameOf(one(stripped[0], st, ctx) ?? '')
    if (DELETE_CMDS.has(n) || (SHELLS.has(n) && /\b(rm|rmdir|unlink|shred)\b/.test(inner.join(' ')))) deletes = true
  }
  if (!deletes) return
  const starts = findStarts(args)
  if (!starts.length) return addTarget(run.out, { s: '.', glob: false }, st, ctx, 'find', 'children', false)
  for (const w of starts) {
    const vals = expand(w, st, ctx)
    if (!vals) { run.out.unknowns.push(`find: ${w.raw} (nicht auflösbar)`); continue }
    for (const v of vals) addTarget(run.out, v, st, ctx, 'find', v.glob ? 'exact' : 'children', false)
  }
}

function rsyncCmd(args: Word[], st: State, run: Run): void {
  const { ctx } = run
  const valued = new Set(['-e', '--rsh', '-f', '--filter', '--exclude', '--include', '--exclude-from', '--include-from', '--files-from', '-T', '--temp-dir', '--log-file', '--port', '--password-file', '-B', '--chmod', '--chown', '-M', '--partial-dir', '--backup-dir', '--compare-dest', '--link-dest', '--copy-dest'])
  let del = false
  let removeSrc = false
  const pos: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const s = one(args[i], st, ctx)
    if (s === null) { const w = args[i]; if (w) pos.push(w); continue }
    if (s.startsWith('--del')) del = true
    else if (s === '--remove-source-files') removeSrc = true
    else if (s.startsWith('-')) { if (valued.has(s)) i++ }
    else { const w = args[i]; if (w) pos.push(w) }
  }
  if (!del && !removeSrc) return
  const local = (w: Word) => !/^[^/]*:/.test(one(w, st, ctx) ?? '') || /^[A-Za-z]:[\\/]/.test(one(w, st, ctx) ?? '')
  const dest = pos[pos.length - 1]
  if (del && dest && local(dest)) pathArgs([dest], st, run, 'rsync --delete', 'children')
  if (removeSrc) pathArgs(pos.slice(0, -1).filter(local), st, run, 'rsync --remove-source-files', 'children')
}

function gitCmd(args: Word[], st: State, run: Run): void {
  const { ctx } = run
  const dir = gitDir(args, st, ctx)
  let i = 0
  for (; i < args.length; i++) {
    const s = one(args[i], st, ctx)
    if (s === '-C' || s === '-c' || s === '--git-dir' || s === '--work-tree') { i++; continue }
    if (!s?.startsWith('-')) break
  }
  const sub = one(args[i], st, ctx)
  const rest = args.slice(i + 1)
  const sub2 = { cwd: dir, vars: st.vars, stack: [], pipe: undefined } satisfies State
  const flags = rest.map(w => one(w, st, ctx) ?? '')
  if (sub === 'clean') {
    if (flags.some(f => f === '-n' || f === '--dry-run')) return
    const paths = rest.filter((_, j) => !(flags[j] ?? '').startsWith('-'))
    if (!paths.length) addTarget(run.out, { s: '.', glob: false }, sub2, ctx, 'git clean', 'children', false)
    pathArgs(paths, sub2, run, 'git clean', 'children')
  } else if (sub === 'rm') {
    if (flags.includes('--cached')) return
    pathArgs(rest, sub2, run, 'git rm', 'exact', new Set(['--pathspec-from-file']))
  } else if (sub === 'worktree' && flags[0] === 'remove') {
    pathArgs(rest.slice(1), sub2, run, 'git worktree remove', 'deep')
  }
}

function interpCmd(name: string, flags: string[], cmd: Cmd, args: Word[], st: State, run: Run): void {
  const { ctx, out } = run
  for (let i = 0; i < args.length; i++) {
    const s = one(args[i], st, ctx)
    if (s !== null && flags.some(f => s === f || (f.length === 2 && /^-[A-Za-z]+$/.test(s) && s.endsWith(f[1] ?? '')))) {
      const code = one(args[i + 1], st, ctx)
      if (code === null) return void out.unknowns.push(`${name}: Code nicht auflösbar`)
      const rest = args.slice(i + 2).flatMap(w => expand(w, st, ctx) ?? [])
      return inlineCode(code, rest, st, ctx, out, name)
    }
    if (s === null || !s.startsWith('-')) {
      if (s === null || s !== '-') return
      break
    }
  }
  for (const d of cmd.docs) inlineCode(d.body, [], st, ctx, out, name)
  for (const h of cmd.herestrings) { const s = one(h, st, ctx); if (s) inlineCode(s, [], st, ctx, out, name) }
}

function shellCmd(name: string, cmd: Cmd, args: Word[], st: State, run: Run): void {
  const { ctx, out } = run
  if (name === 'wsl' || name === 'wsl.exe') {
    let i = 0
    for (; i < args.length; i++) {
      const s = one(args[i], st, ctx) ?? ''
      if (s === '-e' || s === '--exec' || s === '--') { i++; break }
      if (['-d', '--distribution', '-u', '--user', '--cd'].includes(s)) { i++; continue }
      if (!s.startsWith('-')) break
    }
    return analyzeIn(args.slice(i).map(w => w.raw).join(' '), st, run)
  }
  let i = 0
  let code: string | null | undefined
  for (; i < args.length; i++) {
    const s = one(args[i], st, ctx)
    if (s === null) break
    if (s === '--') { i++; break }
    if (!s.startsWith('-') && !s.startsWith('+')) break
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(s) || s === '--command') {
      code = one(args[i + 1], st, ctx)
      i += 2
      break
    }
    if (s === '-o' || s === '-O' || s === '--rcfile' || s === '--init-file') i++
  }
  if (code !== undefined) {
    if (code === null) return void out.unknowns.push(`${name} -c mit unbekanntem Inhalt`)
    const inner = fork(st)
    args.slice(i).forEach((w, j) => inner.vars.set(String(j), expand(w, st, ctx)))
    const pos = args.slice(i + 1).flatMap(w => expand(w, st, ctx) ?? [])
    inner.vars.set('@', pos)
    inner.vars.set('*', pos)
    return analyzeIn(code, inner, run)
  }
  const script = args[i]
  if (script) {
    const p = one(script, st, ctx)
    const abs = p === null ? null : absolute(p, st.cwd, ctx, false)
    if (abs) out.scripts.push({ path: abs, lang: 'bash' })
    else out.unknowns.push(`${name}: Skript nicht auflösbar`)
    return
  }
  // Skript über stdin: Heredoc, Here-String oder Pipeline.
  for (const d of cmd.docs) analyzeIn(d.body, fork(st), run)
  for (const h of cmd.herestrings) { const s = one(h, st, ctx); if (s !== null) analyzeIn(s, fork(st), run); else out.unknowns.push(`${name}: Eingabe nicht auflösbar`) }
  if (!cmd.docs.length && !cmd.herestrings.length && (cmd.prev || cmd.stdin)) {
    const src = cmd.prev ? stripWrappers(cmd.prev.words, st, ctx) : []
    const pn = nameOf(one(src[0], st, ctx) ?? '')
    if ((pn === 'echo' || pn === 'printf') && cmd.prev) {
      const text = src.slice(1).map(w => one(w, st, ctx))
      if (text.some(t => t === null)) out.unknowns.push(`${name}: Skript aus Pipeline nicht prüfbar`)
      else analyzeIn(text.join(' '), fork(st), run)
    } else if (pn === 'cat' && cmd.prev?.docs.length) for (const d of cmd.prev.docs) analyzeIn(d.body, fork(st), run)
    else out.unknowns.push(`${name}: Skript aus Pipeline/Datei nicht prüfbar`)
  }
}

/** powershell/pwsh/cmd aus Bash heraus (WSL, Git Bash). */
function nested(name: string, vals: (string | null)[], st: State, run: Run, cmd?: Cmd): void {
  const { out } = run
  const lower = vals.map(v => v?.toLowerCase() ?? null)
  if (name === 'cmd') {
    const i = lower.findIndex(v => v === '/c' || v === '/k' || (v !== null && /^\/[a-z]*[ck]$/.test(v)))
    if (i < 0) return
    const rest = vals.slice(i + 1)
    if (rest.some(v => v === null)) return void out.unknowns.push('cmd /c mit unbekanntem Inhalt')
    return lang.cmd(rest.join(' '), fork(st), run)
  }
  for (let i = 0; i < vals.length; i++) {
    const v = lower[i]
    if (v === null || v === undefined) continue
    if (/^[-/](encodedcommand|enc|ec|e)$/.test(v)) {
      const text = decodeEncoded(vals[i + 1] ?? '')
      return text === null ? void out.unknowns.push(`${name}: -EncodedCommand nicht lesbar`) : lang.ps(text, fork(st), run)
    }
    if (/^[-/](command|c)$/.test(v)) {
      const rest = vals.slice(i + 1)
      if (rest.some(x => x === null)) return void out.unknowns.push(`${name} -Command mit unbekanntem Inhalt`)
      if (rest.length === 1 && rest[0] === '-') {
        for (const d of cmd?.docs ?? []) lang.ps(d.body, fork(st), run)
        return
      }
      return lang.ps(rest.join(' '), fork(st), run)
    }
    if (/^[-/](file|f)$/.test(v)) {
      const p = vals[i + 1]
      const abs = p ? absolute(p, st.cwd, run.ctx, true) : null
      if (abs) out.scripts.push({ path: abs, lang: 'ps' })
      return
    }
    if (/^[-/](workingdirectory|wd)$/.test(v)) {
      const d = vals[++i]
      st.cwd = d ? absolute(d, st.cwd, run.ctx, true) : null
      continue
    }
    if (/^[-/](executionpolicy|ep|windowstyle|w|configurationname|outputformat|of|inputformat|if|version|v|settingsfile|custompipename)$/.test(v)) { i++; continue }
    if (v.startsWith('-') || v.startsWith('/')) continue
    // erstes freies Argument: bei pwsh ein Skript, bei powershell.exe Befehlstext
    if (/\.ps1$/.test(v)) {
      const abs = absolute(vals[i] ?? '', st.cwd, run.ctx, true)
      if (abs) out.scripts.push({ path: abs, lang: 'ps' })
      return
    }
    const rest = vals.slice(i)
    if (rest.some(x => x === null)) return void out.unknowns.push(`${name}: Befehl nicht auflösbar`)
    return lang.ps(rest.join(' '), fork(st), run)
  }
}

export function analyzeIn(src: string, st: State, run: Run): void {
  if (run.depth >= MAX_DEPTH) return void run.out.unknowns.push('zu tief verschachtelt')
  const inner = { ...run, depth: run.depth + 1 }
  for (const cmd of parse(lex(src))) runCmd(cmd, st, inner)
}

export function analyzeBash(src: string, st: State, ctx: Ctx, out: Out): void {
  analyzeIn(src, st, { ctx, out, depth: 0 })
}

lang.bash = analyzeIn
lang.nested = nested
