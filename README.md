# claude-code-mods

Mods for [Claude Code](https://claude.com/claude-code) by systemNEO.

| Mod | What it does |
| --- | --- |
| [delete-guard](delete-guard/) | Deleting outside the project folder requires your approval, in every permission mode and for subagents too; Bash, PowerShell, cmd, Git Bash, WSL, MCP |

## Installation

Add the marketplace and install a mod (Linux, macOS, Windows):

```bash
claude plugin marketplace add systemNEO/claude-code-mods
claude plugin install delete-guard@claude-code-mods
```

The mod is installed for your user, i.e. for all projects and sessions on the
machine. Sessions that are already running pick it up with `/reload-plugins`.
Each environment with its own Claude Code configuration (for example WSL and
native Windows on the same PC) needs its own installation; see
[where delete-guard applies](delete-guard/README.md#where-it-applies).

Inside a running Claude Code session this works too:

```
/plugin install delete-guard --marketplace systemNEO/claude-code-mods
```

To update later:

```bash
claude plugin marketplace update claude-code-mods
claude plugin update delete-guard@claude-code-mods
```

delete-guard also tells you once a day when a newer version is available. See
[Updates](delete-guard/README.md#updates) for automatic updates.

## Configuration

By default, delete-guard lets Claude delete freely inside the folder the
session was started in. To use another folder as the boundary, for example
your home folder or your projects folder, set the `boundary` option:

```bash
echo '{"boundary": "~/projects"}' | claude plugin configure delete-guard@claude-code-mods --values-stdin
```

or, inside Claude Code, `/plugin configure delete-guard@claude-code-mods`.
`claude plugin configure delete-guard@claude-code-mods` shows the current
value; `{"boundary": ""}` goes back to the start folder. The setting is
global: it is saved in `~/.claude/settings.json` and applies to every session
on the machine (running sessions after `/reload-plugins`). Details in
[delete-guard → Configuration](delete-guard/README.md#configuration).

## License

MIT
