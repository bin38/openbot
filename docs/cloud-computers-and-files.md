# Cloud computers, MCP import, and large files

This fork adds optional E2B desktops and improves the existing integration and attachment paths.
Mikka was used as a behavior reference. Its AGPL implementation is not included. E2B uses the
official MIT-licensed `@e2b/desktop` SDK; OpenBot retains its existing license.

## 中文使用说明：侧栏云电脑、工作区与渠道模型

### 在对话侧栏使用云电脑

在助手对话顶部点击 **云电脑**，也可以从侧边面板的分栏选择器打开它。此面板跟随当前助手，
使用该助手已经绑定的 E2B 桌面；**启动或恢复** 会继续使用原来的电脑和文件。

- **助手可操作 · 只读画面**：侧栏约每 2 秒更新桌面截图，AI 可以继续执行云端命令、鼠标键盘操作和文件传输。
- **接管电脑**：侧栏切换为可交互桌面，你可以直接使用鼠标和键盘。接管期间会阻止新的 AI 云电脑操作。
- **交还助手**：关闭交互会话并恢复 AI 操作。从此侧栏接管的桌面，在关闭侧栏时也会尝试交还；交还失败时继续保留人工控制。
- **暂停电脑**：保留云端状态，稍后可恢复。关闭侧栏不会删除电脑；**删除** 是另一项明确操作。

截图预览不会把 E2B 密钥、桌面访问令牌或交互页面的地址交给模型。人工桌面使用独立的隔离页面，
不具备 OpenBot 的预加载桥或本机文件访问权限。切换页面、隐藏窗口或弹出对话框时，原生桌面视图会隐藏，
避免遮挡其他界面。模型进程仍在运行 OpenBot 的电脑上，云电脑不会让已经关机的本机继续运行助手。

### 本机电脑操作与工作区

中文界面的 **电脑操作** 对应原来的 Computer Use。左侧导航提供快捷入口，设置中也保留该页面。
它操作本机应用；对话侧栏的 **云电脑** 操作 E2B 桌面，两者可以分别使用。

开发环境缺少本机驱动时，在仓库目录运行以下命令，然后重新启动该开发实例：

```sh
bun run prepare:cua-driver
bun run cua-driver:doctor
```

安装过程使用仓库锁定的版本并验证校验值。macOS 还需要在系统设置中授予屏幕录制和辅助功能权限；
驱动、权限或助手自身开关未就绪时，设置页会显示对应状态。

每个助手仍保留自己的工作区、文件和浏览器。可以通过助手菜单打开 **工作区文件夹**，
也可以在对话侧边面板中打开 **文件** 或 **浏览器**；这些本地功能不需要原站付费账号。
取消原站商业服务依赖不意味着移除本地工作区或本机操作能力。

### 自定义渠道与自动更新模型

打开 **服务器设置 → 服务商 → 自定义服务商**，填写自己的兼容接口地址和密钥，点击 **查找模型** 后保存。
密钥保存在本机加密渠道存储中。已保存渠道旁的 **刷新模型** 会读取上游模型列表；开启 **自动更新模型**
会立即检查一次，并在 OpenBot 运行期间每小时检查，应用启动时也会检查已经到期的渠道。

本地渠道最多保存 256 个模型。新模型会加入列表；上游撤下的模型会显示提示并保留原有选择，
避免悄悄改变助手、默认模型或备选模型。失败时保留已保存内容并显示失败时间，可再次刷新。
需要重启的运行程序如果正在忙碌，会先保存列表并显示等待状态。已发布的旧 Team API 仍保持 64 个模型的界限，
旧客户端的渠道管理列表最多收到前 64 个；本机可保留和使用完整列表。

模型同步只请求模型目录，不执行聊天、推理或图像任务，也不会自动选择 Claude 或改变 Codex 默认设置。
上游返回的模型可能包含聊天、图像、视频或语音型号，能否执行具体任务取决于该渠道和模型支持的接口。

本轮使用的侧栏、工作区、电脑操作和渠道同步说明使用中文；品牌名、代码标识符、上游模型 ID 和用户内容保持原样。

## E2B setup

1. Open the local server's settings and select **Cloud computer**.
2. Enter your E2B API key. Keep `desktop` as the template unless you have another compatible
   E2B desktop template. Set the automatic pause period and save.
3. Select an agent and choose **Create computer**. E2B bills the account associated with the key.
4. Ask that agent to use its cloud computer. Its tools provide shell commands, screenshots,
   mouse and keyboard input, and file transfer. Files uploaded by the tool must belong to that
   agent's workspace. Downloads are delivered directly as managed chat attachments without
   exposing private temporary paths or overwriting workspace files.
5. Use **View screenshot** to inspect the desktop, or **Take control** to open an interactive
   viewer. Close the viewer or choose **Return to agent** to revoke the viewer and resume agent
   access. If revocation fails, human control remains active until handback succeeds.

Each agent keeps its own machine binding. Status checks do not start a computer. A connection
failure does not replace a computer or discard its binding. **Pause computer** retains cloud files;
**Delete** permanently removes the cloud computer and its files. Changing the template affects
new computers. A key from another E2B account does not gain access to existing computers.

The key is encrypted on the host and never returned by settings reads. The viewer has no app
preload or local Node access. Agent cloud actions use the existing approval policy; human
takeover blocks new agent actions and waits for an in-progress action to finish. Commands run
under a supervisor that stops their descendants before it returns control. Starting, resuming,
and tool actions renew the automatic-pause period; human control also has a time limit.

The model runner remains on the OpenBot host. For unattended work while a laptop is off, run
OpenBot on an always-on host. Adding E2B does not migrate model credentials or conversations to
the cloud. See [Privacy](../PRIVACY.md) for the data sent to E2B.

## MCP and plugins

Open **Server settings → MCP → Import configuration**. Choose a JSON file or paste a configuration:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://your-service.example/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

Standard `mcpServers`, Mikka `servers` lists, and a single server entry are supported. Review the
list, select entries, and continue through the existing editor, test, sign-in, and save flow.
Imported IDs do not replace existing servers. The preview does not display header values,
environment secrets, or command arguments. A Mikka export that omits credentials needs those
credentials entered again.

HTTP means MCP Streamable HTTP. Legacy SSE entries are reported as unsupported rather than
silently converted to a different transport. Use the service's Streamable HTTP address or an
explicit stdio configuration. The independent Marketplace uses the bundled app catalog and public
MCP Registry. Connections use the service's own supported authentication flow and your credentials;
there is no shared Composio or Codex connector account. See [independent plugins](independent-plugins.md).

## Attachments

Desktop attachments accept regular files of any type, including ZIP, 7z, RAR, tarballs, binary
files, and files without an extension. Upload permission is separate from preview and launch
permission: an unknown format is stored as an opaque file, never executed or automatically extracted.

Local path imports copy and hash on disk. Updated hosts advertise `streaming-attachments-v1`;
their desktop and browser clients transfer bounded chunks and verify offsets and SHA-256 at
completion. File size has no application quota on this path; disk capacity, filesystem limits,
and provider limits still apply. Ten attachments per message remains unchanged. A transfer
failure or cancellation removes the temporary upload rather than publishing an incomplete file.

Older hosts keep their released limits and protocols. Clients check capabilities before reading
a file they cannot send to an older host. Mobile's existing native attachment bridge has not been
migrated to the new streaming path. Browser save support depends on the browser's file-writing
API; the desktop can save a streamed download directly to disk.

The limits of agent archive import and skill-package installation are separate extraction safety
boundaries. This change does not remove those limits or alter installed Skills.

## Verification

Use the repository's pinned Bun and Node versions. Focused checks include:

```sh
bun scripts/mcp-config-import-e2e.ts
bun scripts/e2b-desktop-e2e.ts
bun scripts/attachment-streaming-e2e.ts
bun run test:desktop -- src/main/e2b-viewer-policy.test.ts src/preload/e2b-decoding.test.ts src/main/ipc-channel-coverage.test.ts
bun scripts/verify-preload-bundle.ts --preload-dir=out-dev-app/preload
```

The default E2B check exercises the real service, encrypted state, local file streams and a test
adapter. It does not provision a cloud computer. A separate opt-in live check uses
`OPENBOT_E2B_LIVE_KEY` and `bun scripts/e2b-desktop-e2e.ts --live`; it incurs E2B usage and deletes
its test computer on completion. Do not put a real key in a committed file or paste it into a chat.

For a computer already configured in the development app, use
`bun scripts/e2b-live-ui-e2e.ts --instance=<id> --agent-name=<name> --allow-mutations`.
This check resumes the existing computer, verifies a real viewer framebuffer, returns control,
and restores an initially paused computer to paused state. It creates no new computer and reads
no API key into the script. Reports and screenshots are written under `.openbot-build/`.

## Product reference

The public [Grok Bot overview](https://docs.x.ai/grok-bot/overview) and
[computer and apps documentation](https://docs.x.ai/grok-bot/computer-and-apps) informed persistent
computers, explicit handover, and reusable app connections. Existing OpenBot queues, routines,
agent collaboration and Marketplace are reused. The per-agent E2B design differs from Grok Bot's
shared account computer, and does not claim Grok Bot's hosted, always-on execution service.
