# IDE-Rust
Rust language support for Atom-IDE, powered by the Rust Language Server (RLS).

## Features
 - Auto-completion
 - Format on save (disabled by default, see `atom-ide-ui` settings)
 - Diagnostics (errors and warnings from `rustc`, support for `clippy` is pending on https://github.com/rust-lang-nursery/rls/issues/149)
 - Document outline
 - Go to definition (`ctrl` or `cmd` click)
 - Type information and Documentation on hover (hold `ctrl` or `cmd` for more information)
 - Rls toolchain selection in package settings
 - Rls configuration using `rls.toml` file at project root, see [rls#configuration](https://github.com/rust-lang-nursery/rls#configuration)
   ```toml
   # rls.toml
   features = ["serde"]
   ```

## Install

You can install from the command line with:

```
$ apm install ide-rust
```

Or you can install from Settings view by searching for `ide-rust`.


## Overriding Rls
The Rls command can be specified manually, for example to run from local source code:
```cson
# config.cson
  ...
  "ide-rust":
    rlsCommandOverride: "rustup run nightly cargo run --manifest-path=/rls-src/Cargo.toml --release"
```
When set you'll be able to see, and remove, this from the package settings. After restarting atom an info message will inform you the override is in place.

![](https://image.ibb.co/jsR65w/rls_Command_Override_Info.png)

## Debugging
If stuff isn't working you can try **enabling logging** to debug:
  * Open the atom console _(ctrl-shift-i)_
  * Enter `atom.config.set('core.debugLSP', true)`
  * Reload atom _(ctrl-shift-F5)_

This will spit out language server message logging into the atom console. Check if requests/responses are being sent or are incorrect. It will also include any Rls stderr messages (as warnings) which may point to Rls bugs.

## License

MIT License. See the [license](LICENSE) for more details.
