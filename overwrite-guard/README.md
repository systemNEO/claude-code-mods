# overwrite-guard

A Claude Code mod: **Claude may not rewrite a whole existing file.** It changes
files with Edit instead, where you see the diff.

## What this does

When an AI model writes a long file from scratch, it tends to change things
nobody asked it to touch: a condition flipped, a branch dropped, a default
value "tidied up". The file still looks right, and the change slips through.
Edit changes only the lines it names and shows them as a diff.

overwrite-guard refuses the calls that replace a whole existing file:

- **Write** on a file that already exists.
- **Shell commands** (Bash, PowerShell, Monitor) that replace an existing file
  with a protected extension: `cat > file`, `echo x > file`, `>|`, `&>`,
  `tee file` (without `-a`), `cp`/`mv`/`install` onto an existing file (also
  into a folder that already holds a file of that name), and code handed to an
  interpreter that writes a file (`python3 -c "open('f', 'w')…"`,
  `Path('f').write_text(…)`, `node -e "fs.writeFileSync('f', …)"`, the same in a
  heredoc `python3 <<'PY'`), plus PowerShell's `Set-Content`, `Out-File`,
  `Copy-Item`, `Move-Item`, `New-Item -Force`, `[IO.File]::WriteAllText` and
  `cmd /c` with `>`, `copy` or `move`.

Claude gets a refusal that explains why and what to do instead: use Edit,
several Edits for several places, or, if the whole file really has to be
replaced, one big Edit whose `old_string` is the current content. Deleting the
file and creating it again to get round the block is named as forbidden too.

Still allowed: creating new files, appending (`>>`, `tee -a`, `Add-Content`,
`Out-File -Append`), and anything in the [free folders](#configuration)
(`/tmp`, plan files, the scratchpad, `node_modules`, `vendor` by default).

(The refusal text is in German.)

## Installation

On any machine (Linux, macOS, Windows), in a terminal:

```bash
claude plugin marketplace add systemNEO/claude-code-mods
claude plugin install overwrite-guard@claude-code-mods
```

The first line adds this repository as a marketplace, the second installs the
mod for your user, i.e. for all projects and sessions on that machine. The mod
runs inside Claude Code itself and needs neither Node nor Python.

Alternatively, inside a running Claude Code session:

```
/plugin install overwrite-guard --marketplace systemNEO/claude-code-mods
```

Sessions that are already running pick it up with `/reload-plugins`.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `protectedExtensions` | `md, ts, tsx, js, jsx, mjs, cjs, php, json, yaml, yml, sh, bash, html, css, scss, py, sql, env, conf, caddy, toml` | Extensions (without the dot) of the files a **shell command** may not replace. `*` protects every file. `.log` files are never protected. Write is refused on every existing file, whatever its extension. |
| `freeFolders` | `/tmp, ~/.claude/plans, scratchpad, node_modules, vendor` | Folders in which files may be rewritten freely, by Write and by the shell. An absolute path or `~/…` frees everything below it; a bare name (`scratchpad`, `node_modules`) frees every folder of that name, wherever it is; a relative path with a `/` is read from the project folder. Setting the option replaces the whole list. |
| `allowedFiles` | empty | Files that may be rewritten as a whole, e.g. generated ones: `package-lock.json, docs/generated/**, **/*.snap`. `*` matches within one folder name, `**` across folders, `?` one character. A pattern without `/` matches the file name in any folder; others are read from the project folder or are absolute. |

`/dev`, `/proc` and `/sys` are always free.

Set the options in one of three ways:

- In Claude Code: `/plugin configure overwrite-guard@claude-code-mods`.
- In a terminal:

  ```bash
  echo '{"allowedFiles": "package-lock.json, dist/**"}' | claude plugin configure overwrite-guard@claude-code-mods --values-stdin
  ```

  Options left out keep their values.
- In `~/.claude/settings.json`:

  ```json
  "pluginConfigs": {
    "overwrite-guard@claude-code-mods": { "options": { "protectedExtensions": "ts, json, md" } }
  }
  ```

The setting is global: it applies to every session in that environment
(running sessions after `/reload-plugins`).

## Rules

| Situation | What happens |
| --- | --- |
| Write on an existing file | Refused. |
| Write on a new file | Runs. |
| Write in a free folder or on an allowed file | Runs. |
| A shell command replaces an existing file with a protected extension | Refused, listing every such file. |
| The same, but the file is new, unprotected (`notes.txt`, `build.log`), in a free folder or allowed | Runs. |
| Appending (`>>`, `tee -a`, `Add-Content`, `Out-File -Append`) | Runs. |
| `cp -n` / `mv -n` / `--no-clobber` | Runs: they never replace a file. |
| `cp a.ts src/` and `src/a.ts` exists | Refused. With a wildcard (`cp new/*.ts src/`) the source folder is listed and only names present on both sides count. |
| Quoted text that only mentions `>`, `tee` or `cp` (`echo "use > here"`, `git commit -m "…"`), heredocs to `cat` or `git` | Runs: only real redirections and commands count. |
| A heredoc or herestring to a shell or interpreter (`bash <<EOF`, `python3 <<'PY'`) | Its contents are checked like a command. |
| Relative paths | Measured from the session's working folder, and from a folder the command moves to first (`cd src && …`). After a `cd` that may fail (`cd src; …`), both folders count. A `cd` in a subshell (`( cd x )`) ends there. |
| Variables set in the command (`D=src; echo > "$D/app.ts"`), `$HOME`, `~`, `$CLAUDE_PROJECT_DIR`, `for f in a b` | Resolved. |
| A path that is only known when the command runs (`> "$OUT.json"` with `OUT` from outside, `for f in src/*.ts; do … > "$f"`, `Path(name).write_text(…)`) | Refused if the text names a protected extension and no free folder (the same rule as the project hook this mod replaces); otherwise runs. |
| Subagents | Same rules. |
| Other tools (Edit, Read, MCP tools) | Untouched. |

## When the check itself fails

**It lets the call through and writes a line to the transcript**
(`overwrite-guard: Prüfung fehlgeschlagen (…); Bash durchgelassen.`).

This is deliberate. The guard is a net against a habit, not a security
boundary: a bug in the command parser that refused every Write and every shell
command would stop all work in the session. The original shell hook made the
same choice ("ohne Suchmodul lieber durchlassen als alles sperren"). Each hook
has a `.catch` handler that runs the call and logs the failure.

## Notes / limitations

- It reads the command text, not what the command does when it runs. A script
  file (`python3 gen.py`, `./build.sh`, `npm run gen`), a compiled program or a
  Git operation (`git checkout -- file`, `git restore`) that rewrites a file is
  not seen.
- Only the listed commands and write calls count. `dd of=`, `curl -o`,
  `wget -O`, `rsync`, `sed -i`, `truncate`, `ln -sf`, `shutil.copy`,
  `fs.copyFileSync` and the like are not held.
- Inline code is checked by patterns, not executed: deliberately obfuscated
  code slips through, and code that writes to a computed path while mentioning
  a protected extension is refused even when the file would be new.
- `cp -r dir1 dir2` (recursive copies) and wildcards in folder names
  (`cp src/*/a.ts dest/`) are not followed into the folders.
- PowerShell is a subset: script blocks and loops are read as plain
  statements, paths built with `Join-Path` or `$(…)` are not seen.
- "Delete, then write" cannot be detected; the refusal only says it is
  forbidden.
- Hard links and symlinks are not resolved for the free-folder check: a path
  counts by how it is written.
- This is a safety net, not a permission system. Use permission deny rules
  for a hard block, and version control for what matters.

## How it works

- Two `tool.call` hooks, one on Write and one on Bash, PowerShell and Monitor.
  They run before the tool, in every permission mode and for subagents; a
  refusal reaches Claude as the tool's error result.
- `$.session.cwd()` and `$.session.root()` give the working and the project
  folder, `$.fs.stat` says whether a file exists, `$.fs.list` reads the source
  folder of a wildcard copy.
- The Bash parser (`hooks/bash.ts`) is adapted from
  [delete-guard](../delete-guard/): it splits the command into words,
  redirections, heredocs and subshells, resolves quotes, variables, `~` and
  `{a,b}`, and follows `bash -c`, `eval`, `sudo`/`env`/`timeout` and
  `pwsh -Command`/`cmd /c`. `hooks/ps.ts` reads PowerShell and cmd. Both are
  pure functions without `$`.
- About 90 cases in `tests/`. Nothing in the tests is executed; a small fake
  file system stands beneath the mod.

## Development

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
