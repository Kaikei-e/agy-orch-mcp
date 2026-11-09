# agy-orch-mcp

[English](README.md) · [設計ドキュメント](docs/design.ja.md) · [Apache-2.0](LICENSE)

`agy-orch-mcp` は、MCP クライアントから Google Antigravity CLI (`agy`) にタスクを委譲するための、ローカル [Model Context Protocol](https://modelcontextprotocol.io/) サーバーです。stdio で通信し、`agy` を子プロセスとして起動して、結果を構造化された MCP コンテンツとして返します。

個人のローカル利用を主目的にしつつ、OSS としてコードの確認・改変・貢献ができる形を目指しています。Antigravity の公式製品ではなく、Antigravity 側のアカウント、信頼設定、権限設定を置き換えるものでもありません。

## 概要と agy-first 運用モデル

詳細なアーキテクチャ、設計意図、および検証計画については [docs/design.ja.md](docs/design.ja.md) を参照してください。

`agy-orch-mcp` は **agy-first** の役割分担を前提として設計されています：

- **外部フロンティアホスト**: Codex CLI / IDE や Claude Code などの外部ホスト環境は、高次のオーケストレーターとして振る舞います。タスクの分割、構造化された指示パケットの作成、最終差分（diff）およびエビデンスのレビューに専念し、直接の広範な調査やコード編集を避けます。
- **Antigravity 実行エンジン**: ローカルの Antigravity CLI (`agy`) が主実行エンジンとなり、リポジトリ調査、Web 仕様調査、実装、テスト実行、セルフ修正ループを担当します。
- **再帰・逆委譲の禁止**: 委譲を受けた Antigravity CLI セッションは、提供されているネイティブツールを用いて直接タスクを完了します。自身から `agy-orch-mcp` を再帰的に呼び出したり、外部ホストへ作業を差し戻してはなりません。
- **委譲ガイダンスとホスト機能**: サーバーは初期化時の instructions およびツール説明を通じて、ホストが Antigravity へタスクを委譲するよう誘導します。これは既定の運用方針を示すガイダンスであり、ホストが持つ他の組み込みツールを強制的に無効化するものではありません。

## 提供するツール

| MCP ツール             | 提供状態   | 用途                                                                                                                     |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `antigravity_run`      | 既定       | 新しい Antigravity 会話を開始します。CLI が返した場合は `conversation_id` も返します。                                   |
| `antigravity_continue` | 既定       | 必須の `conversation_id` で会話を継続します。同じ会話の直接の続きにのみ使い、新しいタスクは `run` で開始します。         |
| `antigravity_models`   | 既定       | `agy models` を実行して CLI の出力を返します。モデルターンは開始しませんが、Antigravity に接続する場合があります。       |
| `antigravity_batch`    | オプトイン | 分離された Git worktree 上で検証ゲート付きのマルチタスク DAG を実行し、成果物のみの `final.patch` を生成します。         |
| `antigravity_fetch`    | オプトイン | 論理セレクタにより成果物（stdout、stderr、patch、digest、manifest、request、plan、events）のスライスを安全に取得します。 |

`run` と `continue` は、プロンプト、絶対パスのワークスペース、任意のモデル・effort、`plan` または `accept-edits` の mode、autonomy、1 ターンあたりの上限時間（`timeout_seconds`、10〜900、既定 900）、スロット待機時間（`queue_timeout_seconds`、0〜900、既定 0）、および `return_mode`（`raw`、`digest`、`structured`）を受け取ります。オプトインのツール（`antigravity_batch` と `antigravity_fetch`）は `AGY_MCP_ENABLE_BATCH=true` および `AGY_MCP_ENABLE_FETCH=true`（または `AGY_MCP_TOOL_SURFACE=batch`）で有効化します。

### モデルの選定と優先順位

モデルの決定順序（優先順位）は以下の通りです：

1. ツール呼び出し時（`antigravity_run` / `antigravity_continue`）に明示された `model` 引数
2. サーバー環境変数 `AGY_MCP_DEFAULT_MODEL`（設定されている場合）
3. サーバー組み込みの既定モデル（`gemini-4-argon-high`）

利用可能なモデル slug は `antigravity_models` で事前に取得し、キャッシュまたは設定に利用してください。

### 安全性、ワークスペースの境界、ブリッジによるステータス分類

既定のリクエスト設定は `mode: "plan"` および `autonomy: "safe"` です。

- `safe` は `agy` で設定されたワークスペースの信頼とパーミッションを継承します。これは**読み取り専用を保証するものではありません**。
- ワーカーから返却される出力は未検証です。モデルの散文応答に書かれたコマンドではなく、機械抽出された `verified_outputs` 台帳および `git diff` を確認してください。
- `mode`（`plan` または `accept-edits`）はエージェントへの意図伝達です。現在の headless モードでは、`--disable-slash-commands` 有効時に `--mode` が効果を持たない旨の警告が CLI から出力されます。したがって `mode` は意図を示すものであり、OS レベルのセキュリティ境界ではありません。
- `autonomy` はパーミッションの取り扱いを制御します：
  - `safe`（既定）: `agy` の信頼・パーミッション設定に加え、ブリッジの固定 deny ルールとコマンドガードを適用します。
  - `sandbox`: CLI のターミナルサンドボックス制限を追加します。
  - `full`: CLI に `--dangerously-skip-permissions` を渡します。サーバー環境で `AGY_MCP_ALLOW_FULL_AUTONOMY=true` が設定されていない限り拒否されます。
- `AGY_MCP_ALLOWED_ROOT` を設定した場合、指定ルート配下の正規化パスのみをワークスペースとして許可します。これは**ワークスペースの選択のみを制限**するものであり、子プロセスのファイルシステムアクセスやネットワークアクセスを隔離（サンドボックス化）するものではありません。
- **コマンドガード (`--install-guard`) と固定 deny ルール**:
  - `agy-orch-mcp --install-guard` を実行すると、`~/.gemini/config/hooks.json` に環境変数ゲート付きの `PreToolUse` フック（名称 `agy-orch-mcp-guard`）を 1 件追加します（既存の他フックは維持され、タイムスタンプ付きの `.bak` バックアップが作成されます）。`agy-orch-mcp --uninstall-guard` で削除できます。
  - フックはブリッジが `AGY_ORCH_MCP_GUARD=1` を設定したときのみ判定を行うため、通常の `agy` セッションには影響しません。実測された `agy` の仕様として、headless モードでフックが `"ask"` を返すと自動承認されてしまうため本ガードは `"ask"` を一切使用せず、環境変数が未設定のときは空出力を返して判定を棄権（abstain）します。
  - ガード有効時は、リモートを変更する `git` / `gh` 操作（`git push`、`gh pr` / `issue` / `repo` / `release` / `workflow` / `run` / `secret` / `variable` / `label` の変更系サブコマンド、明示的な `GET` なしの `gh api`。`sh -c`、`xargs`、`env`、`timeout` 等のラッパー経由を含む）およびクォートされていないリダイレクト・コマンド置換（`>`、`<`、`$(`、バッククォート）をワーカーが対処可能な理由付きで `"deny"` します。それ以外の全コマンドには `"deny_unless_prior_grant"`（パス付きバイナリ、Go テンプレート `{{`、未クォート括弧、環境変数プレフィックスに対する書き換えヒント付き）を返し、allow ルール不足で headless ターン全体が即終了するのを防ぎます。
  - またブリッジは `safe` / `sandbox` 時に常に固定の deny ルール（`command(git push)` および変更系 `command(gh ...)`）を `--settings` で渡します（ユーザーの allow リストとマージされます）。
  - `agy-orch-mcp --doctor` はガードフックの状態（`installed` / `missing` / `outdated`）と `~/.gemini/antigravity-cli/settings.json` のパーミッション監査（`high` / `medium` / `low`）を表示します。`AGY_MCP_GUARD=off` で無効化できます。
- **会話単位の環境分離 (`AGY_MCP_ENV_ISOLATION`)**:
  - `AGY_MCP_ENV_ISOLATION=full`（既定）| `install` | `off` とルート `AGY_MCP_ENV_ROOT`（既定 `<XDG_STATE_HOME または ~/.local/state>/agy-orch/env`）で制御します。会話ごとに 1 ディレクトリ（`<AGY_MCP_ENV_ROOT>/<conversation_id>`）を作成して `antigravity_continue` で再利用し、サーバー起動時に 24 時間以上経過したディレクトリを自動削除します。
  - `install`（および `full`）で設定される変数: `GOBIN`、`npm_config_prefix`、`BUN_INSTALL`、`PNPM_HOME`、`CARGO_INSTALL_ROOT`、`PYTHONUSERBASE`、`CHOKIDAR_USEPOLLING=1`、`WATCHPACK_POLLING=true`（ファイルウォッチャーはポーリングを使用）、および各 `bin` ディレクトリを先頭に追加した `PATH`。
  - `full` で追加設定される変数: `GOPATH`、`GOMODCACHE`、`GOCACHE`、`npm_config_cache`、`npm_config_store_dir`、`BUN_INSTALL_CACHE_DIR`、`CARGO_HOME`、`PIP_CACHE_DIR`、`UV_CACHE_DIR`。
  - トレードオフ: `full` モードは会話ごとにモジュールや crate を再ダウンロードし、`CARGO_HOME` の分離により `~/.cargo/config.toml` が参照されなくなります。これが問題になる場合は `AGY_MCP_ENV_ISOLATION=install` を使用してください。
- **エビデンス・事前警告・ブリッジによるステータス分類**:
  - **機械抽出されたコマンド台帳 (`verified_outputs`)**: `agy` のイベントストリームから `run_command` の実行記録を機械抽出し、`verified_outputs`（`step_index`、`command`、`status` `completed` | `failed` | `denied` | `background` | `running`、`exit_code`、`output_tail`、`error`、`full_output_path`、`background_task_id`、`duration_seconds`）として返します。ホストは応答本文に引用されたコマンドではなく `verified_outputs` を信頼してください。
  - **構造化ハンドオフ (`return_mode: "structured"`)**: `--json-schema`（`src/handoff-schema.ts`: `summary`、`changes`、`verification`、`facts`、`side_effects`、`blockers`）を渡し、パース結果のオブジェクトを `handoff`（失敗時は `handoff_error`）として返します（生テキストも `response` に保持されます）。
  - **事前警告 (`preflight_warnings`)**: プロンプト内に記載されたコマンドのうち allow リストで拒否されるもの、およびガードフックが未インストールの場合の警告を `preflight_warnings` に返します。
  - **`PERMISSION_DENIED` と `denied_commands`**: `agy` が `denied_actions` を記録した場合、`status: "PERMISSION_DENIED"` に分類し、ストリームと会話 transcript から拒否されたコマンドラインを `denied_commands`（最後のツール呼び出しとしてのみ現れる拒否を含む）として抽出し、`partial_response` と `workspace_changes` も付与します。
  - **コンテキストローテーション (`context`)**: run / continue の結果には `context`（ターン数と累積 `total_tokens`）が含まれます。`AGY_MCP_CONTEXT_ROTATE_TOKENS` を超えると `context.rotate_recommended` が `true` になり、簡潔な引き継ぎを付けた新しい `antigravity_run` の開始を推奨します。
  - **`EMPTY_RESPONSE`**: `agy` が `SUCCESS` で空の応答本文を返した場合、`status: "EMPTY_RESPONSE"` に分類し、`partial_response` と `workspace_changes` を返して再試行前の副作用確認を促します。

### 構造化指示パケット (Task Packet)

ホストが `antigravity_run` にタスクを委譲する際は、15 分以内の再開可能なターンに収まる構造化パケットを作成します。ガードフックが禁止構文に対してヒントを返すため、禁止シェル文字の長い一覧をプロンプトに書く必要はありません（「1 回の呼び出しにつき 1 つの単純なコマンド」という指示のみ維持してください）：

```json
{
  "prompt": "【ゴール】JWT 認証ミドルウェアを実装する。\n【スコープ】変更対象は src/auth.ts および test/auth.test.ts のみ。設定ファイルは変更禁止。\n【制約・受入基準】TypeScript の strict 規約に準拠し、1 回の呼び出しにつき 1 つの単純なコマンド（`pnpm test`）で検証すること。\n【ハンドオフ】変更内容、参照した外部 URL と要点、残存ブロッカーを報告すること。",
  "workspace": "/absolute/path/to/workspace",
  "mode": "accept-edits",
  "autonomy": "safe",
  "timeout_seconds": 900,
  "return_mode": "structured"
}
```

## バッチオーケストレーション (`antigravity_batch` & `antigravity_fetch`)

`AGY_MCP_ENABLE_BATCH=true` および `AGY_MCP_ENABLE_FETCH=true`（または `AGY_MCP_TOOL_SURFACE=batch`）を有効化すると、マルチタスク DAG バッチ実行が利用できます：

- **分離 Worktree とパッチ成果物**: 各タスクは独立した Git worktree で実行され、検証後の変更は `final.patch` 成果物として保存されます（ホストの作業ツリーは直接変更されません）。`workspace.dirty_policy` は `"reject"` であり、クリーンな Git 作業ツリーが必要です。
- **所有権とゲート実行**: `task.owns` は編集許可パス（`owns ⊆ scope.include` かつ `owns ∩ scope.exclude = ∅`）を定義し、`gate.command` は明示的な引数配列（`string[]`）を受け取ります。
- **1 ターン上限と自動再開・モデル解決**: バッチワーカーの 1 ターンあたりのタイムアウトは `900,000` ms（15 分）に制限されます。ターンが上限に達した場合は、同じ worktree と同じ会話（`conversation_id`）のままブリッジが生成した再開プロンプトで自動的に継続実行され、`max_worker_calls` にカウントされます。また、`gemini-4-argon-high` のように effort サフィックスを持つモデル slug に対して `--effort low` を重複指定して失敗する不具合を修正しています。

## 並列実行、タイムアウト、境界のあるエラー復旧

既定では最大 8 件まで `agy` を並列実行できます（`AGY_MCP_MAX_CONCURRENT`）。

- `antigravity_models` を含む全コマンドが同時実行数に数えられます。全スロット使用中は既定（`queue_timeout_seconds: 0`）では即座に `BUSY` を返しますが、`queue_timeout_seconds`（`0`〜`900`）を指定すると空きスロットが出るまで FIFO キューで待機し、キュー位置の進捗通知（`Queued for an agy slot (position N)`）と `queue_wait_seconds` を返します。
- 新規会話や異なる明示的な `conversation_id` のタスクは並列実行できます。同じ会話 ID への同時呼び出しは即座に `BUSY` を返します。
- 排他制御と上限は 1 つのサーバープロセス内で有効です。ワークスペースのファイル、認証情報、CLI の状態は共有されます。
- 全 MCP ツールは `annotations.readOnlyHint: true` および `annotations.destructiveHint: false` を宣言しており、ホスト側のツールスケジューラによる同一ターン内の並列ディスパッチを有効化しています：
  - **Claude Code**: `annotations.readOnlyHint: true` を内部の `isConcurrencySafe()` 判定にマッピングするため、同一メッセージ内で複数の `antigravity_run` や異なる `conversation_id` の `antigravity_continue` を発行するとそのまま並列実行されます（リレー用のサブエージェントは不要です。アップグレード後は実行中サーバーがアノテーションを広告するよう `pnpm build` で `dist` を再ビルドしてください）。また、Claude Code は 2 分を超えて実行される MCP 呼び出しを自動的にバックグラウンドへ移行します（`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`）。
  - **OpenAI Codex CLI / IDE**: サーバー設定に `supports_parallel_tool_calls = true` を指定すると、同一ターン内の複数ツール呼び出しが並列実行されます。
  - 同一リポジトリに対するコード変更の並列化には、各タスクを Git worktree で分離する `antigravity_batch` を優先してください。
- **MCP Tasks 拡張 (`io.modelcontextprotocol/tasks`, revision `2026-07-28`)**: 既定で有効（`AGY_MCP_TASKS=auto`、`AGY_MCP_TASKS=off` で無効化）。この拡張を広告するクライアントはタスクハンドル（`resultType: "task"`）を受け取り、`tasks/get` でポーリングできます（テスト内の SDK クライアントで検証済み。Claude Code は v2.1.304 以降のメイン会話呼び出しでのサポートを文書化しています）。
- **15 分のターン上限 (`timeout_seconds`)**: `timeout_seconds` は既定値・最大値ともに `900`（10〜900 秒、15 分）です。`agy` 自身が `--print-timeout` によりターンを終了し、その 60 秒後にブリッジがプロセスを強制終了します。これは高速なフィードバックサイクルを保ち、長時間タスクを再開可能なターンに分割するためです。上限に達したターンは `status: "TIMEOUT"` とともに `resumable: true`、`conversation_id`、`partial_response`、`verified_outputs`、`workspace_changes`、`terminated_tasks`、`turn_seconds` を返すため、`antigravity_continue` で続きを実行してください。なお、`agy` が返す `duration_seconds` は会話の累積時間であり、`turn_seconds` が当該ターンの所要時間です。
- **短縮された応答 (`response_outline` と `resource_link`)**: 応答文字数は `AGY_MCP_MAX_OUTPUT_CHARS`（既定 40000、推奨 16000）で制限されます。短縮された場合は全文を `response_artifact.path` に保存し、見出しと行範囲の対応を示す `response_outline` および `resource_link` を添えて返します。
- **`BUSY` への対処**: `queue_timeout_seconds`（0〜900）を指定するか、待機・直列化して呼び出し、リトライストームを避けてください。
- **`TIMEOUT` および空応答 (`EMPTY_RESPONSE`) への対処**: `TIMEOUT`（`resumable: true`）時は報告された `partial_response`、`verified_outputs`、`workspace_changes`、`terminated_tasks` を基に `antigravity_continue` で継続します。`EMPTY_RESPONSE` 時は再試行前に `workspace_changes`（`git status`）を確認してください。
- **`PERMISSION_DENIED` およびエラーへの対処**: `denied_commands` と `workspace_changes` を確認し、許可された代替手段を明示して継続するか、具体的なブロッカーをユーザーに報告します。

## 前提条件

- Node.js 22 以上
- pnpm 10 以上（このリポジトリは pnpm 10.34.9 を固定）
- `agy` が PATH にある、または `AGY_MCP_BIN` で実行ファイルを指定済み
- Antigravity が利用を許可しているワークスペース

公式ドキュメント参照先：

- [Antigravity CLI headless 公式ドキュメント](https://antigravity.google/docs/cli/headless/)
- [OpenAI Codex MCP 設定ドキュメント](https://developers.openai.com/codex/mcp/)
- [公式 TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## ソースから導入する

```bash
git clone https://github.com/Kaikei-e/agy-orch-mcp.git
cd agy-orch-mcp
pnpm install --frozen-lockfile
pnpm build
node dist/index.js --install-guard
pnpm run doctor
```

`node dist/index.js --install-guard`（または `agy-orch-mcp --install-guard`）は、`~/.gemini/config/hooks.json` に環境変数ゲート付きのコマンドガードフックを追加します（削除は `--uninstall-guard`）。`pnpm run doctor` はモデルターンを開始せずに、ワークスペース、CLI フラグ、ガードフックの状態、および `~/.gemini/antigravity-cli/settings.json` のパーミッション監査（`high` / `medium` / `low`）を確認します。

認証後の動作確認用スモークテスト（任意）：

```bash
pnpm run probe
```

probe は返された会話に対して `run` と `continue` を実行します。実際の Antigravity クォータを消費し会話を作成するため、意図的に CI から除外されています。

## MCP クライアントを接続する

サーバーをビルドした後、クライアントから起動できるように設定します。

> [!IMPORTANT]
> **クライアントセッションの再起動**: MCP 設定を変更した後は、必ず Codex CLI / IDE や Claude Code のセッションを再起動してください。既存の設定ファイルを編集する場合は、他の設定を上書きしないようテーブルを注意深くマージしてください。

### Claude Code (`.mcp.json`)

プロジェクトルートの `.mcp.json` に設定を追加します：

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "node",
      "args": ["/absolute/path/to/agy-orch-mcp/dist/index.js"],
      "env": {
        "AGY_MCP_DEFAULT_WORKSPACE": "/absolute/path/to/workspace",
        "AGY_MCP_ALLOWED_ROOT": "/absolute/path/to",
        "AGY_MCP_MAX_CONCURRENT": "8",
        "AGY_MCP_MAX_OUTPUT_CHARS": "16000"
      }
    }
  }
}
```

_推奨_: `AGY_MCP_MAX_OUTPUT_CHARS="16000"` を指定すると、ツールの応答文字数がコンパクトに抑えられ、ホスト側のコンテキスト消費を節約できます。

### OpenAI Codex CLI / IDE (`config.toml`)

`~/.codex/config.toml`（グローバル）または `.codex/config.toml`（信頼済みプロジェクト）に設定を追加します：

```toml
[mcp_servers.antigravity]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/agy-orch-mcp/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 3660
supports_parallel_tool_calls = true

[mcp_servers.antigravity.env]
AGY_MCP_DEFAULT_WORKSPACE = "/absolute/path/to/workspace"
AGY_MCP_ALLOWED_ROOT = "/absolute/path/to"
AGY_MCP_MAX_CONCURRENT = "8"
# ホストのコンテキスト節約のためコンパクトな出力上限（16000文字）を推奨:
AGY_MCP_MAX_OUTPUT_CHARS = "16000"
# antigravity_models で取得したモデル slug の既定値（任意）:
# AGY_MCP_DEFAULT_MODEL = "a-slug-returned-by-antigravity_models"
# agy が PATH に通っていない場合のみ指定:
AGY_MCP_BIN = "/absolute/path/to/agy"
```

Codex CLI のコマンドによる登録：

```bash
codex mcp add antigravity \
  --env "AGY_MCP_DEFAULT_WORKSPACE=/absolute/path/to/workspace" \
  --env "AGY_MCP_ALLOWED_ROOT=/absolute/path/to" \
  --env "AGY_MCP_MAX_CONCURRENT=8" \
  --env "AGY_MCP_MAX_OUTPUT_CHARS=16000" \
  -- "/absolute/path/to/node" "/absolute/path/to/agy-orch-mcp/dist/index.js"
```

登録後、`config.toml` に `startup_timeout_sec = 20` と `tool_timeout_sec = 3660` を追加してください。

### 個人用クライアント設定の Git 除外

個人環境に依存した MCP 設定ファイルを Git にコミットしないでください。対象リポジトリの `.gitignore` に明示ルールを追加します：

```gitignore
# Personal MCP client settings
.mcp.json
.codex/
.claude/settings.local.json
```

除外設定の確認：

```bash
git check-ignore -v .mcp.json .codex/config.toml .claude/settings.local.json
git status --short
```

## 再利用可能なプロジェクトテンプレート

他のリポジトリに agy-first 体制を導入する際は、同梱のテンプレートをご活用ください：

- [examples/AGENTS.md](examples/AGENTS.md): プロジェクト共通の agy-first 運用方針
- [examples/CLAUDE.md](examples/CLAUDE.md): `@AGENTS.md` を取り込む Claude Code 設定テンプレート

既存プロジェクトに導入する際は、既存の指示やビルドコマンドを上書きするのではなく、既存の `AGENTS.md` や `CLAUDE.md` にルールを**マージ**してください。

## 設定一覧

| 変数名                          | 既定値                                                | 説明                                                                                                    |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `AGY_MCP_BIN`                   | `agy`                                                 | CLI 実行ファイル名、または絶対パス・相対パス。                                                          |
| `AGY_MCP_DEFAULT_WORKSPACE`     | サーバー実行時ディレクトリ                            | 既定のワークスペース。                                                                                  |
| `AGY_MCP_ALLOWED_ROOT`          | 未設定                                                | 選択可能なワークスペースを制限する正規化ルートディレクトリ。                                            |
| `AGY_MCP_DEFAULT_MODEL`         | `gemini-4-argon-high`                                 | 既定モデル slug。優先順位: 個別引数 `model` > `AGY_MCP_DEFAULT_MODEL` > `gemini-4-argon-high`。         |
| `AGY_MCP_FAST_MODEL`            | 未設定                                                | バッチタスクで `worker.tier: "fast"` が指定された際の任意モデル slug。                                  |
| `AGY_MCP_REASONING_MODEL`       | 未設定                                                | `worker.tier: "reasoning"` または修復エスカレーション時の任意モデル slug。                              |
| `AGY_MCP_ENABLE_BATCH`          | `false`                                               | `true` で `antigravity_batch` ツールを公開（surface=batch 時は自動で true）。                           |
| `AGY_MCP_ENABLE_FETCH`          | `false`                                               | `true` で `antigravity_fetch` ツールを公開（surface=batch 時は自動で true）。                           |
| `AGY_MCP_TOOL_SURFACE`          | `all`                                                 | 公開ツールプロファイル: `all`（既定）、`compat`、または `batch`（batch/fetch のみ公開）。               |
| `AGY_MCP_MAX_CONCURRENT`        | `8`                                                   | 同時実行できる CLI プロセス数の上限（1〜32）。                                                          |
| `AGY_MCP_MAX_OUTPUT_CHARS`      | `40000`                                               | MCP 結果の最大文字数（1024〜1000000、ホスト負荷軽減のため 16000 を推奨）。                              |
| `AGY_MCP_CONTEXT_ROTATE_TOKENS` | `2000000`                                             | 会話ごとの累積 `total_tokens` がこの値に達すると `context.rotate_recommended` を返す（1〜1000000000）。 |
| `AGY_MCP_MAX_BUFFER_BYTES`      | `8388608`                                             | プロセスごとの stdout バッファ上限バイト数（1024〜67108864）。                                          |
| `AGY_MCP_ALLOW_FULL_AUTONOMY`   | `false`                                               | `true` に設定すると `autonomy: "full"` の呼び出しを許可。                                               |
| `AGY_MCP_GUARD`                 | `on`                                                  | コマンドガード（`on` または `off`）。`on` 時は `AGY_ORCH_MCP_GUARD=1` を設定しガード状態を確認。        |
| `AGY_MCP_ENV_ISOLATION`         | `full`                                                | 会話単位の環境分離モード（`full`、`install`、`off`）。                                                  |
| `AGY_MCP_ENV_ROOT`              | `<XDG_STATE_HOME または ~/.local/state>/agy-orch/env` | 会話単位の分離環境のルートディレクトリ（起動時に 24 時間超のものを削除）。                              |
| `AGY_MCP_TASKS`                 | `auto`                                                | MCP Tasks 拡張（`io.modelcontextprotocol/tasks`, revision `2026-07-28`）: `auto`（既定）または `off`。  |
| `AGY_ORCH_STORAGE_DIR`          | 未設定                                                | artifact store およびテレメトリの保存先ディレクトリ（既定は XDG state/cache パス）。                    |

## 開発

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm format:check
```

Issue や PR を作成する前に [CONTRIBUTING.md](CONTRIBUTING.md) および [SECURITY.md](SECURITY.md) をご確認ください。本プロジェクトは [Apache License 2.0](LICENSE) の下で公開されています。
