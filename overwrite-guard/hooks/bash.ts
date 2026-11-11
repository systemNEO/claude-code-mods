// Bash (Linux, WSL, Git Bash): Befehlszeile zerlegen und jede Stelle finden,
// die eine Datei komplett neu schreibt: `>`/`>|`/`&>`, tee ohne -a, cp/mv
// auf eine Datei, Schreibaufrufe in Code für Interpreter. Anhängen (`>>`)
// bleibt frei. Lexer und Wortauswertung stammen aus delete-guard (hooks/bash.ts),
// gekürzt auf das, was hier gebraucht wird.

import {
  type Ctx, type Cwds, type Run, MAX_DEPTH, addFile, addInto, inlineCode, interpreterFlags, lang, resolveAll,
} from './common'

type Part =
  | { t: 'lit'; v: string; q: boolean }
  | { t: 'var'; name: string; q: boolean; def?: string }
  | { t: 'sub'; src: string }
  | { t: 'dyn' }
  | { t: 'tilde'; user: string }

type Word = { parts: Part[]; raw: string }
type Heredoc = { body: string }
type Tok =
  | { k: 'w'; w: Word }
  | { k: 'op'; op: string }
  | { k: 'redir'; op: string }
  | { k: 'heredoc'; doc: Heredoc }

type Redirect = { op: string; target: Word }

type Cmd = {
  words: Word[]; docs: Heredoc[]; herestrings: Word[]; redirects: Redirect[]
  /** Subshell-Tiefe `( … )`. */
  sub: number
  /** Der Operator danach (`&&`, `;`, `|` …). */
  after: string
}

const OPS = ['&&', '||', ';;&', ';;', ';&', '|&', '&>>', '&>', '>>', '>|', '>&', '<&', '<<<', '<<-', '<<', '<>', '>', '<', ';', '&', '|', '(', ')']
const REDIRS = new Set(['&>>', '&>', '>>', '>|', '>&', '<&', '<<<', '<>', '>', '<'])
/** Umleitungen, die die Zieldatei leeren und neu schreiben. */
const TRUNCATING = new Set(['>', '>|', '&>', '>&'])

/** Index hinter der schließenden Klammer zu `s[i]`, Anführungen beachtet. */
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

/** Das Innere von `${…}`: Variable, Vorgabe (`:-`), sonst unbekannt. */
function paramPart(inner: string, q: boolean): Part {
  if (/^([A-Za-z_]\w*|\d+|[@*#?$!-])$/.test(inner)) return { t: 'var', name: inner, q }
  const m = /^([A-Za-z_]\w*):?[-=](.*)$/s.exec(inner)
  return m ? { t: 'var', name: m[1] ?? '', q, def: m[2] ?? '' } : { t: 'dyn' }
}

function lex(s: string): Tok[] {
  const toks: Tok[] = []
  let parts: Part[] = []
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
    inWord = false
  }
  const begin = (i: number) => { if (!inWord) { start = i; inWord = true } }

  const dollar = (i: number, q: boolean): number => {
    const n = s[i + 1]
    if (n === '(' && s[i + 2] === '(') { const e = balanced(s, i + 1); parts.push({ t: 'dyn' }); return e }
    if (n === '(') { const e = balanced(s, i + 1); parts.push({ t: 'sub', src: s.slice(i + 2, e - 1) }); return e }
    if (n === '{') { const e = balanced(s, i + 1, '{', '}'); parts.push(paramPart(s.slice(i + 2, e - 1), q)); return e }
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
      // `2>`: die Ziffer davor ist die Kanalnummer, kein Wort.
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
  let depth = 0
  const fresh = (): Cmd => ({ words: [], docs: [], herestrings: [], redirects: [], sub: depth, after: ';' })
  let cur = fresh()
  let redir: string | null = null
  const finish = (op: string) => {
    if (cur.words.length || cur.docs.length || cur.redirects.length) { cur.after = op; cmds.push(cur) }
    cur = fresh()
  }
  for (const t of toks) {
    if (t.k === 'w') {
      if (redir === '<<<') cur.herestrings.push(t.w)
      else if (redir !== null) cur.redirects.push({ op: redir, target: t.w })
      else cur.words.push(t.w)
      redir = null
    } else if (t.k === 'redir') redir = t.op
    else if (t.k === 'heredoc') cur.docs.push(t.doc)
    else {
      finish(t.op)
      if (t.op === '(') depth++
      if (t.op === ')') depth = Math.max(0, depth - 1)
      cur.sub = depth
    }
  }
  finish(';')
  return cmds
}

// ---------------------------------------------------------------- Auswertung

type Vars = Map<string, string[] | null>
type State = { cwds: Cwds; vars: Vars }

const MAX_VARIANTS = 64

const copy = (st: State): State => ({ cwds: st.cwds ? [...st.cwds] : null, vars: new Map(st.vars) })

function lookup(name: string, st: State, ctx: Ctx): string[] | null {
  if (st.vars.has(name)) return st.vars.get(name) ?? null
  if (name === 'HOME') return ctx.home ? [ctx.home] : null
  if (name === 'PWD') return st.cwds?.length === 1 ? st.cwds : null
  if (name === 'CLAUDE_PROJECT_DIR') return [ctx.root]
  if (!/^[A-Za-z_]\w*$/.test(name)) return null
  const v = ctx.env(name)
  return v === undefined ? null : [v]
}

/** `{a,b}` ausmultiplizieren; null bei mehr als MAX_VARIANTS Ergebnissen. */
function braces(v: string): string[] | null {
  const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/s.exec(v)
  if (!m) return [v]
  const [, a = '', mid = '', b = ''] = m
  const out: string[] = []
  for (const x of mid.split(',')) {
    const r = braces(a + x + b)
    if (r === null || out.length + r.length > MAX_VARIANTS) return null
    out.push(...r)
  }
  return out
}

/** Ein Wort auswerten (mehrere Werte bei `{a,b}` und for-Listen); null, wenn ein Teil unbekannt ist. */
function expand(w: Word, st: State, ctx: Ctx): string[] | null {
  let acc = ['']
  const join = (alts: string[]): boolean => {
    if (acc.length * alts.length > MAX_VARIANTS) return false
    acc = acc.flatMap(a => alts.map(b => a + b))
    return true
  }
  for (const p of w.parts) {
    let alts: string[] | null
    if (p.t === 'lit') alts = p.q ? [p.v] : braces(p.v)
    else if (p.t === 'var') alts = lookup(p.name, st, ctx) ?? (p.def !== undefined ? [p.def] : null)
    else if (p.t === 'tilde') alts = p.user === '' && ctx.home ? [ctx.home] : null
    else if (p.t === 'sub') alts = /^\s*pwd\s*$/.test(p.src) && st.cwds?.length === 1 ? st.cwds : null
    else alts = null
    if (alts === null || !join(alts)) return null
  }
  return acc
}

const one = (w: Word | undefined, st: State, ctx: Ctx): string | null => {
  const v = w ? expand(w, st, ctx) : null
  return v && v.length === 1 ? (v[0] ?? null) : null
}

const nameOf = (s: string) => s.replace(/^\\/, '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()

/** Ein geschriebenes Wort als Ziel: bekannt, oder sein Text als Hinweis. */
function target(w: Word, st: State, run: Run, via: string): void {
  const vals = expand(w, st, run.ctx)
  if (vals === null) return void run.out.push({ kind: 'computed', hint: w.raw, via })
  for (const v of vals) addFile(run.out, v, st.cwds, run.ctx, via, false)
}

/** Optionen überspringen; `withValue` nimmt ein Argument. */
function skipOpts(words: Word[], st: State, ctx: Ctx, withValue: Set<string>): Word[] {
  let i = 0
  while (i < words.length) {
    const s = one(words[i], st, ctx)
    if (s === null || !s.startsWith('-') || s === '-') break
    i++
    if (s === '--') break
    if (withValue.has(s)) i++
  }
  return words.slice(i)
}

const WRAP_VALUED: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u']),
  stdbuf: new Set(['-i', '-o', '-e']),
  exec: new Set(['-a']),
  time: new Set(['-f', '-o']),
  setsid: new Set(), nohup: new Set(), builtin: new Set(), command: new Set(), chronic: new Set(), unbuffer: new Set(),
}
const KEYWORDS = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'fi', 'done', 'esac'])

/** sudo, env, nice, timeout … abstreifen; liefert den eigentlichen Befehl. */
function stripWrappers(words: Word[], st: State, ctx: Ctx): Word[] {
  let w = words
  for (let guard = 0; guard < 10 && w.length; guard++) {
    const first = one(w[0], st, ctx)
    if (first === null) return w
    const n = nameOf(first)
    if (KEYWORDS.has(first)) { w = w.slice(1); continue }
    if (n === 'env') {
      let i = 1
      while (i < w.length) {
        const s = one(w[i], st, ctx) ?? ''
        if (s === '-u' || s === '--unset') i += 2
        else if (s === '-C' || s === '--chdir') {
          const d = one(w[i + 1], st, ctx)
          st.cwds = d === null ? null : resolveAll(d, st.cwds, ctx, false)
          i += 2
        } else if (s.startsWith('-') || /^[A-Za-z_]\w*=/.test(s)) i++
        else break
      }
      w = w.slice(i)
      continue
    }
    if (n === 'timeout') { w = skipOpts(w.slice(1), st, ctx, new Set(['-s', '-k', '--signal', '--kill-after'])).slice(1); continue }
    const valued = WRAP_VALUED[n]
    if (!valued) return w
    w = skipOpts(w.slice(1), st, ctx, valued)
  }
  return w
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh'])

/** tee: jede Datei, außer mit -a/--append. */
function teeCmd(args: Word[], st: State, run: Run): void {
  const vals = args.map(w => one(w, st, run.ctx))
  if (vals.some(v => v === '--append' || (v !== null && /^-[a-z]*a[a-z]*$/.test(v)))) return
  let opts = true
  args.forEach((w, i) => {
    const v = vals[i]
    if (opts && v === '--') { opts = false; return }
    if (opts && typeof v === 'string' && v.startsWith('-') && v.length > 1) return
    target(w, st, run, 'tee')
  })
}

const NO_CLOBBER = /^(-n|--no-clobber|--update=none|--update=none-fail)$/
const COPY_VALUED = new Set(['-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '--backup'])

/** cp, mv, install: das Ziel, mit den Namen der Quellen (falls es ein Ordner ist). */
function copyCmd(name: string, args: Word[], st: State, run: Run): void {
  const { ctx } = run
  const pos: Word[] = []
  let dir: Word | null = null
  let opts = true
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    if (!w) continue
    const v = one(w, st, ctx)
    if (opts && v === '--') { opts = false; continue }
    if (opts && v !== null && v.startsWith('-') && v.length > 1) {
      if (NO_CLOBBER.test(v) || (/^-[a-zA-Z]+$/.test(v) && v.includes('n'))) return
      if (v === '-t' || v === '--target-directory') { dir = args[++i] ?? null; continue }
      if (v.startsWith('--target-directory=')) { dir = { raw: v.slice(19), parts: [{ t: 'lit', v: v.slice(19), q: true }] }; continue }
      if (COPY_VALUED.has(v)) i++
      continue
    }
    pos.push(w)
  }
  const dest = dir ?? pos.pop()
  if (!dest || !pos.length) return
  const d = expand(dest, st, ctx)
  if (d === null) return void run.out.push({ kind: 'computed', hint: dest.raw, via: name })
  const sources = pos.flatMap(w => expand(w, st, ctx) ?? [w.raw])
  for (const v of d) addInto(run.out, v, sources, st.cwds, ctx, name, false)
}

function interpCmd(name: string, flags: string[], cmd: Cmd, args: Word[], st: State, run: Run): void {
  const { ctx, out } = run
  for (let i = 0; i < args.length; i++) {
    const s = one(args[i], st, ctx)
    if (s !== null && flags.some(f => s === f || (f.length === 2 && /^-[A-Za-z]+$/.test(s) && s.endsWith(f[1] ?? '')))) {
      const cw = args[i + 1]
      const codes = cw ? expand(cw, st, ctx) : null
      if (codes === null) return void (cw && inlineCode(cw.raw, st.cwds, ctx, out, name))
      for (const c of codes) inlineCode(c, st.cwds, ctx, out, name)
      return
    }
    // Ein Skript als Argument: der Code steht nicht im Befehl.
    if (s === null || !s.startsWith('-')) return
    if (s === '-') break
  }
  for (const d of cmd.docs) inlineCode(d.body, st.cwds, ctx, out, name)
  for (const h of cmd.herestrings) inlineCode(one(h, st, ctx) ?? h.raw, st.cwds, ctx, out, name)
}

function shellCmd(name: string, cmd: Cmd, args: Word[], st: State, run: Run): void {
  const { ctx } = run
  for (let i = 0; i < args.length; i++) {
    const s = one(args[i], st, ctx)
    if (s === null || !s.startsWith('-')) return
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(s) || s === '--command') {
      const code = one(args[i + 1], st, ctx)
      return code === null ? void run.out.push({ kind: 'computed', hint: args[i + 1]?.raw ?? '', via: `${name} -c` }) : analyzeIn(code, copy(st), run)
    }
    if (s === '-o' || s === '-O' || s === '--rcfile' || s === '--init-file') i++
  }
  for (const d of cmd.docs) analyzeIn(d.body, copy(st), run)
  for (const h of cmd.herestrings) { const s = one(h, st, ctx); if (s !== null) analyzeIn(s, copy(st), run) }
}

/** powershell/pwsh -Command und cmd /c aus Bash heraus (WSL, Git Bash). */
function nested(name: string, args: Word[], st: State, run: Run): void {
  const vals = args.map(w => one(w, st, run.ctx))
  const lower = vals.map(v => v?.toLowerCase() ?? '')
  if (name === 'cmd') {
    const i = lower.findIndex(v => /^\/[a-z]*[ck]$/.test(v))
    if (i >= 0) lang.cmd(vals.slice(i + 1).map((v, j) => v ?? args[i + 1 + j]?.raw ?? '').join(' '), st.cwds, run)
    return
  }
  const i = lower.findIndex(v => /^[-/](command|c)$/.test(v))
  if (i >= 0) lang.ps(vals.slice(i + 1).map((v, j) => v ?? args[i + 1 + j]?.raw ?? '').join(' '), st.cwds, run)
}

const LEAD_KEYWORDS = new Set(['do', 'then', 'else', '{', '!', 'if', 'elif', 'while', 'until'])

function assignment(w: Word | undefined): [string, Word] | null {
  const p0 = w?.parts[0]
  const m = p0?.t === 'lit' && !p0.q ? /^([A-Za-z_]\w*)=/.exec(p0.v) : null
  if (!w || !m || !p0 || p0.t !== 'lit') return null
  return [m[1] ?? '', { raw: w.raw, parts: [{ ...p0, v: p0.v.slice(m[0].length) }, ...w.parts.slice(1)] }]
}

function runCmd(cmd: Cmd, st: State, run: Run): void {
  const { ctx } = run
  for (const w of [...cmd.words, ...cmd.redirects.map(r => r.target)])
    for (const p of w.parts) if (p.t === 'sub') analyzeIn(p.src, copy(st), run)

  for (const r of cmd.redirects) {
    if (!TRUNCATING.has(r.op)) continue
    const v = one(r.target, st, ctx)
    // `>&2`, `>&-`: ein Kanal, keine Datei.
    if (r.op === '>&' && v !== null && /^(\d+|-)$/.test(v)) continue
    target(r.target, st, run, r.op)
  }

  let words = cmd.words
  while (words.length && LEAD_KEYWORDS.has(one(words[0], st, ctx) ?? '')) words = words.slice(1)
  const assigns: [string, Word][] = []
  for (const w of words) {
    const a = assignment(w)
    if (!a) break
    assigns.push(a)
  }
  if (assigns.length === words.length) {
    for (const [n, w] of assigns) st.vars.set(n, expand(w, st, ctx))
    return
  }
  words = stripWrappers(words.slice(assigns.length), st, ctx)
  const head = one(words[0], st, ctx)
  if (head === null) return
  const name = nameOf(head)
  const args = words.slice(1)

  if (name === 'export' || name === 'local' || name === 'declare' || name === 'typeset' || name === 'readonly') {
    for (const w of args) { const a = assignment(w); if (a) st.vars.set(a[0], expand(a[1], st, ctx)) }
    return
  }
  if (name === 'read' || name === 'mapfile' || name === 'readarray') {
    for (const w of args) { const s = one(w, st, ctx); if (s && /^[A-Za-z_]\w*$/.test(s)) st.vars.set(s, null) }
    return
  }
  if (name === 'for') {
    const v = one(args[0], st, ctx)
    if (!v) return
    const vals = one(args[1], st, ctx) === 'in' ? args.slice(2).map(w => expand(w, st, ctx)) : [null]
    st.vars.set(v, vals.some(x => x === null) ? null : vals.flat() as string[])
    return
  }
  if (name === 'cd' || name === 'pushd') {
    const rest = skipOpts(args, st, ctx, new Set())
    const to = rest.length ? one(rest[0], st, ctx) : ctx.home
    const next = to === null || to === '-' ? null : resolveAll(to, st.cwds, ctx, false)
    // Ohne `&&` läuft der Rest auch, wenn der `cd` scheitert: beide Ordner bleiben möglich.
    st.cwds = cmd.after === '&&' || next === null || st.cwds === null ? next : [...new Set([...st.cwds, ...next])]
    return
  }
  if (name === 'tee') return teeCmd(args, st, run)
  if (name === 'cp' || name === 'mv' || name === 'install') return copyCmd(name, args, st, run)
  if (name === 'eval') {
    const parts = args.map(w => one(w, st, ctx))
    return parts.some(p => p === null) ? void run.out.push({ kind: 'computed', hint: args.map(w => w.raw).join(' '), via: 'eval' }) : analyzeIn(parts.join(' '), st, run)
  }
  if (SHELLS.has(name)) return shellCmd(name, cmd, args, st, run)
  if (name === 'powershell' || name === 'pwsh' || name === 'cmd') return nested(name, args, st, run)
  const flags = interpreterFlags(name)
  if (flags) return interpCmd(name, flags, cmd, args, st, run)
  if (name === 'deno' && one(args[0], st, ctx) === 'eval') {
    const code = one(args[1], st, ctx)
    if (code !== null) inlineCode(code, st.cwds, ctx, run.out, 'deno eval')
  }
}

const PIPES = new Set(['|', '|&'])

function analyzeIn(src: string, st: State, run: Run): void {
  if (run.depth >= MAX_DEPTH) return
  const inner = { ...run, depth: run.depth + 1 }
  // `( … )`, Pipeline-Glieder und `&` laufen in einer eigenen Shell: ein `cd`
  // oder eine Zuweisung darin gilt nicht für die Befehle danach.
  const saved: State[] = []
  let before = ';'
  for (const cmd of parse(lex(src))) {
    while (saved.length < cmd.sub) saved.push(copy(st))
    while (saved.length > cmd.sub) Object.assign(st, saved.pop())
    const own = PIPES.has(cmd.after) || PIPES.has(before) || cmd.after === '&'
    runCmd(cmd, own ? copy(st) : st, inner)
    before = cmd.after
  }
  while (saved.length) Object.assign(st, saved.pop())
}

lang.bash = (src, cwds, run) => analyzeIn(src, { cwds, vars: new Map() }, run)
