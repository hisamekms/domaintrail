//! Zed extension for DomainTrail: starts `dt lsp` for `.dt` files.
//!
//! The command is, in this order: `lsp.domaintrail.binary.path` in Zed's settings, `node_modules/.bin/dt` of the
//! worktree, `dt` on the PATH, else `npx -y domaintrail`. The arguments are `lsp` unless the settings give
//! `binary.arguments`; `binary.env` is added to the worktree's shell environment.

use zed_extension_api::{self as zed, LanguageServerId, Result, settings::LspSettings};

const SERVER: &str = "domaintrail";
const LOCAL_BIN: &str = "node_modules/.bin/dt";

struct DomainTrailExtension;

impl zed::Extension for DomainTrailExtension {
    fn new() -> Self {
        DomainTrailExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let binary = LspSettings::for_worktree(SERVER, worktree)
            .ok()
            .and_then(|s| s.binary);
        let (path, arguments, extra_env) = match binary {
            Some(b) => (b.path, b.arguments, b.env.unwrap_or_default()),
            None => (None, None, Default::default()),
        };
        let args = arguments.unwrap_or_else(|| vec!["lsp".into()]);
        let mut env = worktree.shell_env();
        env.extend(extra_env);

        let (command, args) = if let Some(path) = path {
            (path, args)
        } else if worktree.read_text_file(LOCAL_BIN).is_ok() {
            (format!("{}/{LOCAL_BIN}", worktree.root_path()), args)
        } else if let Some(dt) = worktree.which("dt") {
            (dt, args)
        } else if let Some(npx) = worktree.which("npx") {
            let npx_args = ["-y".to_string(), "domaintrail".to_string()];
            (npx, npx_args.into_iter().chain(args).collect())
        } else {
            return Err("DomainTrail: found neither `dt` nor `npx`. Install domaintrail (`npm i -D domaintrail`) \
                        or set `lsp.domaintrail.binary.path` in Zed's settings."
                .into());
        };
        Ok(zed::Command { command, args, env })
    }
}

zed::register_extension!(DomainTrailExtension);
