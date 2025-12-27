# Gemini Extensions - 統一UIデザインシステム

## 概要
Gemini拡張機能群（Translator、ReRT、1word）の統一UIデザインシステム仕様書

---

## 🎨 カラーパレット

### プライマリカラー
```css
--text-primary: #0f1419;        /* メインテキスト */
--accent-green: #2ecc71;         /* 有効状態・アクセント */
--link-blue: #1d9bf0;            /* リンク・フォーカス */
```

### セカンダリカラー
```css
--border-light: #cfd9de;         /* ボーダー */
--bg-card: #f7f9f9;              /* カード背景 */
--bg-hover: rgba(0,0,0,0.05);    /* ホバー背景 */
--bg-white: #ffffff;             /* パネル背景 */
```

### ステータスカラー
```css
--error-red: #f4212e;            /* エラー */
--success-green: #00ba7c;        /* 成功 */
--text-muted: #536471;           /* 補足テキスト */
```

---

## 📐 レイアウト & スペーシング

### パネル共通仕様
```css
width: 300px;
max-height: 80vh;
border-radius: 16px;
background-color: #ffffff;
box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 15px, 
            rgba(101, 119, 134, 0.15) 0px 0px 3px 1px;
```

### 内部スペーシング
```css
ヘッダー padding: 12px 16px 8px 16px;
ボディ padding: 16px;
セクション間マージン: 20px;
小要素間マージン: 12px - 15px;
```

### 最小化アイコン
```css
width: 56px;
height: 56px;
border-radius: 12px;
border: 2px solid transparent;    /* デフォルト */
border: 2px solid #2ecc71;        /* 有効時 */
box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 8px,
            rgba(101, 119, 134, 0.25) 0px 1px 3px 1px;
```

---

## 🔘 ボタンスタイル

### プライマリボタン（保存など）
```css
background-color: #0f1419;
color: white;
border: none;
padding: 12px;
border-radius: 9999px;            /* 完全な角丸 */
font-weight: 700;
font-size: 14px;
cursor: pointer;
transition: background 0.2s;
```

### セカンダリボタン（設定トグルなど）
```css
background: transparent;
border: 1px solid #cfd9de;
padding: 8px 12px;
border-radius: 10px;
font-weight: 700;
font-size: 13px;
cursor: pointer;
transition: background 0.2s, border-color 0.2s;
```

### 最小化ボタン
```css
position: absolute;
top: 8px;
right: 8px;
width: 32px;
height: 32px;
background: rgba(0,0,0,0.05);
border: none;
border-radius: 50%;
cursor: pointer;
transition: background 0.2s;
```

---

## 📝 フォーム要素

### Input / Select / Textarea 共通
```css
width: 100%;
border: 1px solid #cfd9de;
border-radius: 8px;
padding: 10px 12px;
font-size: 14px;
color: #0f1419;
box-sizing: border-box;
outline: none;
transition: border 0.2s;
```

### Focus状態
```css
border-color: #1d9bf0;
```

### Select専用
```css
appearance: none;
-webkit-appearance: none;
background-color: white;
cursor: pointer;
/* ドロップダウン矢印はSVGで実装 */
```

### トグルスイッチ
```css
/* ベース */
width: 44px;
height: 24px;
border-radius: 24px;
transition: background-color 0.4s;

/* ON状態 */
background-color: #2ecc71;

/* OFF状態 */
background-color: #cfd9de;

/* ノブ */
width: 20px;
height: 20px;
background-color: white;
border-radius: 50%;
transition: transform 0.4s;
```

---

## 🎬 アニメーション

### パネル展開/最小化
```css
transform-origin: top right;
transition: opacity 220ms ease, 
            transform 260ms cubic-bezier(0.2, 0.9, 0.2, 1);

/* 非表示 */
.hidden {
  opacity: 0;
  transform: scale(0.92);
  pointer-events: none;
}

/* 表示 */
.visible {
  opacity: 1;
  transform: scale(1);
}
```

### Shimmer（処理中）
```css
@keyframes shimmer {
  0% { background-position: -200px 0; }
  100% { background-position: 200px 0; }
}

.shimmer {
  background: linear-gradient(90deg, 
    #f1f3f4 0%, #e6ecf0 50%, #f1f3f4 100%);
  background-size: 200px 100%;
  animation: shimmer 1.1s linear infinite;
  border-radius: 6px;
}
```

### Flash（完了）
```css
@keyframes flash {
  0% { background-color: #e8f5fd; }
  100% { background-color: transparent; }
}

.done {
  animation: flash 0.8s ease;
}
```

### ホバー効果（全インタラクティブ要素）
```css
transition: all 0.2s ease;
```

---

## 📊 コンポーネント構造

### 標準パネルレイアウト
```
┌─────────────────────────────────┐
│ ヘッダー                    [×] │ ← 最小化ボタン
├─────────────────────────────────┤
│ ボディ (padding: 16px)          │
│                                 │
│ ┌─ メイン機能トグル ────────┐   │
│ │ [機能名]           [ON/OFF]│   │
│ └───────────────────────────┘   │
│                                 │
│ ┌─ 統計カード ──────────────┐   │
│ │ 推定コスト (モデル別目安)  │   │
│ │ $0.0000                   │   │
│ │ In: 0  /  Out: 0          │   │
│ └───────────────────────────┘   │
│                                 │
│ [機能固有設定エリア]             │
│                                 │
│ ⚙️ 設定 (モデル・キー)          │
│   ↓ 折りたたみ可能              │
│                                 │
│ [保存ボタン]                     │
│ [メッセージ表示]                 │
└─────────────────────────────────┘
```

---

## 🎨 タイポグラフィ階層

```css
/* H1 - パネルタイトル */
font-size: 15px;
font-weight: 800;
color: #0f1419;

/* H2 - セクションタイトル */
font-size: 14px;
font-weight: 700;
color: #0f1419;

/* 本文 */
font-size: 14px;
font-weight: 500;
color: #0f1419;

/* キャプション */
font-size: 11px - 13px;
font-weight: 500 - 700;
color: #536471;

/* ボタンテキスト */
font-size: 14px;
font-weight: 700;
```

### フォントファミリー
```css
font-family: -apple-system, BlinkMacSystemFont, 
             "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
```

---

## ✨ インタラクション原則

### 1. 即時フィードバック
- すべてのクリック可能要素にホバー効果
- クリック時の視覚的変化（色変更、影など）

### 2. 状態の明示
- ON/OFF: ボーダー色、影の変化で区別
- 処理中: Shimmerアニメーション
- 完了: Flashアニメーション

### 3. 一貫したアニメーション
- 展開/最小化は常に同じタイミング関数
- すべてのホバーは0.2s ease

### 4. アクセシビリティ
- 最小クリック領域: 32x32px以上
- コントラスト比: WCAG AA基準準拠
- focus状態の明示（青いボーダー）

---

## 🔧 実装時の注意点

1. **z-indexの管理**
   - 展開パネル: 2147483647
   - 最小化パネル: 2147483000
   - ドック: 2147483600

2. **レスポンシブ対応**
   - モバイル幅 (<768px) では別レイアウト適用
   - パネル幅: `calc(100% - 24px)`

3. **X.comとの調和**
   - カラーパレットはX.comの既存UIに合わせている
   - CSSクラス名の衝突を避けるためプレフィックス使用

4. **パフォーマンス**
   - アニメーションはtransform/opacityのみ使用
   - 重いbox-shadowの変更は避ける
