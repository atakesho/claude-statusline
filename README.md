# claude-statusline

Claude Code のステータスラインに、5時間枠・7日枠・モデル別7日枠 (Fable など) の使用率をバー表示する。

```
🤖 Fable 5.1 | 📊 3% | ✏️ +0/-0 | 🔀 main
⏱ 5h  ▰▰▰▰▰▱▱▱▱▱  52%  Resets 9pm (JST)
📅 7d  ▰▰▱▱▱▱▱▱▱▱  20%  Resets Sep 11 at 2pm (JST)
🧠 7d Fable  ▰▰▰▱▱▱▱▱▱▱  39%  Resets Sep 11 at 2pm (JST)
```

## 必要なもの

- Claude Code を claude.ai アカウント (Pro/Max) でログイン済みであること。API キー運用では使用率が取れない
- `jq` と `curl` (`brew install jq`)
- macOS は Keychain、Linux は `~/.claude/.credentials.json` から OAuth トークンを読む

## インストール

```
git clone <このリポジトリ> && cd claude-statusline
bash install.sh
```

`install.sh` は `~/.claude/statusline-command.sh` を配置し、`~/.claude/settings.json` の `statusLine` を書き換える。既存の statusLine 設定は上書きされる。

## 仕組み

- 1行目は Claude Code が渡す JSON (モデル名・コンテキスト使用率・追加/削除行数・git ブランチ)
- 2行目以降は `https://api.anthropic.com/api/oauth/usage` の結果。360秒キャッシュ (`$TMPDIR/claude-usage-cache.json`)
- モデル別枠は `limits[]` の `kind == "weekly_scoped"` を全部出す。将来モデルが増えても行が自動で増える
- 色は 50% 以上で黄、80% 以上で赤
- リセット時刻は端末のローカルタイムゾーンで表示する

## セキュリティ

- OAuth トークンは Keychain (または `~/.claude/.credentials.json`) から読み、`https://api.anthropic.com` にだけ送る。ログや画面には出さない
- キャッシュファイルには使用率の数値のみ保存し、トークンは含めない。パーミッションは 600
- 外部依存は jq と curl のみ。`curl | bash` 形式の導線は用意していないので、中身を読んでから `install.sh` を実行してほしい
