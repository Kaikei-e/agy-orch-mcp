# agy-orch-mcp 設計ドキュメント・実装意図・今後の予定

本ドキュメントは、Google Antigravity CLI (`agy`) を外部の MCP（Model Context Protocol）クライアントから実行エンジンとして活用するためのローカル連携ブリッジ `agy-orch-mcp` の設計思想、アーキテクチャ、実装意図、および検証結果をまとめたものです。

---

## 1. 目的と agy-first 運用体制

`agy-orch-mcp` は、Codex CLI / IDE や Claude Code などの外部フロンティアホスト環境とローカルの `agy` を stdio 経由で接続し、効率的かつ安全なタスク委譲を実現する Model Context Protocol サーバーです。

### 役割分担の原則

- **外部フロンティアホスト（オーケストレーター）**:
  高レベルのタスク分解、方針決定、明確な指示パケットの策定、およびワーカーから返却された最終差分（diff）やエビデンスのレビューを担当します。ホスト自身が広範なリポジトリ走査やファイル編集を直接行うことは避け、作業を委譲します。
- **Antigravity CLI ワーカー（実行エンジン）**:
  `agy-orch-mcp` 経由で呼び出されるローカルの `agy` が、コードベース調査、Web 仕様調査、実装、テスト作成・実行、セルフ修正ループを担当します。
- **再帰・逆委譲の禁止**:
  委譲を受けた agy ワーカーは、利用可能なネイティブツールを直接使用して作業を完結させます。自身から `agy-orch-mcp` を再帰的に呼び出したり、外部ホストへ作業を差し戻してはなりません。

---

## 2. サーバーアーキテクチャとモジュール構成

`agy-orch-mcp` は TypeScript で実装され、公式の `@modelcontextprotocol/server` SDK を利用した stdio 通信ベースの単一プロセスサーバーとして動作します。

### データフロー

```text
[MCP Client (Codex / Claude Code)]
             │
             ▼ (stdio: JSON-RPC)
     [src/index.ts] (CLI エントリポイント)
             │
             ▼
    [src/server.ts] (McpServer, instructions, ツールハンドラ)
             │
             ├──▶ [src/config.ts] (環境変数・ワークスペース検証)
             ├──▶ [src/policy.ts] (モデル slug 構文検証)
             │
             ▼
     [src/agy.ts] (引数構築, 子プロセス実行依頼)
             │
             ▼
   [src/process.ts] (子プロセス起動, 並列スロット制御, 会話UUIDロック)
             │
             ▼
   [Antigravity CLI (`agy`)] (ローカル子プロセス実行)
             │
             ▼ (stdout: stream-json イベントストリーム)
   [src/process.ts] (プロセス監視・バッファ収集・終了判定)
             │
             ▼ (stdout 文字列)
     [src/agy.ts] (出力パース・ステータス分類判定)
             │
             ▼ (RunResult オブジェクト)
    [src/result.ts] (文字数制限・メタデータ付与・ToolResult 整形)
             │
             ▼ (stdio: JSON-RPC Result)
       [MCP Client]
```

### モジュール一覧と責務

| モジュール                            | 責務                                                                                                      | 関連テスト・ドキュメント                            |
| :------------------------------------ | :-------------------------------------------------------------------------------------------------------- | :-------------------------------------------------- |
| [`src/index.ts`](../src/index.ts)     | サーバー起動、stdio トランスポート接続、致命的エラー捕捉                                                  | [`README.md`](../README.md)                         |
| [`src/server.ts`](../src/server.ts)   | MCP 初期化時の `instructions` 設定、ツールの登録・ディスパッチ、進捗通知・ハートビート管理                | [`test/mcp.test.mjs`](../test/mcp.test.mjs)         |
| [`src/config.ts`](../src/config.ts)   | 環境変数の解決・数値境界チェック、ワークスペースの正規化とルート制限                                      | [`test/core.test.mjs`](../test/core.test.mjs)       |
| [`src/policy.ts`](../src/policy.ts)   | モデル slug の安全検証（ハイフン先頭禁止、空白・NUL除外）                                                 | [`test/policy.test.mjs`](../test/policy.test.mjs)   |
| [`src/agy.ts`](../src/agy.ts)         | CLI 引数の組み立て、JSON/stream-json 出力解析、ステータス分類 (`PERMISSION_DENIED` / `EMPTY_RESPONSE` 等) | [`test/core.test.mjs`](../test/core.test.mjs)       |
| [`src/process.ts`](../src/process.ts) | `agy` の子プロセス管理、プロセスグループ終了、同時実行スロット制御、UUID 会話ロック                       | [`test/process.test.mjs`](../test/process.test.mjs) |
| [`src/result.ts`](../src/result.ts)   | `structuredContent` および text の生成、`maxOutputChars` に基づく安全な切り詰めとメタデータ保持           | [`test/core.test.mjs`](../test/core.test.mjs)       |
| [`src/version.ts`](../src/version.ts) | パッケージバージョン定義                                                                                  | [`package.json`](../package.json)                   |

---

## 3. 指示パケット、会話再利用、並列実行

### 構造化指示パケット (Task Packet)

曖昧さを防ぎ、最小限のターンでタスクを完了させるため、ホストは以下の構造で `antigravity_run` を呼び出します：

1. **ゴール (Goal)**: 達成すべき目的と作業範囲
2. **スコープとファイルの所有権 (Scope & File Ownership)**: 編集を許可するファイルと、触れてはならないファイルの明示
3. **制約条件とテスト計画 (Constraints & Test Plan)**: コーディング規約、必須テストコマンド（例: `pnpm test`）
4. **返却すべきエビデンス (Compact Evidence)**: 変更したファイル一覧、テスト結果と終了コード、参照した外部 URL と要点、残存課題

### 会話 ID の再利用と並列化の境界条件

- **継続実行**: 関連する修正や後続タスクでは、`antigravity_run` が返した `conversation_id` を明示して `antigravity_continue` を使用します。これにより、コンテキストの重複送信を抑制し一貫した作業を継続できます。
- **並列実行の安全要件**:
  並列実行は、**互いに重複しない独立したファイルまたは worktree を各タスクに割り当てる場合にのみ安全**です。サーバープロセスが管理する会話ロック（UUID）や並列スロット（`AGY_MCP_MAX_CONCURRENT`、既定 4）はプロセス内の競合を防ぐものであり、ワークスペースのファイル、認証情報、および CLI の内部状態はすべて共有されます（ファイルシステムの自動分離や worktree の自動生成機能はありません）。
- **同時実行制限と `BUSY`**:
  `antigravity_models` を含むすべてのコマンドがサーバーの同時実行枠を消費します。上限超過時、または同一会話 ID の重複継続時は、リクエストがキューイングされず**即座に `BUSY` で拒否**されます。呼び出し元は短期間での連続再試行（リトライストーム）を避け、待機または直列化して呼び出す必要があります。

---

## 4. 実装された変更点と設計意図

| 変更項目                                               | 設計意図 (Why)                                                                                                                                                                                                                                                 | 検証内容 (Verification)                                                                                                                                                                                             |
| :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MCP 初期化時 `instructions` の提供**                 | MCP プロトコルの正式な初期化フィールドを用いて、クライアント接続時にサーバー全体の方針（agy-first の委譲ルール、再帰禁止）を提示するため。ツール説明文（`description`）にも補完的に記述。※ホストの既存ツールを強制無効化するものではなくガイダンスとして機能。 | [`test/mcp.test.mjs`](../test/mcp.test.mjs) にて legacy および modern（2026-07-28）両世代の MCP クライアントが初期化時に instructions 文字列を受信することを確認。                                                  |
| **`AGY_MCP_DEFAULT_MODEL` の導入と優先順位**           | 毎回モデル slug を指定する負荷を減らしつつ、プロジェクトや環境ごとの既定モデル設定を可能にするため。優先順位は「個別呼び出し `model` 引数 > 環境変数 `AGY_MCP_DEFAULT_MODEL` > CLI 自体の既定値」として厳格に解決。                                            | [`test/core.test.mjs`](../test/core.test.mjs)（設定読込）と [`test/policy.test.mjs`](../test/policy.test.mjs)（構文検証）に加え、[`test/mcp.test.mjs`](../test/mcp.test.mjs) にて実プロセスへの引数優先順位を検証。 |
| **ブリッジによるステータス分類 (`PERMISSION_DENIED`)** | `agy` CLI が `SUCCESS` 終了であっても未許可のアクション（`denied_actions`）を検出した場合、呼び出し元に失敗を明示し、誤った正常完了判定を防ぐため。同様に本文が空の成功は `EMPTY_RESPONSE` に分類。※CLI 本体のステータスではなくブリッジ層の合成分類。         | [`test/process.test.mjs`](../test/process.test.mjs)（プロセス出力）および [`test/mcp.test.mjs`](../test/mcp.test.mjs)（MCP 応答分類・メタデータ保持）にて網羅的に検証。                                             |
| **出力長上限 (`AGY_MCP_MAX_OUTPUT_CHARS`) と切り詰め** | CLI の大量の標準出力をそのまま返すとホストのコンテキストウィンドウを圧迫するため、既定 40,000 文字（16,000 文字を推奨）で安全に切り詰め、`truncated` メタデータを付与。                                                                                        | [`test/core.test.mjs`](../test/core.test.mjs) にて、巨大な出力が境界値内で正しく切り詰められ、JSON 構造が壊れないことを検証。                                                                                       |

---

## 5. 設定と運用の制約事項

設定可能な全環境変数の一覧、既定値、および設定例については [`README.ja.md#設定一覧`](../README.ja.md#設定一覧) を参照してください。本節では運用上の重要制約を記述します。

- **ワークスペース制限とサンドボックス**:
  `AGY_MCP_ALLOWED_ROOT` は、指定ディレクトリ配下にワークスペースの正規化パスを制限する**選択境界の制約**です。子プロセスのファイルシステムアクセスやネットワーク通信を隔離する OS レベルのサンドボックスではありません。
- **実行モードとセキュリティ境界**:
  `mode: "plan"` または `mode: "accept-edits"` はモデルへの意図伝達です。現在の Antigravity CLI では `--disable-slash-commands` 有効時に `--mode` が効果を持たない旨の警告が出力されるため、セキュリティ境界として依存してはなりません。権限管理は `autonomy` フラグ（`safe` / `sandbox` / `full`）で行います。
- **パーミッションの継承**:
  既定の `autonomy: "safe"` は Antigravity CLI 側で設定された信頼・承認ルールを継承します。読み取り専用を保証するものではありません。
- **タイムアウト設定**:
  `timeout_seconds`（既定 300、範囲 10〜3600）はサーバー側のプロセス実行期限です。クライアント側の通信タイムアウト（例: Codex の `tool_timeout_sec = 3660`）は、サーバー側の期限より必ず長く設定してツールのタイムアウト判定が先に発効するようにします。
- **個人用設定ファイルの保護**:
  `.mcp.json` や `.codex/`、`.claude/settings.local.json` などの環境依存設定は Git 管理対象から除外し、`.gitignore` に登録して管理します。

---

## 6. テスト構成と検証状況

本リポジトリでは Node.js ネイティブテストランナー（`node --test`）を使用し、モックフィクスチャ（[`test/fixtures/agy.mjs`](../test/fixtures/agy.mjs)）を介して `agy` CLI の様々な挙動を網羅的に検証しています。

- **[`test/core.test.mjs`](../test/core.test.mjs)**:
  環境変数読み込み、数値境界チェック、パス正規化、引数構築、JSON/stream-json 出力解析、文字数制限と切り詰めの検証。
- **[`test/policy.test.mjs`](../test/policy.test.mjs)**:
  モデル slug のバリデーションルール（長さ、空白、特殊文字、先頭ハイフン）の単体テスト。
- **[`test/process.test.mjs`](../test/process.test.mjs)**:
  子プロセスのライフサイクル、タイムアウト時のプロセスグループ強制終了、キャンセル処理、同時実行スロット制御、UUID 会話ロックの排他検証、および拒否アクションの検出。
- **[`test/mcp.test.mjs`](../test/mcp.test.mjs)**:
  MCP サーバーとしての自動化結合テスト。stdio 経由でのクライアント接続、legacy および modern（2026-07-28）プロトコル交渉、`instructions` の取得、モデル優先解決、ステータス分類（`PERMISSION_DENIED` / `EMPTY_RESPONSE`）、進捗通知の検証。

### 検証エビデンス（実装完了）

- 型検査: `pnpm check`（終了コード 0、型エラーなし）
- 自動テスト: `pnpm test` にて **全 31 件のテストが通過**（31 passed, 0 fail、実行時間 約 4.4 秒）
- フォーマット検査: `pnpm exec prettier --check src test`（通過）
- 差分検査: `git diff --check`（空白・構文エラーなし）

※ なお、上記自動テストはフィクスチャを用いた MCP クライアントとの通信テストであり、実環境の外部 MCP クライアント（Codex / Claude Code）による新 `instructions` の読み込みは後続のクライアント再起動運用にて確認します。

---

## 7. 現在のステータスと直近の予定 (今後のステップ)

### 完了した項目 (Completed)

- [x] MCP 初期化時 `instructions` およびツール説明文のポリシー実装と自動テスト
- [x] `AGY_MCP_DEFAULT_MODEL` 環境変数によるモデル既定値と優先順位解決の実装
- [x] ブリッジ層における `PERMISSION_DENIED` および `EMPTY_RESPONSE` ステータス分類の実装
- [x] 全 31 件の自動テスト通過および型チェック（`pnpm check`）、フォーマット確認
- [x] 変更差分の最終コードレビューと `git diff --check` の通過確認
- [x] agy-first 運用ポリシー、設定テンプレート、および本設計ドキュメントの整備

### 残る実運用ステップ (Operational Next Steps)

1. **設計ドキュメントおよびテンプレートの参照**:
   プロジェクトごとの運用方針策定時に [`docs/design.ja.md`](design.ja.md) および [`examples/AGENTS.md`](../examples/AGENTS.md) を確認・活用。
2. **既存 MCP クライアントの再起動**:
   サーバーが提供する新しい初期化 `instructions` や環境変数を読み込ませるため、Codex CLI / IDE または Claude Code のセッションを再起動。
3. **実環境スモークテスト（任意）**:
   実際の `agy` アカウント・クォータを用いた疎通確認が必要な場合、手動で `pnpm run probe` を実行（※自動 CI / テストスイートには含まれません）。
4. **Git コミットおよび公開（将来の任意アクション）**:
   ユーザーまたはメンテナの指示に応じて、必要となった段階でコミットやリリース作業を実施（※現時点でのスケジュールや約束事項ではありません）。
