# ClaudeCat

Claude Code のスキル・エージェント・フック・コマンドを日本語で閲覧できるディレクトリサイト。

## 技術スタック

- Next.js (App Router) + TypeScript + Tailwind CSS
- データ: JSON ファイル (`data/` ディレクトリ)
- デプロイ: Vercel

## ディレクトリ構成

```
claude-cat/
├── src/app/              ← ページ
├── src/components/       ← UIコンポーネント
├── src/lib/              ← ユーティリティ
├── data/                 ← 収集データ (JSON)
├── scripts/              ← データ収集スクリプト
└── CLAUDE.md
```

## データ収集

`scripts/collect.mjs` で GitHub Code Search API から収集:

```bash
node scripts/collect.mjs
```

## コーディングルール

- immutable パターン（オブジェクト変異禁止）
- 小さなファイル（200-400行、最大800行）
- Zod でバリデーション
- エラーは必ず捕捉
