# claude-statusline

Claude Code のステータスラインに、5時間枠・7日枠・モデル別7日枠 (Fable など) の使用率をバー表示する。Windows / macOS / Linux 対応。

```
🤖 Fable 5.1 | 📊 3% | ✏️ +0/-0 | 🔀 main
⏱️ 5h  ▰▰▰▰▰▱▱▱▱▱  52%  Resets 11:30am (Asia/Tokyo)
📅 7d  ▰▰▱▱▱▱▱▱▱▱  20%  Resets Sep 11 at 2pm (Asia/Tokyo)
🧠 7d Fable  ▰▰▰▱▱▱▱▱▱▱  39%  Resets Sep 11 at 2pm (Asia/Tokyo)
```

## 必要なもの

- Claude Code を claude.ai アカウント (Pro/Max) でログイン済みであること。API キー運用では使用率が取れない
- Node.js 18 以降（Claude Code の実行に必要なので通常は入っている）
- bash 版を使う場合のみ `jq` と `curl`

## インストール

### Windows

```powershell
git clone https://github.com/atakesho/claude-statusline.git
cd claude-statusline
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### macOS / Linux

```bash
git clone https://github.com/atakesho/claude-statusline.git && cd claude-statusline
bash install.sh
```

`install.sh` は Node があれば Node 版、無ければ bash 版を選ぶ。`--node` / `--shell` で明示指定できる。

どちらもスクリプトを `~/.claude/` にコピーし、`~/.claude/settings.json` の `statusLine` だけを書き換える。**書き換え前に `settings.json.bak-<日時>` を作る**。他のキー（hooks、model、permissions 等）には触れない。

```
--dry-run     何が変わるか表示するだけで書き込まない
--uninstall   statusLine 設定・配置したスクリプト・キャッシュを削除する
--node-path   settings.json に node の絶対パスを書く（PATH が違う環境向け）
--force       --uninstall 時、他ツールの statusLine でも消す
```

Windows は `.\install.ps1 -DryRun` / `-Uninstall` / `-NodePath` / `-Force`。

`--uninstall` は既定で**自分が入れた statusLine かどうかを確認し、他ツールのものなら消さずに止まる**。

## 2つの実装

| | `statusline-command.js` | `statusline-command.sh` |
|---|---|---|
| 対応 OS | Windows / macOS / Linux | macOS / Linux |
| 必要なもの | Node.js 18+ | jq, curl, bash |
| プロキシ | `HTTPS_PROXY` を自前で解釈（CONNECT トンネル） | curl が自動で解釈 |
| 位置づけ | リファレンス実装 | Node が無い環境向けフォールバック |
| 自動テスト | `node test/smoke.js`（13件） | なし |

<a name="parity"></a>出力とキャッシュ形式は同一。**片方を直したらもう片方も直すこと**。`node test/smoke.js` で JS 版の描画・サニタイズ・キャッシュ処理を検証できる（ネットワーク不要）。

## 仕組み

- 1行目は Claude Code が渡す JSON（モデル名・コンテキスト使用率・追加/削除行数・git ブランチ）。コンテキスト 70% で `⚠️ CONTEXT HIGH`、85% で `🔥 COMPACT IMMINENT` を追加する
- ブランチ名は `git` を起動せず `.git/HEAD` を直接読む。Claude Code は操作のたびにステータスラインを再描画するので、毎回のプロセス生成を避けている（worktree・submodule の `gitdir:` 形式にも対応）
- 2行目以降は `https://api.anthropic.com/api/oauth/usage` の結果。360秒キャッシュ
- モデル別枠は `limits[]` の `kind == "weekly_scoped"` を全部出す。将来モデルが増えても行が自動で増える
- 色は 50% 以上で黄、80% 以上で赤
- リセット時刻は端末のローカルタイムゾーン。ちょうどの時刻でなければ分まで出す（5時間枠は :30 リセットが多い）
- API に届かないときは直前の数値を最大1時間まで表示し、それも無ければ1行目だけ出す
- 取得に失敗したらバックオフする。401/403（トークン失効）は1時間、通信エラーは60秒は再取得しない。失効したトークンで毎回叩き続けない
- モデル別枠は最大8件まで。5h・7d・1行目と合わせて**最大11行**になりうる
- キャッシュは `~/.claude/` に書く。そこが書けない場合（OneDrive 同期でロックされる等）だけ一時ディレクトリへ退避する。退避先にも数値しか書かない

## 環境変数

| 変数 | 既定 | 内容 |
|---|---|---|
| `CLAUDE_STATUSLINE_NO_USAGE` | 未設定 | 使用率の行を出さない（API を叩かない） |
| `CLAUDE_STATUSLINE_ASCII` | 未設定 | 絵文字とバー記号を ASCII に落とす |
| `NO_COLOR` | 未設定 | 色を付けない |
| `CLAUDE_STATUSLINE_CACHE_TTL` | 360 | キャッシュ有効秒数 |
| `CLAUDE_STATUSLINE_STALE_MAX` | 3600 | API 失敗時に古い値を使う上限秒数 |
| `CLAUDE_STATUSLINE_TIMEOUT_MS` | 3000 | API タイムアウト（bash 版は `..._TIMEOUT_SEC`、既定5） |
| `CLAUDE_STATUSLINE_CA` | 未設定 | TLS 検査プロキシ用の追加 CA ファイル（JS 版のみ） |
| `CLAUDE_STATUSLINE_DEBUG` | 未設定 | 失敗理由を stderr に1行出す。stdout は汚さない（JS 版のみ） |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | 認証情報とキャッシュの置き場所 |

## 社内プロキシ環境

**環境変数の `HTTPS_PROXY` / `NO_PROXY` しか見ない。** PAC ファイルや WinHTTP 設定だけでプロキシを構成している環境（環境変数を置かない方式）には対応していない。その場合は Claude Code を起動するシェルで `HTTPS_PROXY` を設定する。Node の `https` は環境変数を自動では読まないので、JS 版は自前で CONNECT トンネルを張っている。プロキシ認証は URL の `user:pass@` から Basic ヘッダを組み立てる。

TLS を検査するプロキシ（社内 CA で証明書を差し替えるタイプ）の場合、検証に失敗して使用率の行だけが消える。その環境では社内 CA の PEM を `CLAUDE_STATUSLINE_CA` に指定する。**証明書検証を切る選択肢は用意していない**（下記）。

<a name="security"></a>
## セキュリティ

このスクリプトは OAuth トークンを読んで送信するので、次を守っている。

- **送信先を固定**: トークンは `https://api.anthropic.com` にだけ送る。ホストはコード内でハードコードしていて、レスポンスやリダイレクトで変わらない
- **証明書検証を必ず有効化**: 各接続に `rejectUnauthorized: true` を明示するので、環境に `NODE_TLS_REJECT_UNAUTHORIZED=0` が設定されていても検証される。JS 版は起動時にこの変数を自分の環境から削除もする。プロキシへの CONNECT も検証付き。期限切れ・自己署名・ホスト名不一致の証明書がプロキシ経由でも拒否されることは実測で確認済み
- **期限切れトークンを送らない**: `expiresAt` を見て、切れていれば送信自体をやめる
- **トークンをディスクに書かない**: キャッシュには表示する数値だけを入れる。トークン・リフレッシュトークンは一切通さない
- **キャッシュの置き場所**: `/tmp` ではなく `~/.claude/`（本人所有）に置く。共有 `/tmp` でのシンボリックリンク攻撃を避けるため。書き込みは 0600 で一時ファイル→rename（rename はシンボリックリンクを辿らず置き換える）。Windows の NTFS では 0600 のビットは効かないが、キャッシュにトークンは入らない
- **キャッシュを信用しない**: ディスク上のキャッシュは自分が書いたものでも外部入力として再検証・再サニタイズしてから表示する
- **シェルを介さない**: `git` や `security` の呼び出しに文字列連結を使わない（引数配列で `execFileSync`）。パスに空白や引用符が入っても壊れないし、コマンドインジェクションにならない
- **端末エスケープの無害化**: stdin・git・API・キャッシュから来た文字列は制御文字を除去してから表示する。ステータスラインは毎回描画されるので、ここに ANSI エスケープが混ざると端末が乗っ取られうる
- **設定ファイルを壊さない**: インストーラは `settings.json` をバックアップしてから `statusLine` キーだけを書き換える。JSON として壊れていれば何も書かずに止まる
- **外部依存ゼロ**: npm パッケージを入れない。JS 版は Node 標準モジュールだけ、bash 版は jq と curl だけ
- `curl | bash` 形式の導線は用意していない。中身を読んでから実行してほしい

## トラブルシュート

**1行目しか出ない**

```bash
echo {} | node ~/.claude/statusline-command.js   # Windows: node "$env:USERPROFILE\.claude\statusline-command.js"
```

で確認する。原因はだいたい次のどれか。

- claude.ai アカウントでログインしていない（API キー運用では使用率が存在しない）
- 社内プロキシ配下で `HTTPS_PROXY` が Claude Code のプロセスに渡っていない
- TLS 検査プロキシで証明書検証に失敗している → `CLAUDE_STATUSLINE_CA`
- トークンが失効している（ログイン済みに見えても API は 401 を返す）→ Claude Code で再ログイン

`CLAUDE_STATUSLINE_DEBUG=1` を付けると失敗理由が stderr に出る。

**`node` が見つからない / 何も出ない**: Claude Code がステータスラインを起動するときの PATH に `node` が無い可能性がある。`--node-path`（Windows は `-NodePath`）で入れ直すと絶対パスが書き込まれる。

**バーが四角や文字化けで出る**: 端末のフォントが `▰▱` を持っていない。`CLAUDE_STATUSLINE_ASCII=1` を設定する。

**ステータスラインが遅い**: `CLAUDE_STATUSLINE_TIMEOUT_MS` を下げる。キャッシュが効いている間（既定360秒）は API を叩かない。

## ライセンス

MIT
