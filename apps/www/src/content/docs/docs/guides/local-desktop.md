---
title: Local Desktop (Preview)
description: Run SAM on your own Windows computer with local workspaces and a local model.
---

The SAM desktop app runs the whole control plane on your computer. Projects, conversations, and settings stay in a data folder on your computer. Agents run in Docker containers on the same machine. OpenCode can use a model served on your computer, such as Ollama. A local install never needs a Cloudflare account or a remote VM.

> **Preview.** The first release targets Windows 11 and one user per installation. The installer, Windows credential protection, and Docker Desktop/WSL2 behavior are still being verified on Windows.

## Prerequisites

- Windows 11 with WSL2 enabled
- Docker Desktop using the WSL2 backend
- For local inference: [Ollama](https://ollama.com) listening on `127.0.0.1:11434` (its default) with at least one model pulled, for example `ollama pull qwen2.5:0.5b`

On first start, the **Setup** page checks Docker Desktop and WSL2. Each check shows its status in words and how to fix it. You can open projects before every check passes, but workspaces need Docker.

## Projects start from a local folder

**New project** asks for a folder on your computer. SAM mounts that folder into the workspace as it is: nothing is cloned, uploaded, or deleted. Connecting a Git remote is a separate, explicit option.

## Choosing where model requests go

On **Setup → Local model**, choose **Ollama** or **OpenAI-compatible**, enter the address and model, and press **Save and check**. SAM accepts only addresses on this computer (`localhost`, `127.x.x.x`, `[::1]`) with no credentials in the URL. The check confirms that the model is installed.

For each agent under **Settings → Agents**, **Where requests go** offers:

| Choice                     | Behavior                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Model on this computer** | OpenCode sends requests through SAM's model gateway to the local model.                                                                  |
| **Cloud provider**         | The agent uses the cloud credential you saved. Hosted SAM inference stays available here only as an explicitly chosen cloud destination. |

Nothing is preselected, and SAM never switches between local and cloud for you. If the local model is down, or a cloud key is missing, the agent stops with an error that says how to fix it.

## Where your data lives

| Data                              | Location                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Projects, conversations, settings | `%LOCALAPPDATA%\SAM\data` (override with an absolute `SAM_LOCAL_DATA_DIR`)                                                |
| Local signing and encryption keys | `runtime\` in that folder, sealed with Windows protected storage                                                          |
| Provider API keys                 | The desktop credential store in `runtime\`, sealed with Windows protected storage. SAM's database holds only a reference. |
| Your code                         | The project folders you chose. SAM never deletes them.                                                                    |

A backup of the local database is taken before each upgrade.

## Closing, recovery, and uninstall

- **Closing with work running:** SAM asks whether to stop the work and quit (the default) or keep running in the background with a tray icon.
- **After a crash:** at the next start, SAM removes leftover workspace containers that belong to this installation and whose workspace no longer exists. If Docker can't confirm a removal, SAM reports the workspace as still pending; it never claims it was removed.
- **Uninstall:** `SAM.exe --uninstall=retain` removes this installation's containers and keeps your data. `--uninstall=delete` also deletes SAM's own files in the data folder. Both refuse to run while SAM is open, and neither touches your project folders.

## Troubleshooting

| Symptom                                                            | Fix                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Setup says Docker Desktop is not running                           | Start Docker Desktop and wait until it reports running, then select **Check again**. |
| Setup says WSL2 is missing                                         | Run `wsl --install` in an administrator terminal and restart Windows.                |
| **Save and check** says the model is unavailable                   | Start Ollama, or run `ollama list` to confirm the model name.                        |
| An agent set to local fails with "no local model configured"       | Save a local model on **Setup → Local model**.                                       |
| Saving an API key fails with "OS protected storage is unavailable" | Sign in to Windows with your own account. SAM won't store keys unprotected.          |
| Startup reports cleanup pending                                    | Remove the listed containers in Docker Desktop, then restart SAM.                    |
