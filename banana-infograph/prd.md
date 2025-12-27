# NanoBanana Infograph 詳細設計書 (PRD兼用)

## 1. ゴールと価値指標
- ゴール: X(Twitter)投稿文から正方形インフォグラフィックを自動生成し、投稿エディタへ即添付して投稿準備を完了させる。
- 指標: 生成成功率/投稿完了率、生成〜添付時間、APIキー設定完了率、画像品質満足度（簡易NPS）、エラー率。

## 2. 対象ユーザーと主要ユースケース
- ユーザー: SNS運用担当・個人クリエイター（デザイン工数を減らしたい層）。
- ユースケース: 投稿文入力後に🍌ボタンで1クリック生成→自動添付→投稿確認。

## 3. システム構成
- ブラウザ: Chrome/Edge, Manifest v3 拡張。
- 構成要素:
  - `content.js`: X上のUI挿入・投稿テキスト取得・ファイル添付・ユーザー操作。
  - `background.js`: Gemini API呼び出し、Base64受け渡し。
  - `options.html/js`: APIキー設定ページ。
  - アイコン: `icons/`。
- 権限: `storage`, `https://generativelanguage.googleapis.com/*`。

## 4. データフロー
1) 投稿文取得: `content.js` が `tweetTextarea_0` から text を抽出（空欄時はエラー）。
2) 生成要求: `chrome.runtime.sendMessage({type:'generateInfograph', text})` を SW に送信。
3) 画像生成: `background.js` が Gemini 3 Pro Image Preview API (`responseModalities: IMAGE`, `imageConfig.imageSize: 1K`) を呼ぶ。プロンプトは `{text}` を投稿文で置換。
4) 結果受信: Base64 + mimeType + fileName を content に返却。
5) 添付: content が Base64→File 化し、`input[data-testid="fileInput"]` に `DataTransfer` でセットし `change` 発火。
6) ユーザー通知: トーストで進行/成功/失敗を表示。

## 5. UI/UX仕様
- ツールバー: X の投稿画面 `toolBar` に🍌ボタン挿入。クリックで生成。
- パネル: 右上固定 320px（展開時）。機能: APIキー入力、プロンプト編集/保存/リセット。最小化時は56px丸アイコンでドック表示。ドラッグ移動可。状態は `chrome.storage.local`。
- トースト: 右上近辺に3秒表示。成功は黄ライン、失敗は赤ライン。
- 文言: 現在日本語。英語は未対応（拡張案）。

## 6. プロンプト仕様
- デフォルト: バナナイエロー×ダークネイビー、丸めサンセリフ太字、大見出し+3箇条書き+右下アイコン、余白重視、1:1画像のみ。
- 置換: `{text}` に投稿文を埋め込む。カスタムプロンプト保存可。Resetでデフォルト復元。

## 7. エラーハンドリング
- APIキー未設定: content→SW応答で `APIキーを設定してください` を表示。
- HTTP/生成失敗: ステータス/メッセージをトースト表示。再試行はボタン再押下。
- 画像欠落: `画像が返ってきませんでした` エラー。
- DOM要素未取得: fileInput/textarea が無い場合は黙殺せずトーストで通知する拡張余地。

## 8. 非機能要件
- レイテンシ: 生成〜添付 ≤10s（ネット依存）。
- 安全: APIキーは `chrome.storage.local` に平文保存、送信先は Google API のみ。
- 互換性: X DOM の `data-testid` 変化に弱い。フォールバックセレクタ追加を推奨。
- アクセシビリティ: キーボード操作・SR配慮は未実装。

## 9. 既知リスク / 技術負債
- `background.js` に `b64ToFile` 未定義コメントが残存（処理はcontent側で完結。整理要）。
- `data-testid` 依存によるDOM変更脆弱性。
- リトライ/レート制御なし。画像安全性チェックなし（Gemini任せ）。

## 10. 拡張アイデア
- 生成プレビューと再生成、複数バリエーション選択。
- プロンプトプリセット管理/共有。
- 英語UI切替、多言語ヘルプ。
- DOMセレクタのフォールバック探索と監視。
- APIキー暗号化保存検討、失敗時自動リトライ、簡易レート制御。

## 11. マイルストーン案
1) バグ/整合性: `b64ToFile` コメント整理、エラーメッセージ精緻化、DOMセレクタ強化。
2) UX: 生成プレビュー、ロードインジケータ強化、再生成ボタン。
3) i18n: 英語UI/文言切替。
4) 安全性: レート制御・リトライ、キー保存方式の強化検討。
