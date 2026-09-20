# agy-mcp

[English](README.md) · [設計ドキュメント](docs/design.ja.md) · [Apache-2.0](LICENSE)

`agy-mcp` は、MCP クライアントから Google Antigravity CLI (`agy`) にタスクを委譲するための、ローカル [Model Context Protocol](https://modelcontextprotocol.io/) サーバーです。stdio で通信し、`agy` を子プロセスとして起動して、結果を構造化された MCP コンテンツとして返します。

個人のローカル利用を主目的にしつつ、OSS としてコードの確認・改変・貢献ができる形を目指しています。Antigravity の公式製品ではなく、Antigravity 側のアカウント、信頼設定、権限設定を置き換えるものでもありません。

## 概要と agy-first 運用モデル

詳細なアーキテクチャ、設計意図、および検証計画については [docs/design.ja.md](docs/design.ja.md) を参照してください。

`agy-mcp` は **agy-first** の役割分担を前提として設計されています：

- **外部フロンティアホスト**: Codex CLI / IDE や Claude Code などの外部ホスト環境は、高次のオーケストレーターとして振る舞います。タスクの分割、構造化された指示パケットの作成、最終差分（diff）およびエビデンスのレビューに専念し、直接の広範な調査やコード編集を避けます。
- **Antigravity 実行エンジン**: ローカルの Antigravity CLI (`agy`) が主実行エンジンとなり、リポジトリ調査、Web 仕様調査、実装、テスト実行、セルフ修正ループを担当します。
- **再帰・逆委譲の禁止**: 委譲を受けた Antigravity CLI セッションは、提供されているネイティブツールを用いて直接タスクを完了します。自身から `agy-mcp` を再帰的に呼び出したり、外部ホストへ作業を差し戻してはなりません。
- **委譲ガイダンスとホスト機能**: サーバーは初期化時の instructions およびツール説明を通じて、ホストが Antigravity へタスクを委譲するよう誘導します。これは既定の運用方針を示すガイダンスであり、ホストが持つ他の組み込みツールを強制的に無効化するものではありません。

## 提供するツール

| MCP ツール             | 用途                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `antigravity_run`      | 新しい Antigravity 会話を開始します。CLI が返した場合は `conversation_id` も返します。                             |
| `antigravity_continue` | ID を指定して会話を継続します。ID を省略すると `agy` の直近の会話を継続します。                                    |
| `antigravity_models`   | `agy models` を実行して CLI の出力を返します。モデルターンは開始しませんが、Antigravity に接続する場合があります。 |

`run` と `continue` は、プロンプト、絶対パスのワークスペース、任意のモデル・effort、`plan` または `accept-edits` の mode、autonomy、実行期限を受け取ります。

### モデルの選定と優先順位

モデルの決定順序（優先順位）は以下の通りです：

1. ツール呼び出し時（`antigravity_run` / `antigravity_continue`）に明示された `model` 引数
2. サーバー環境変数 `AGY_MCP_DEFAULT_MODEL`（設定されている場合）
3. インストール済み `agy` CLI 自体の既定モデル（省略時）

利用可能なモデル slug は `antigravity_models` で事前に取得し、キャッシュまたは設定に利用してください。

### 安全性、ワークスペースの境界、ブリッジによるステータス分類

既定のリクエスト設定は `mode: "plan"` および `autonomy: "safe"` です。

- `safe` は `agy` で設定されたワークスペースの信頼とパーミッションを継承します。これは**読み取り専用を保証するものではありません**。
- ワーカーから返却される出力は未検証のエビデンスです。提案されたコマンドやファイル変更は適用前に確認してください。
- `mode`（`plan` または `accept-edits`）はエージェントへの意図伝達です。現在の headless モードでは、`--disable-slash-commands` 有効時に `--mode` が効果を持たない旨の警告が CLI から出力されます。したがって `mode` は意図を示すものであり、OS レベルのセキュリティ境界ではありません。
- `autonomy` はパーミッションの取り扱いを制御します：
  - `safe`（既定）: `agy` の信頼・パーミッション設定を継承します。
  - `sandbox`: CLI のターミナルサンドボックス制限を追加します。
  - `full`: CLI に `--dangerously-skip-permissions` を渡します。サーバー環境で `AGY_MCP_ALLOW_FULL_AUTONOMY=true` が設定されていない限り拒否されます。
- `AGY_MCP_ALLOWED_ROOT` を設定した場合、指定ルート配下の正規化パスのみをワークスペースとして許可します。これは**ワークスペースの選択のみを制限**するものであり、子プロセスのファイルシステムアクセスやネットワークアクセスを隔離（サンドボックス化）するものではありません。
- **ブリッジによるステータス分類**: 本ブリッジは CLI の出力エンベロープを解析し、適切なステータスに分類します：
  - `agy` が `SUCCESS` ステータスを返しても `denied_actions` が含まれている場合、ブリッジは結果を `status: "PERMISSION_DENIED"` に分類し、具体的な案内を提供するとともに出力メタデータ内に `denied_actions` 一覧を保持します。
  - `agy` が `SUCCESS` ステータスで空の応答本文を返した場合、ブリッジはこれを `status: "EMPTY_RESPONSE"` に分類し、再試行前にワークスペース内の変更（副作用）を確認するよう警告します。
  - _(注: これらは Antigravity CLI 自体が出力するステータスではなく、MCP ツールとしての安全な振る舞いを保証するために `agy-mcp` ブリッジ層が付与する分類です)_。

### 構造化指示パケット (Task Packet)

ホストが `antigravity_run` にタスクを委譲する際は、明確な構造化パケットを作成します：

```json
{
  "prompt": "【ゴール】JWT 認証ミドルウェアを実装する。\n【スコープ】変更対象は src/auth.ts および test/auth.test.ts のみ。設定ファイルは変更禁止。\n【制約・受入基準】TypeScript の strict 規約に準拠し、`pnpm test` で全テストが通ること。\n【返却エビデンス】変更したファイルパス一覧、テスト結果と終了コード、参照した外部 URL と要点。",
  "workspace": "/absolute/path/to/workspace",
  "mode": "accept-edits",
  "autonomy": "safe",
  "timeout_seconds": 600
}
```

## 並列実行、タイムアウト、境界のあるエラー復旧

既定では最大 4 件まで `agy` を並列実行できます（`AGY_MCP_MAX_CONCURRENT`）。

- `antigravity_models` を含む全コマンドが同時実行数に数えられます。上限超過時は待機キューに入らず、**即座に `BUSY` を返します**。
- 新規会話や異なる明示的な `conversation_id` のタスクは並列実行できます。
- 同じ会話 ID を指定した継続呼び出しは排他制御され、後からの呼び出しは即座に `BUSY` を返します。
- ID 省略の継続（`--continue`）はサーバーを占有し、他の実行がある場合は `BUSY` を返します。
- 排他制御と上限は 1 つのサーバープロセス内で有効です。ワークスペースのファイル、認証情報、CLI の状態は共有されるため、外部の別セッションが直近の会話を変更する可能性があります。
- `timeout_seconds` の既定値は 300 で、10〜3600 の整数を指定できます。ツールの期限が先に発効するよう、クライアント側のタイムアウトを少し長め（例: 3660 秒）に設定してください。
- 応答文字数は `AGY_MCP_MAX_OUTPUT_CHARS`（既定 40000、ホスト負荷軽減のため 16000 推奨）で制限されます。結果が切り詰められた場合はメタデータの `truncated` フラグを確認し、判断前に範囲を絞った追加ターンを要求してください。
- **`BUSY` への対処**: 短期間での連続再試行（リトライストーム）を避け、待機するか直列化して呼び出します。
- **タイムアウトおよび空応答 (`EMPTY_RESPONSE`) への対処**: 再試行前に `git status` でワークスペース内の変更（副作用）を確認してください。
- **`PERMISSION_DENIED` およびエラーへの対処**: 暗黙的にホスト側へ作業を巻き戻すのではなく、具体的なブロッカー（不足している権限設定など）をユーザーに報告します。

## 前提条件

- Node.js 22 以上
- pnpm 10 以上（このリポジトリは pnpm 10.18.1 を固定）
- `agy` が PATH にある、または `AGY_MCP_BIN` で実行ファイルを指定済み
- Antigravity が利用を許可しているワークスペース

公式ドキュメント参照先：

- [Antigravity CLI headless 公式ドキュメント](https://antigravity.google/docs/cli/headless/)
- [OpenAI Codex MCP 設定ドキュメント](https://developers.openai.com/codex/mcp/)
- [公式 TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## ソースから導入する

```bash
git clone https://github.com/Kaikei-e/agy-mcp.git
cd agy-mcp
pnpm install --frozen-lockfile
pnpm build
pnpm run doctor
```

`pnpm run doctor` はモデルターンを開始せずに、ワークスペースと `agy` CLI の動作要件を検証します。

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
      "args": ["/absolute/path/to/agy-mcp/dist/index.js"],
      "env": {
        "AGY_MCP_DEFAULT_WORKSPACE": "/absolute/path/to/workspace",
        "AGY_MCP_ALLOWED_ROOT": "/absolute/path/to",
        "AGY_MCP_MAX_CONCURRENT": "4",
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
args = ["/absolute/path/to/agy-mcp/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 3660

[mcp_servers.antigravity.env]
AGY_MCP_DEFAULT_WORKSPACE = "/absolute/path/to/workspace"
AGY_MCP_ALLOWED_ROOT = "/absolute/path/to"
AGY_MCP_MAX_CONCURRENT = "4"
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
  --env "AGY_MCP_MAX_CONCURRENT=4" \
  --env "AGY_MCP_MAX_OUTPUT_CHARS=16000" \
  -- "/absolute/path/to/node" "/absolute/path/to/agy-mcp/dist/index.js"
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

| 変数名                        | 既定値                     | 説明                                                                                       |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `AGY_MCP_BIN`                 | `agy`                      | CLI 実行ファイル名、または絶対パス・相対パス。                                             |
| `AGY_MCP_DEFAULT_WORKSPACE`   | サーバー実行時ディレクトリ | 既定のワークスペース。                                                                     |
| `AGY_MCP_ALLOWED_ROOT`        | 未設定                     | 選択可能なワークスペースを制限する正規化ルートディレクトリ。                               |
| `AGY_MCP_DEFAULT_MODEL`       | 未設定                     | 任意の既定モデル slug。優先順位: 個別引数 `model` > `AGY_MCP_DEFAULT_MODEL` > CLI 既定値。 |
| `AGY_MCP_MAX_CONCURRENT`      | `4`                        | 同時実行できる CLI プロセス数の上限（1〜32）。                                             |
| `AGY_MCP_MAX_OUTPUT_CHARS`    | `40000`                    | MCP 結果の最大文字数（1024〜1000000、ホスト負荷軽減のため 16000 を推奨）。                 |
| `AGY_MCP_MAX_BUFFER_BYTES`    | `8388608`                  | プロセスごとの stdout バッファ上限バイト数（1024〜67108864）。                             |
| `AGY_MCP_ALLOW_FULL_AUTONOMY` | `false`                    | `true` に設定すると `autonomy: "full"` の呼び出しを許可。                                  |

## 開発

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm format:check
```

Issue や PR を作成する前に [CONTRIBUTING.md](CONTRIBUTING.md) および [SECURITY.md](SECURITY.md) をご確認ください。本プロジェクトは [Apache License 2.0](LICENSE) の下で公開されています。
