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

Inside a running Claude Code session this works too:

```
/plugin install delete-guard --marketplace systemNEO/claude-code-mods
```

## License

MIT
