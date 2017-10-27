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

## Install

You can install from the command line with:

```
$ apm install ide-rust
```

Or you can install from Settings view by searching for `ide-rust`.

## License

MIT License. See the [license](LICENSE) for more details.
