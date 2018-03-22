# IDE-Rust
Rust language support for Atom-IDE, powered by the Rust Language Server (RLS).

![](http://image.ibb.co/gwfQTm/output.gif "Usage Jan-2018")

## Features
 - Auto-completion
 - Diagnostics (errors and warnings from `rustc` and `clippy`, see `clippy_preference` setting)
 - Document outline
 - Go to definition (`ctrl` or `cmd` click)
 - Type information and Documentation on hover (hold `ctrl` or `cmd` for more information)
 - Find references (`ctrl-alt-shift-f` or `cmd-opt-shift-f` also in context menu)
 - Format file with rustfmt (`ctrl-shift-c` or `cmd-shift-c` also in context menu)
 - Format on save (disabled by default, see `atom-ide-ui` settings)
 - Rls toolchain selection in package settings
 - Rls toolchain update checking at startup & every 6 hours thereafter
 - Global Rls configuration for `all_targets`, `clippy_preference`
 - Per-project Rls configuration using `rls.toml` file at project root, see [rls#configuration](https://github.com/rust-lang-nursery/rls#configuration)
   ```toml
   # rls.toml
   features = ["serde"]
   ```
 - Graceful handling of Rls being missing from the distribution _(which is/was somewhat common on the nightly channel)_
   * Warns before installing a rust version without Rls or when using an already installed one
   * Automatic detection of, and prompt to install, the latest working dated release

## Install
You can install from the command line with:
```
$ apm install ide-rust
```
Or you can install from Settings view by searching for `ide-rust`.

No other packages or manual setup is required as these will be handled with user prompts after install. However, you may wish to install `rustup` with your OS package manager instead of following prompts to install via [rustup.rs](https://rustup.rs).

## Commands
- `ide-rust:restart-all-language-servers` Restart all currently active Rls processes

## Multi-crate projects
A root `Cargo.toml` is required in each atom project, however cargo workspaces can be used to support multiple crates in a single project.
For example, a project with *'rust_foo'* & *'rust_bar'* directories/crates could have the following root `Cargo.toml`
```toml
# Cargo.toml
[workspace]
members = [
    "rust_foo",
    "rust_bar",
]
```

## Overriding Rls
The Rls command can be specified manually, for example to run from local source code:
```cson
# config.cson
  ...
  "ide-rust":
    rlsCommandOverride: "cargo +nightly run --manifest-path=/rls-src/Cargo.toml"
```
When set you'll be able to see, and remove, this from the package settings. After restarting atom an info message will inform you the override is in place.

![](https://image.ibb.co/jsR65w/rls_Command_Override_Info.png)

## Debugging IDE-Rust
If stuff isn't working you can try **enabling logging** to debug:
  * Open the atom console _(ctrl-shift-i)_
  * Enter `atom.config.set('core.debugLSP', true)`
  * Reload atom _(ctrl-shift-F5)_

This will spit out language server message logging into the atom console. Check if requests/responses are being sent or are incorrect. It will also include any Rls stderr messages (as warnings) which may point to Rls bugs.

## License
MIT License. See the [license](LICENSE) for more details.
