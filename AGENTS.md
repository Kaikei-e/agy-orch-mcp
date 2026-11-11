# agy-first 運用方針

本プロジェクトおよび関連リポジトリでは、タスク実行の主力を Google Antigravity CLI（`agy`）とし、外部フロンティアモデルをオーケストレーターとする **agy-first** 体制を採用します。

## 役割分担 (Role Distinction)

- **外部フロンティアホスト (Frontier Orchestrator)**
  - 対象: Codex CLI / IDE や Claude Code などの外部ホスト環境。
  - 役割: 全体の方針決定、タスク分割（15 分以内の再開可能なターンを単位とした指示パケットの策定）、進捗管理、最終差分（`git diff`）および機械抽出されたコマンド実行台帳（`verified_outputs`）のレビューに専念します。
  - 原則: 外部ホスト自身が広範なリポジトリ調査、Web 検索、コード編集やテスト実行を直接行うことは避け、`agy-orch-mcp` を通じて agy に委譲します。

- **agy ワーカー (Execution Engine)**
  - 対象: `agy-orch-mcp` 経由で起動される Google Antigravity CLI (`agy`)。
  - 役割: リポジトリ調査、Web 仕様調査、実装、テスト作成・実行、自己修正（セルフテストと修正ループ）のすべてを担当します。
  - **重要（再帰・逆委譲の禁止）**: 委譲を受けた agy ワーカー自身は、提供されているネイティブツールを用いて自律的にタスクを完了します。自身から `agy-orch-mcp` を再帰的に呼び出したり、外部ホストへ作業を差し戻して（逆委譲して）はなりません。

## 指示パケット (Task Packet) の仕様

外部ホストが agy へタスクを委譲する際は、1 ターン 15 分の上限（`timeout_seconds` 既定・最大 900 秒）に収まる再開可能な単位に分割し、以下の構造化パケットを作成して渡します。

1. **ゴール (Goal)**: 達成すべき目的と作業範囲を明確に定義する。
2. **スコープとファイルの所有権 (Scope & File Ownership)**:
   - 変更を許可する対象ファイル・ディレクトリを明示する。
   - 変更を禁止するファイル（他のワーカーの担当範囲や設定ファイルなど）を明示し、並列作業時のファイル競合を防止する。
3. **制約条件・受入基準・テスト計画 (Constraints, Acceptance Criteria, Test Plan)**:
   - コーディング規約、安全要件、互換性、テストコマンド（例: `pnpm test`）を明示する。
   - `agy-orch-mcp --install-guard` によるガードフックが禁止シェル構文に対して書き換えヒントを返すため、禁止シェル文字の長い一覧をプロンプトに記載する必要はありません。「1 回の呼び出しにつき 1 つの単純なコマンドを実行すること」という助言のみ維持します。
4. **返却すべきコンパクトなハンドオフ (Compact Handoff & Evidence)**:
   - モデルの自己申告によるコマンド出力（Evidence）ではなく、結果に含まれる機械抽出された `verified_outputs`（コマンド・終了コード・出力末尾）を検証の根拠としてレビューします。
   - ワーカーには変更ファイル一覧、取得した外部 URL と事実、残存ブロッカーの簡潔な報告（または `return_mode: "structured"` による構造化 `handoff`）を求めます。

## agy 実行と並列・継続運用

- **初回セットアップ（ガードの導入）**:
  - `agy-orch-mcp --install-guard` を 1 度実行して `~/.gemini/config/hooks.json` にコマンドガードフックを導入し、`agy-orch-mcp --doctor` で状態とパーミッション監査を確認します（ブリッジ実行時の `AGY_ORCH_MCP_GUARD=1` のみで動作し、通常の agy セッションには影響しません）。
- **セルフテストと修正ループ**:
  - agy 内で実装・テスト・検証・修正まで自律的に完結させます。外部ホストは `verified_outputs` と最終差分の確認のみを行います。
- **会話の継続 (Continue)**:
  - `antigravity_continue` は同じ会話の直接の続き（直前のタスクへの追加修正・追質問、または `TIMEOUT` からの再開）にのみ使い、`antigravity_run` が返した `conversation_id` を必ず指定します。
  - 別の独立したタスクは、既存会話の流用ではなく新しい `antigravity_run` で開始します。`context.rotate_recommended` が `true` になった場合も、簡潔なハンドオフを添えて新しい `antigravity_run` を開始します。
- **並列化の使い分け (タスク種別で選ぶ)**:
  - **コード変更を伴う並列タスク**: `antigravity_batch` を使います。各タスクが独立した git worktree で実行され、`owns` の検証を経て `final.patch` として返るため、ワークスペースの競合が起きません。ホストのツール並列実行仕様にも依存しません（1 回のツール呼び出し内でサーバーが並列実行します）。ワーカーの 1 ターン上限は 900,000 ms（15 分）で、上限到達時は同じ worktree・同じ会話のまま自動再開されます（`max_worker_calls` に計上）。実行前にワークスペースがクリーンであることを確認してください。
  - **単発タスク・同一会話の続き**: `antigravity_run` → ID 明示の `antigravity_continue`。
  - **読み取り専用の調査や非重複スコープの並列化**: 異なる会話の `antigravity_run`（または異なる `conversation_id` の `antigravity_continue`）を同一ターン内で同時に発行します（サーバー既定で最大 8 件同時実行。スロット空き待ちには `queue_timeout_seconds` を使用）。
- **ホスト別の並列実行仕様**:
  - `antigravity_run` / `antigravity_continue` / `antigravity_batch` は、MCP ツールアノテーションとして `readOnlyHint: true, destructiveHint: false` を宣言しており、ホスト側スケジューラによる同一ターン内の並列ディスパッチを有効化しています（ワークスペースや権限の安全境界は `mode`、`autonomy`、`allowedRoot`、会話ロック、会話別環境分離、`antigravity_batch` の分離 worktree で保護されます）。
  - **Claude Code**: MCP の `annotations.readOnlyHint: true` を内部の `isConcurrencySafe()` 判定にマッピングするため、同一メッセージ内で複数の `antigravity_run` / `antigravity_continue`（別会話 ID）を発行するとそのまま並列実行されます。**並列化のためのリレー用サブエージェントは不要です**（アップグレード後は実行中サーバーがアノテーションを広告するよう `dist` を再ビルドしてください）。また、Claude Code は 2 分を超える MCP 呼び出しを自動的にバックグラウンドへ移行します（`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`）。
  - **Codex CLI / IDE**: MCP サーバー設定に `supports_parallel_tool_calls = true` を指定すると、同一ターン内の複数ツール呼び出しが並列実行されます。
- **モデルの選定とキャッシュ**:
  - サーバー既定モデルは `gemini-4-carbon-high`（`AGY_MCP_DEFAULT_MODEL`）、内部サブエージェント / Swarm ワーカーおよび `antigravity_batch` の `fast` ワーカー既定モデルは `gemini-4-argon-medium`（`AGY_MCP_SUBAGENT_MODEL` / `AGY_MCP_FAST_MODEL`）です。利用可能なモデル slug は事前に `antigravity_models` で確認・キャッシュして使用するか、サーバー既定値を利用し、モデル選定のための無駄なターン消費を抑えます。

## 境界のあるエラー復旧 (Bounded Recovery)

- **`BUSY` 応答時**:
  - 同時実行上限超過時は、`queue_timeout_seconds`（0〜900 秒）を指定して FIFO キューでスロット空きを待つか、直列化して呼び出します（短い間隔での連続リトライは行わない）。同一会話への重複呼び出しは即座に `BUSY` で拒否されます。
- **`TIMEOUT`（15 分ターン上限）時**:
  - 高速なフィードバックサイクルを保つため、1 ターンは最大 15 分（`--print-timeout` + 60 秒後強制終了）に制限されています。上限に達したターンは `status: "TIMEOUT"` とともに `resumable: true`、`conversation_id`、`partial_response`、`verified_outputs`、`workspace_changes`、`terminated_tasks`、`turn_seconds` を返します（`duration_seconds` は会話累積、`turn_seconds` が今ターンの経過時間）。最初からやり直すのではなく、報告された状態を確認して `antigravity_continue` で同じ会話を継続します。
- **空応答 (`EMPTY_RESPONSE`) 時**:
  - 作業ディレクトリに変更（副作用）が生じている可能性があるため、返却された `workspace_changes`（または `git status`）と `partial_response` を必ず確認してから継続・再試行します。
- **権限拒否 (`PERMISSION_DENIED`) やエラー時**:
  - `denied_commands`（最後のツール呼び出しのみの拒否も含む）と `workspace_changes` を確認し、許可された代替コマンドを明示して `antigravity_continue` するか、具体的なブロッカー（不足している `permissions.allow` ルールなど）をユーザーへ報告します。暗黙的に外部ホストへ作業を戻してホスト自身が代行してはなりません。

# 個人用 MCP クライアント設定

- agy をプロジェクトへ導入するときは、作成する個人環境に依存した `.mcp.json`、`.codex/`、`.claude/settings.local.json` を Git 管理しない。対象リポジトリの `.gitignore` に必要な明示ルールを追加し、`git check-ignore -v` と `git status --short` で除外と意図しない変更がないことを確認する。
