// PowerShell und cmd.exe (Windows, oder aus WSL/Git Bash heraus aufgerufen).
// Remove-Item und seine Aliase, .Delete()-Aufrufe, del/erase/rd/rmdir,
// Pipelines (gci … | Remove-Item, ForEach-Object { Remove-Item $_ }),
// verschachtelte Aufrufe (cmd /c, powershell -Command / -EncodedCommand, wsl).

import { type Mode, type Out, type Run, type State, type Val, absolute, addTarget, fork, lang } from './common'

type Part =
  | { t: 'lit'; v: string; q: boolean }
  | { t: 'var'; name: string; prop: boolean }
  | { t: 'sub'; src: string }
  | { t: 'dyn' }

type Word = { parts: Part[]; raw: string }
type Item = { k: 'w'; w: Word } | { k: 'op'; op: string }
type Stmt = { items: Item[]; prev: Stmt | null; depth: number; raw: string }

/** Index hinter der passenden schließenden Klammer zu `s[i]`. */
function balanced(s: string, i: number): number {
  const open = s[i] ?? '('
  const close = open === '(' ? ')' : open === '{' ? '}' : ']'
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === '`') { j++; continue }
    if (c === "'") { for (j++; j < s.length && !(s[j] === "'" && s[j + 1] !== "'"); j++) if (s[j] === "'") j++; continue }
    if (c === '"') { for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === '`') j++; continue }
    if (c === open) depth++
    else if (c === close && --depth === 0) return j + 1
  }
  return s.length
}

function lex(s: string): { items: Item[]; spans: [number, number][] } {
  const items: Item[] = []
  const spans: [number, number][] = []
  let parts: Part[] = []
  let start = 0
  let inWord = false
  const lit = (v: string, q: boolean) => {
    const last = parts[parts.length - 1]
    if (last && last.t === 'lit' && last.q === q) last.v += v
    else parts.push({ t: 'lit', v, q })
  }
  const begin = (i: number) => { if (!inWord) { start = i; inWord = true } }
  const end = (at: number) => {
    if (inWord) { items.push({ k: 'w', w: { parts, raw: s.slice(start, at) } }); spans.push([start, at]) }
    parts = []
    inWord = false
  }
  const op = (o: string, at: number) => { items.push({ k: 'op', op: o }); spans.push([at, at + o.length]) }

  const variable = (i: number, quoted: boolean): number => {
    if (s[i + 1] === '(') { const e = balanced(s, i + 1); parts.push({ t: 'sub', src: s.slice(i + 2, e - 1) }); return e }
    if (s[i + 1] === '{') { const e = s.indexOf('}', i); parts.push({ t: 'var', name: s.slice(i + 2, e < 0 ? s.length : e).toLowerCase(), prop: false }); return e < 0 ? s.length : e + 1 }
    const m = /^(?:(?:env|script|global|local|private|using):)?[A-Za-z_][\w]*|^[_?$^]/i.exec(s.slice(i + 1))
    if (!m) { lit('$', quoted); return i + 1 }
    let j = i + 1 + m[0].length
    let prop = false
    if (!quoted) {
      while (/^\.[A-Za-z_]\w*/.test(s.slice(j)) || s[j] === '[') {
        prop = true
        j = s[j] === '[' ? balanced(s, j) : j + (/^\.[A-Za-z_]\w*/.exec(s.slice(j))?.[0].length ?? 1)
      }
    }
    parts.push(prop && !/^(_|psitem)$/i.test(m[0]) ? { t: 'dyn' } : { t: 'var', name: m[0].toLowerCase(), prop })
    return j
  }

  let i = 0
  while (i < s.length) {
    const c = s[i] ?? ''
    if (c === '\n' || c === ';') { end(i); op(';', i); i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { end(i); i++; continue }
    if (c === '`') {
      if (s[i + 1] === '\n' || s[i + 1] === '\r') { i += s[i + 1] === '\r' ? 3 : 2; continue }
      begin(i); lit(s[i + 1] ?? '', true); i += 2; continue
    }
    if (c === '<' && s[i + 1] === '#') { end(i); const e = s.indexOf('#>', i); i = e < 0 ? s.length : e + 2; continue }
    if (c === '#' && !inWord) { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '@' && (s[i + 1] === '"' || s[i + 1] === "'") && /^\r?\n/.test(s.slice(i + 2))) {
      begin(i)
      const q = s[i + 1]
      const e = s.indexOf(`\n${q}@`, i + 2)
      lit(s.slice(s.indexOf('\n', i) + 1, e < 0 ? s.length : e), true)
      i = e < 0 ? s.length : e + 3
      continue
    }
    if (c === "'") {
      begin(i)
      let j = i + 1
      let v = ''
      for (; j < s.length; j++) {
        if (s[j] === "'") { if (s[j + 1] === "'") { v += "'"; j++; continue } break }
        v += s[j]
      }
      lit(v, true)
      i = j + 1
      continue
    }
    if (c === '"') {
      begin(i)
      lit('', true)
      let j = i + 1
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '`') { lit(s[j + 1] ?? '', true); j += 2 }
        else if (s[j] === '$') j = variable(j, true)
        else { lit(s[j] ?? '', true); j++ }
      }
      i = j + 1
      continue
    }
    if (c === '$') { begin(i); i = variable(i, false); continue }
    if (c === '(' || (c === '@' && s[i + 1] === '(')) {
      begin(i)
      const at = c === '@' ? i + 1 : i
      const e = balanced(s, at)
      parts.push({ t: 'sub', src: s.slice(at + 1, e - 1) })
      i = e
      continue
    }
    if (c === '@' && s[i + 1] === '{') { begin(i); const e = balanced(s, i + 1); parts.push({ t: 'dyn' }); i = e; continue }
    if (c === '{' || c === '}') { end(i); op(c, i); i++; continue }
    if (c === '|') { end(i); const o = s[i + 1] === '|' ? '||' : '|'; op(o, i); i += o.length; continue }
    if (c === '&') { end(i); const o = s[i + 1] === '&' ? '&&' : '&'; op(o, i); i += o.length; continue }
    if (c === ',') { end(i); op(',', i); i++; continue }
    if (c === '=' && (!inWord || (parts.length === 1 && parts[0]?.t === 'var')) && s[i + 1] !== '=') { end(i); op('=', i); i++; continue }
    if (c === '>' || (/\d|\*/.test(c) && s[i + 1] === '>' && !inWord)) {
      end(i)
      const m = /^[\d*]?>>?(&\d)?/.exec(s.slice(i))
      op('>', i)
      i += m?.[0].length ?? 1
      continue
    }
    begin(i)
    lit(c, false)
    i++
  }
  end(s.length)
  return { items, spans }
}

function statements(src: string): Stmt[] {
  const { items, spans } = lex(src)
  const out: Stmt[] = []
  let depth = 0
  let cur: Item[] = []
  let first = -1
  let last = -1
  let prev: Stmt | null = null
  const flush = (pipe: boolean) => {
    let stmt: Stmt | null = null
    if (cur.length) {
      stmt = { items: cur, prev, depth, raw: src.slice(spans[first]?.[0] ?? 0, spans[last]?.[1] ?? 0) }
      out.push(stmt)
    }
    prev = pipe ? stmt : null
    cur = []
    first = -1
  }
  items.forEach((it, i) => {
    if (it.k === 'op' && [';', '|', '||', '&&', '&', '{', '}'].includes(it.op)) {
      if (it.op === '&' && cur.length === 0) return // Aufrufoperator `& cmd`
      flush(it.op === '|')
      if (it.op === '{') depth++
      if (it.op === '}') depth = Math.max(0, depth - 1)
      return
    }
    if (it.k === 'op' && it.op === '>') { cur.push(it); return }
    if (first < 0) first = i
    last = i
    cur.push(it)
  })
  flush(false)
  return out
}

// ---------------------------------------------------------------- Auswertung

/** Kopie des Zustands, in der Variablen ohne Groß/Klein-Unterschied gelten. */
function lookup(name: string, st: State, run: Run): Val[] | null {
  const { ctx } = run
  if (name === '_' || name === 'psitem') {
    if (!st.pipe) return null
    return st.pipe.map(t => ({ s: t.mode === 'children' ? `${t.path}/*` : t.path, glob: t.mode === 'children' }))
  }
  if (name.startsWith('env:')) {
    const v = ctx.env(name.slice(4))
    return v === undefined ? null : [{ s: v, glob: false }]
  }
  const n = name.replace(/^(script|global|local|private|using):/, '')
  if (st.vars.has(`ps:${n}`)) return st.vars.get(`ps:${n}`) ?? null
  if (n === 'home') return ctx.home ? [{ s: ctx.home, glob: false }] : null
  if (n === 'pwd') return st.cwd ? [{ s: st.cwd, glob: false }] : null
  if (n === 'true' || n === 'false' || n === 'null') return [{ s: '', glob: false }]
  return null
}

function expand(w: Word, st: State, run: Run): Val[] | null {
  let acc: Val[] = [{ s: '', glob: false }]
  const join = (alts: Val[]) => { acc = acc.flatMap(a => alts.map(b => ({ s: a.s + b.s, glob: a.glob || b.glob }))).slice(0, 64) }
  for (const p of w.parts) {
    if (p.t === 'lit') {
      let v = p.v
      if (!p.q && acc.length === 1 && acc[0]?.s === '' && (v === '~' || v.startsWith('~/') || v.startsWith('~\\'))) {
        if (!run.ctx.home) return null
        v = run.ctx.home + v.slice(1)
      }
      join([{ s: v, glob: /[*?[]/.test(v) }])
    } else if (p.t === 'var') {
      const v = lookup(p.name, st, run)
      if (!v) return null
      join(v)
    } else if (p.t === 'sub') {
      const v = evalSub(p.src, st, run)
      if (!v) return null
      join(v)
    } else return null
  }
  return acc
}

/** Join-Path, Get-Location/pwd, Resolve-Path X; sonst unbekannt. */
function evalSub(src: string, st: State, run: Run): Val[] | null {
  const stmts = statements(src)
  if (stmts.length !== 1) return null
  const words = (stmts[0]?.items ?? []).filter((x): x is { k: 'w'; w: Word } => x.k === 'w').map(x => x.w)
  const name = cmdName(words[0], st, run)
  if (name === 'get-location' || name === 'pwd' || name === 'gl') return st.cwd ? [{ s: st.cwd, glob: false }] : null
  if (name === 'join-path') {
    const vals = words.slice(1).filter(w => !w.raw.startsWith('-')).map(w => expand(w, st, run))
    if (vals.length < 2 || vals.some(v => v === null || v.length !== 1)) return null
    const [a, b] = vals.map(v => v?.[0]) as Val[]
    return a && b ? [{ s: `${a.s.replace(/[\\/]$/, '')}/${b.s}`, glob: a.glob || b.glob }] : null
  }
  if (name === 'resolve-path' || name === 'rvpa' || name === 'get-item' || name === 'gi' || name === 'convert-path') {
    const p = words.slice(1).find(w => !w.raw.startsWith('-'))
    return p ? expand(p, st, run) : null
  }
  return null
}

function cmdName(w: Word | undefined, st: State, run: Run): string | null {
  if (!w) return null
  const v = expand(w, st, run)
  if (!v || v.length !== 1) return null
  return (v[0]?.s ?? '').replace(/^.*\\(?=[^\\]+$)/, '').replace(/^.*\//, '').replace(/\.exe$/i, '').toLowerCase()
}

const REMOVE = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir', 'remove-itemproperty', 'rp'])
const LISTERS = new Set(['get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi', 'resolve-path', 'rvpa'])
const FILTERS = new Set(['where-object', 'where', '?', 'sort-object', 'sort', 'select-object', 'select', 'tee-object', 'tee'])
const VALUED = ['filter', 'include', 'exclude', 'credential', 'stream', 'erroraction', 'ea', 'warningaction', 'wa', 'informationaction', 'infa', 'errorvariable', 'ev', 'outvariable', 'ov', 'outbuffer', 'ob', 'pipelinevariable', 'pv', 'progressaction', 'proga', 'depth', 'attributes', 'name']

type Params = { paths: { w: Word; literal: boolean }[]; positional: Word[][] }

/** Parameter eines Cmdlets: -Path/-LiteralPath (auch abgekürzt, auch `a,b`) und freie Argumente. */
function params(items: Item[]): Params {
  const out: Params = { paths: [], positional: [] }
  const take = (i: number): [Word[], number] => {
    const ws: Word[] = []
    let j = i
    while (j < items.length) {
      const it = items[j]
      if (it?.k !== 'w') break
      ws.push(it.w)
      if (items[j + 1]?.k === 'op' && (items[j + 1] as { op: string }).op === ',') j += 2
      else { j++; break }
    }
    return [ws, j]
  }
  let i = 1
  while (i < items.length) {
    const it = items[i]
    if (!it || it.k === 'op') { i += it?.k === 'op' && it.op === '>' ? 2 : 1; continue }
    const raw = it.w.raw
    const pm = /^-([A-Za-z]+)(?::(.*))?$/.exec(raw)
    if (pm && it.w.parts[0]?.t === 'lit' && !(it.w.parts[0] as { q: boolean }).q) {
      const n = (pm[1] ?? '').toLowerCase()
      const isLit = n === 'lp' || (n.length >= 2 && 'literalpath'.startsWith(n)) || n === 'pspath'
      const isPath = !isLit && n.length >= 1 && 'path'.startsWith(n)
      if (isLit || isPath) {
        if (pm[2] !== undefined) { out.paths.push({ w: { raw: pm[2], parts: [{ t: 'lit', v: pm[2], q: false }] }, literal: isLit }); i++; continue }
        const [ws, j] = take(i + 1)
        ws.forEach(w => out.paths.push({ w, literal: isLit }))
        i = j
        continue
      }
      if (pm[2] === undefined && VALUED.some(v => v === n || (n.length >= 3 && v.startsWith(n)))) i += 2
      else i++
      continue
    }
    if (/^\/[A-Za-z]$/.test(raw)) { i++; continue } // cmd-Schalter (/s /q) in PowerShell
    const [ws, j] = take(i)
    out.positional.push(ws)
    i = j
  }
  return out
}

function pathsOf(p: Params): { w: Word; literal: boolean }[] {
  return p.paths.length ? p.paths : (p.positional[0] ?? []).map(w => ({ w, literal: false }))
}

/** Beim Löschen lieber alles: -Path, -LiteralPath und jedes freie Argument. */
function allPaths(p: Params): { w: Word; literal: boolean }[] {
  return [...p.paths, ...p.positional.flat().map(w => ({ w, literal: false }))]
}

function addWords(list: { w: Word; literal: boolean }[], st: State, run: Run, via: string, mode: Mode): void {
  for (const { w, literal } of list) {
    const vals = expand(w, st, run)
    if (!vals) { run.out.unknowns.push(`${via}: ${w.raw} (nicht auflösbar)`); continue }
    for (const v of vals) {
      if (v.s.startsWith('/') && run.ctx.win === false && /^\/[A-Za-z]$/.test(v.s)) continue
      addTarget(run.out, literal ? { s: v.s, glob: false } : v, st, run.ctx, via, mode, true, true)
    }
  }
}

/** Was eine Pipeline in Remove-Item oder ForEach-Object hineinreicht. */
function producer(stmt: Stmt | null, st: State, run: Run): Out['targets'] | null {
  if (!stmt) return null
  const words = stmt.items.filter((x): x is { k: 'w'; w: Word } => x.k === 'w').map(x => x.w)
  const name = cmdName(words[0], st, run)
  if (name === null) return null
  if (FILTERS.has(name)) return producer(stmt.prev, st, run)
  if (!LISTERS.has(name)) return null
  const o: Out = { targets: [], unknowns: [], scripts: [] }
  const list = pathsOf(params(stmt.items))
  const children = !['get-item', 'gi', 'resolve-path', 'rvpa'].includes(name)
  if (!list.length) addTarget(o, { s: '.', glob: false }, st, run.ctx, name, children ? 'children' : 'deep', true)
  addWords(list, st, { ...run, out: o }, name, children ? 'children' : 'deep')
  if (children) o.targets = o.targets.map(t => ({ ...t, mode: 'children' }))
  return o.unknowns.length ? null : o.targets
}

const DELETE_METHOD = /(?:::|\.)\s*Delete(?:File|Directory)?\s*\(|::\s*DeleteFile|::\s*DeleteDirectory/i

function runStmt(stmt: Stmt, st: State, run: Run): void {
  const { ctx, out } = run
  const items = stmt.items
  const words = items.filter((x): x is { k: 'w'; w: Word } => x.k === 'w').map(x => x.w)
  for (const w of words) for (const p of w.parts) if (p.t === 'sub') analyzePsIn(p.src, fork(st), run)

  // $x = 'C:\foo'
  const w0 = words[0]
  if (w0 && w0.parts.length === 1 && w0.parts[0]?.t === 'var' && items[1]?.k === 'op' && items[1].op === '=') {
    const name = (w0.parts[0] as { name: string }).name
    const rhs = items.slice(2)
    const val = rhs.length === 1 && rhs[0]?.k === 'w' ? expand(rhs[0].w, st, run) : null
    if (name.startsWith('env:')) return
    st.vars.set(`ps:${name.replace(/^(script|global|local|private):/, '')}`, val)
    // Die rechte Seite kann selbst ein Befehl sein ($x = Remove-Item …).
    if (rhs.length > 1) runStmt({ ...stmt, items: rhs }, st, run)
    return
  }

  if (DELETE_METHOD.test(stmt.raw)) {
    const before = out.targets.length + out.unknowns.length
    for (const m of stmt.raw.matchAll(/'((?:[^']|'')*)'|"([^"$`]*)"/g)) {
      const s = (m[1] ?? m[2] ?? '').replace(/''/g, "'")
      if (s && !/^(System|IO)\b/.test(s)) addTarget(out, { s, glob: false }, st, ctx, '.Delete()', 'deep', true)
    }
    for (const m of stmt.raw.matchAll(/\$([A-Za-z_]\w*)/g)) {
      const n = (m[1] ?? '').toLowerCase()
      if (n === 'true' || n === 'false') continue
      const v = lookup(n, st, run)
      if (!v) out.unknowns.push(`.Delete(): $${m[1]} nicht auflösbar`)
      else for (const x of v) addTarget(out, x, st, ctx, '.Delete()', 'deep', true)
    }
    for (const w of words)
      for (const part of w.parts)
        if (part.t === 'sub') for (const x of evalSub(part.src, st, run) ?? []) addTarget(out, x, st, ctx, '.Delete()', 'deep', true)
    if (out.targets.length + out.unknowns.length === before) out.unknowns.push(`.Delete() ohne erkennbares Ziel: ${stmt.raw.slice(0, 80)}`)
  }

  const name = cmdName(w0, st, run)
  if (name === null) {
    if (w0 && /rm|del|remove|erase/i.test(w0.raw) && !DELETE_METHOD.test(stmt.raw)) out.unknowns.push(`Befehl nicht auflösbar: ${w0.raw}`)
    return
  }
  const p = () => params(items)

  if (REMOVE.has(name)) {
    const list = allPaths(p())
    const reg = name === 'remove-itemproperty' || name === 'rp'
    if (list.length) addWords(list, st, run, name, reg ? 'exact' : 'deep')
    else if (stmt.prev) {
      const src = producer(stmt.prev, st, run)
      if (src) out.targets.push(...src.map(t => ({ ...t, via: name })))
      else out.unknowns.push(`${name}: Eingabe aus der Pipeline nicht bestimmbar`)
    } else if (!reg) out.unknowns.push(`${name} ohne Pfad`)
    return
  }
  if (name === 'clear-recyclebin') return void out.unknowns.push('Clear-RecycleBin leert den Papierkorb')
  if (name === 'foreach-object' || name === '%' || name === 'foreach' || name === 'where-object' || name === '?') {
    if (stmt.prev) st.pipe = producer(stmt.prev, st, run)
    return
  }
  if (name === 'set-location' || name === 'sl' || name === 'cd' || name === 'chdir' || name === 'push-location' || name === 'pushd') {
    const list = pathsOf(p())
    if (name === 'push-location' || name === 'pushd') st.stack.push(st.cwd)
    if (!list.length) { st.cwd = ctx.home; return }
    const v = expand(list[0]?.w ?? { raw: '', parts: [] }, st, run)
    st.cwd = v && v.length === 1 && v[0]?.s !== '-' ? absolute(v[0]?.s ?? '', st.cwd, ctx, true) : null
    return
  }
  if (name === 'pop-location' || name === 'popd') { st.cwd = st.stack.length ? (st.stack.pop() ?? null) : null; return }
  if (name === 'invoke-expression' || name === 'iex') {
    const list = pathsOf(p())
    const w = list[0]?.w
    const v = w ? expand(w, st, run) : null
    if (!v || v.length !== 1) return void out.unknowns.push('Invoke-Expression mit unbekanntem Inhalt')
    return analyzePsIn(v[0]?.s ?? '', fork(st), run)
  }
  if (name === 'cmd' || name === 'powershell' || name === 'pwsh' || name === 'wsl' || name === 'bash' || name === 'sh') {
    const vals = words.slice(1).map(w => { const v = expand(w, st, run); return v && v.length === 1 ? (v[0]?.s ?? null) : null })
    if (name === 'wsl' || name === 'bash' || name === 'sh') {
      if (vals.some(v => v === null)) return void out.unknowns.push(`${name}: Befehl nicht auflösbar`)
      const quoted = vals.map(v => `'${(v ?? '').replace(/'/g, `'\\''`)}'`).join(' ')
      return lang.bash(name === 'wsl' ? `wsl ${quoted}` : `${name} ${quoted}`, fork(st), run)
    }
    return lang.nested(name, vals, st, run)
  }
  // .\skript.ps1, & 'C:\x\y.ps1', . .\z.ps1
  const head = w0 ? expand(w0, st, run)?.[0]?.s : undefined
  const target = head === '.' ? (words[1] ? expand(words[1], st, run)?.[0]?.s : undefined) : head
  if (target && /\.(ps1|cmd|bat)$/i.test(target)) {
    const abs = absolute(target, st.cwd, ctx, true)
    if (abs) out.scripts.push({ path: abs, lang: /\.ps1$/i.test(abs) ? 'ps' : 'cmd' })
  }
}

export function analyzePsIn(src: string, st: State, run: Run): void {
  if (run.depth >= 6) return void run.out.unknowns.push('zu tief verschachtelt')
  const inner = { ...run, depth: run.depth + 1 }
  let pipeDepth = -1
  for (const stmt of statements(src)) {
    if (pipeDepth >= 0 && stmt.depth <= pipeDepth) { st.pipe = undefined; pipeDepth = -1 }
    const before = st.pipe
    runStmt(stmt, st, inner)
    if (st.pipe !== before && st.pipe !== undefined) pipeDepth = stmt.depth
  }
}


// ---------------------------------------------------------------- cmd.exe

export function analyzeCmd(src: string, st: State, run: Run): void {
  const { ctx, out } = run
  if (run.depth >= 6) return void out.unknowns.push('zu tief verschachtelt')
  const inner = { ...run, depth: run.depth + 1 }
  // %VAR% auflösen; %%i / %~dp0 und Unbekanntes bleiben als Marker stehen.
  const unknown = '\u0000'
  const text = src.replace(/%([A-Za-z_][\w()]*)%/g, (_, n: string) => {
    if (n.toUpperCase() === 'CD') return st.cwd ?? unknown
    return ctx.env(n) ?? unknown
  }).replace(/%%?~?[A-Za-z0-9]+/g, unknown)

  const stmts: string[][] = []
  let cur: string[] = []
  let word = ''
  let inWord = false
  let quoted = false
  const end = () => { if (inWord) cur.push(word); word = ''; inWord = false }
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? ''
    if (c === '"') { quoted = !quoted; inWord = true; continue }
    if (!quoted && c === '^') { word += text[++i] ?? ''; inWord = true; continue }
    if (!quoted && (c === '&' || c === '|' || c === '\n' || c === '(' || c === ')')) {
      end()
      if (cur.length) stmts.push(cur)
      cur = []
      if (text[i + 1] === c) i++
      continue
    }
    if (!quoted && (c === ' ' || c === '\t' || c === '\r')) { end(); continue }
    if (!quoted && c === '>') { end(); i++; while (text[i] === ' ' || text[i] === '>' || text[i] === '&') i++; while (i < text.length && !/\s/.test(text[i] ?? '')) i++; continue }
    word += c
    inWord = true
  }
  end()
  if (cur.length) stmts.push(cur)

  const KNOWN = new Set(['del', 'erase', 'rd', 'rmdir', 'cd', 'chdir', 'pushd', 'popd', 'powershell', 'pwsh', 'cmd', 'wsl', 'bash', 'call', 'start'])
  for (const raw of stmts) {
    const words = raw.map(w => w.trim()).filter(Boolean)
    const at = words.findIndex(w => KNOWN.has(w.toLowerCase().replace(/\.exe$/, '')) || /\.(bat|cmd|ps1)$/i.test(w))
    if (at < 0) continue
    const name = (words[at] ?? '').toLowerCase().replace(/\.exe$/, '')
    const args = words.slice(at + 1)
    const plain = args.filter(a => !/^\/[A-Za-z](:\S*)?$/.test(a))
    const add = (mode: Mode) => {
      for (const a of plain) {
        if (a.includes(unknown)) { out.unknowns.push(`${name}: ${a.replace(/\u0000/g, '%…%')} (nicht auflösbar)`); continue }
        addTarget(out, { s: a, glob: /[*?]/.test(a) }, st, ctx, name, mode, true, true)
      }
    }
    if (name === 'del' || name === 'erase') add('children')
    else if (name === 'rd' || name === 'rmdir') add('deep')
    else if (name === 'cd' || name === 'chdir' || name === 'pushd') {
      const d = plain[0]
      if (name === 'pushd') st.stack.push(st.cwd)
      if (d !== undefined) st.cwd = d.includes(unknown) ? null : absolute(d, st.cwd, ctx, true)
    } else if (name === 'popd') st.cwd = st.stack.length ? (st.stack.pop() ?? null) : null
    else if (name === 'call' || name === 'start') {
      const rest = plain.filter(a => !/^\/\w+$/.test(a))
      if (rest.length) analyzeCmd(rest.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' '), st, inner)
    } else if (/\.(bat|cmd|ps1)$/i.test(name)) {
      const abs = absolute(words[at] ?? '', st.cwd, ctx, true)
      if (abs) out.scripts.push({ path: abs, lang: /\.ps1$/i.test(abs) ? 'ps' : 'cmd' })
    } else {
      const vals = args.map(a => (a.includes(unknown) ? null : a))
      if (name === 'wsl' || name === 'bash') lang.bash(`${name} ${args.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`, fork(st), inner)
      else lang.nested(name, vals, fork(st), inner)
    }
  }
}

lang.ps = analyzePsIn
lang.cmd = analyzeCmd
