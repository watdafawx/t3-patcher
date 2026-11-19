# @t3p/installer

The `t3p` command line installer for T3 Patcher, a plugin loader for the T3 Code desktop app (Windows).

```sh
npx @t3p/installer install       # one-off, no global install
npm i -g @t3p/installer          # or install once...
t3p install                      # ...then use `t3p`
t3p status
t3p uninstall                    # restores the stock app exactly
```

Close T3 Code before `install`, `repair` or `uninstall`. Needs Node 22 or newer. The package carries the patcher runtime, so it needs no repo checkout.

No Node? Use the single-file `t3p.exe` from the project's GitHub Releases instead.

Full command reference: the project README. Run `t3p --help` for the options.
