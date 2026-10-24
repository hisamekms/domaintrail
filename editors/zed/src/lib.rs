//! Zed extension for DomainTrail: starts `dt lsp` for `.dt` files.
//!
//! The command is, in this order: `lsp.domaintrail.binary.path` in Zed's settings, `dt` on the PATH, else domaintrail
//! at a pinned version, installed with npm into the extension's own directory and run with Zed's Node. No file of the
//! worktree is run by default (an untrusted repository could ship its own `node_modules/.bin/dt`). The arguments are
//! `lsp` unless the settings give `binary.arguments`; `binary.env` is added to the worktree's shell environment.
//!
//! The settings are Zed's merged settings, and a project's `.zed/settings.json` takes part in them: the extension API
//! cannot tell user settings from project settings, so a project can name its own command, as it can for Zed's built-in
//! language servers. Guarding against untrusted projects is Zed's (its restricted mode for untrusted worktrees).

use std::{env, fs};

use zed_extension_api::{self as zed, LanguageServerId, Result, settings::LspSettings};

const SERVER: &str = "domaintrail";
const PACKAGE: &str = "domaintrail";
/// The domaintrail version installed when neither the settings nor the PATH give `dt`.
const PINNED_VERSION: &str = "0.4.0";
const PACKAGE_CLI: &str = "node_modules/domaintrail/dist/dt.js";

struct DomainTrailExtension;

impl zed::Extension for DomainTrailExtension {
    fn new() -> Self {
        DomainTrailExtension
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
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
        } else if let Some(dt) = worktree.which("dt") {
            (dt, args)
        } else {
            let cli = pinned_cli(language_server_id)?;
            (zed::node_binary_path()?, std::iter::once(cli).chain(args).collect())
        };
        Ok(zed::Command { command, args, env })
    }
}

/// The CLI of domaintrail at [`PINNED_VERSION`] in the extension's directory, installed first if needed.
fn pinned_cli(language_server_id: &LanguageServerId) -> Result<String> {
    if zed::npm_package_installed_version(PACKAGE)?.as_deref() != Some(PINNED_VERSION) || fs::metadata(PACKAGE_CLI).is_err() {
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::Downloading,
        );
        let installed = zed::npm_install_package(PACKAGE, PINNED_VERSION);
        zed::set_language_server_installation_status(language_server_id, &zed::LanguageServerInstallationStatus::None);
        installed.map_err(|e| format!("DomainTrail: could not install {PACKAGE}@{PINNED_VERSION}: {e}"))?;
    }
    let dir = env::current_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(PACKAGE_CLI).to_string_lossy().into_owned())
}

zed::register_extension!(DomainTrailExtension);
