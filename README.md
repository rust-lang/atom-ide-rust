# IDE-Rust
> Rust IDE support for Atom, powered by the Rust Language Server (RLS)

## Features
 - Auto-completion
 - Format on save (disabled by default, see `atom-ide-ui` settings)
 - Diagnostics (errors and warnings from `rustc`, support for `clippy` is pending on https://github.com/rust-lang-nursery/rls/issues/149)
 - Document outline
 - Go to definition (`ctrl` or `cmd` click)
 - Type information and Documentation on hover (hold `ctrl` or `cmd` for more information)
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

## License

MIT License. See the [license](LICENSE) for more details.
