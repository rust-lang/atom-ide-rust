# IDE-Rust

Rust language support for Atom-IDE, powered by [rust-analyzer](https://github.com/rust-analyzer/rust-analyzer).

## Features

- Auto-completion
- Diagnostics (errors and warnings from `rustc`)
- Document outline
- Go to definition (`ctrl` or `cmd` click)
- Type information and Documentation on hover (hold `ctrl` or `cmd` for more information)
- Find references (`ctrl-alt-shift-f` or `cmd-opt-shift-f` also in context menu)
- Format file with rustfmt (`ctrl-shift-c` or `cmd-shift-c` also in context menu)
- Format on save (disabled by default, see `atom-ide-ui` settings)
- Rustup toolchain update checking at startup & every 6 hours thereafter
- Supports rustup override toolchains
- Rust language snippets

## Install

Install from Settings view by searching for `ide-rust`, or with the command line:

```
$ apm install ide-rust
```

### Prerequisites

**rust-analyzer** must be installed manually, if possible on the PATH _(otherwise configure this in the package settings)_.
See https://rust-analyzer.github.io/manual.html#rust-analyzer-language-server-binary.

NOTE: On Windows, you can install it using [choco](https://chocolatey.org/install): `choco install rust-analyzer`

No other packages or manual setup is required as these will be handled with user prompts after install.
However, you may wish to install `rustup` with your OS package manager instead of following prompts to install via [rustup.rs](https://rustup.rs).

## Commands

- `ide-rust:restart-all-language-servers` Restart all currently active Rls processes

## Debugging IDE-Rust

If stuff isn't working you can try **enabling logging** to debug:

- Open the atom console _(ctrl-shift-i)_
- Enter `atom.config.set('core.debugLSP', true)`
- Reload atom _(ctrl-shift-F5)_

This will spit out language server message logging into the atom console. Check if requests/responses are being sent or are incorrect.

## RLS

RLS is no longer supported. To use RLS install a previous version of ide-rust, `apm install ide-rust@0.21.2`.

## Screenshots

**Autocomplete**:

![Autocomplete image](https://user-images.githubusercontent.com/16418197/121962919-01114c80-cd2f-11eb-8136-11ba82ebe543.png)

**Datatips**:

![Datatips image](https://user-images.githubusercontent.com/16418197/121962751-c7404600-cd2e-11eb-84dd-eff95743a0d3.png)

**Linter**:

![Linter image](https://user-images.githubusercontent.com/16418197/121962803-d7582580-cd2e-11eb-9742-040b78ca75d2.png)

**Outline**:

![Outline image](https://user-images.githubusercontent.com/16418197/121962765-cd362700-cd2e-11eb-92b2-74516cd734db.png)

## License

MIT License. See the [license](LICENSE) for more details.
