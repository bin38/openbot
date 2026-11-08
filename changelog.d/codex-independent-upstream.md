### Added

- Let each local assistant select an existing project workspace or restore its managed folder. Group channels retain separate member workspaces and use Shared for deliverables. Selected projects survive switching and assistant removal.
- Add in-app Colab CLI sign-in, named runtime controls and assistant tools for Python, local notebooks and managed file transfers. Runtime creation is explicit and CPU-only.
- Support authenticated SOCKS5 through a private application proxy for Gemini and Colab. Username and password are encrypted together and are not returned to the page.

### Fixed

- Keep current agent and chat identities when a workspace or application proxy changes. Busy workspace changes, stale queue interruptions and failed proxy preparation do not silently switch work to another folder, turn or direct network route.
- Fit generated local server names to the existing limit on first startup, including Macs with long hostnames. Keep saved names unchanged.

