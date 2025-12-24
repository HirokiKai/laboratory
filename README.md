# laboratory

実験・検証用の小さなプロジェクトをまとめたリポジトリです。主に X（旧Twitter）向けの Chrome 拡張と、簡易な静的サイトが入っています。

## Contents
- `gemini-oneword/`: X の日本語投稿を「ひとこと要約」に置き換える拡張
- `gemini-rert/`: X のリプライ/引用RTの下書きを Gemini で自動生成する拡張
- `gemini-translator/`: X の英語投稿を日本語に自動翻訳する拡張
- `x_anonymous_extension/`: X のアバター/ユーザー名を匿名化（ぼかし・ランダム）する拡張
- `docs/`: 静的サイト（ポートフォリオ/作品一覧ページ）と関連アセット

## Chrome拡張のインストール方法（4フォルダ共通）
1. Chrome を開き、拡張機能管理ページへ移動: `chrome://extensions/`
2. 右上の「デベロッパー モード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. 対象フォルダ（例: `gemini-oneword/` など）を選択

### Gemini系拡張の初期設定
- `gemini-oneword/`: 拡張の詳細画面から「オプション」を開き、API Key とモデルを設定
- `gemini-rert/` と `gemini-translator/`: X 上に表示されるパネル内で API Key とモデルを入力

※ Gemini API キーが必要です。

## Notes
- それぞれの仕様詳細は各フォルダ内の `manifest.json` や `SPEC.md`（ある場合）を参照してください。
