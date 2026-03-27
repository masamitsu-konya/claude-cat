#!/usr/bin/env node
/**
 * ClaudeCat Data Collector
 *
 * GitHub Code Search API で Claude Code のスキル・エージェント・コマンド・フック・ルールを収集する。
 * 結果は data/ ディレクトリに JSON ファイルとして保存。
 *
 * Usage:
 *   node scripts/collect.mjs                  # 全カテゴリ収集
 *   node scripts/collect.mjs --category skills # 特定カテゴリのみ
 *   node scripts/collect.mjs --dry-run         # API呼び出しなしでテスト
 *
 * 前提: gh CLI がインストール・認証済みであること
 */

import { execSync } from "node:child_process"
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, "..", "data")
const RATE_LIMIT_MS = 2500 // GitHub Code Search: 30 req/min → ~2s interval + buffer

// --- 検索カテゴリ定義 ---
const CATEGORIES = {
  skills: {
    label: "Skills",
    queries: [
      'filename:SKILL.md path:.claude/skills',
      'filename:SKILL.md path:.claude/skills language:markdown',
    ],
  },
  commands: {
    label: "Commands",
    queries: [
      'path:.claude/commands extension:md',
    ],
  },
  agents: {
    label: "Agents",
    queries: [
      'path:.claude/agents extension:md',
    ],
  },
  hooks: {
    label: "Hooks",
    queries: [
      '"hooks" path:.claude filename:settings.json',
    ],
  },
  rules: {
    label: "Rules",
    queries: [
      'path:.claude/rules extension:md',
    ],
  },
}

// --- ユーティリティ ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ghApi(endpoint, params = {}) {
  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&")
  const url = queryString ? `${endpoint}?${queryString}` : endpoint
  try {
    const result = execSync(`gh api "${url}" 2>/dev/null`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    })
    return JSON.parse(result)
  } catch (err) {
    console.error(`  API error: ${err.message?.slice(0, 200)}`)
    return null
  }
}

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const fm = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "")
      fm[key] = val
    }
  }
  return fm
}

function getFileContent(repo, path) {
  const data = ghApi(`/repos/${repo}/contents/${encodeURIComponent(path)}`)
  if (!data || !data.content) return null
  return Buffer.from(data.content, "base64").toString("utf-8")
}

// --- メイン収集ロジック ---
async function searchCategory(category, config) {
  console.log(`\n📦 Collecting: ${config.label}`)
  const items = new Map() // dedup by repo+path

  for (const query of config.queries) {
    console.log(`  🔍 Query: ${query}`)
    let page = 1
    let hasMore = true

    while (hasMore) {
      await sleep(RATE_LIMIT_MS)
      const result = ghApi("search/code", {
        q: query,
        per_page: 100,
        page: page.toString(),
      })

      if (!result || !result.items || result.items.length === 0) {
        hasMore = false
        break
      }

      console.log(
        `    Page ${page}: ${result.items.length} results (total: ${result.total_count})`
      )

      for (const item of result.items) {
        const key = `${item.repository.full_name}:${item.path}`
        if (items.has(key)) continue

        items.set(key, {
          name: item.name.replace(/\.md$/, ""),
          path: item.path,
          repo: item.repository.full_name,
          repo_url: item.repository.html_url,
          file_url: item.html_url,
          repo_description: item.repository.description || "",
          repo_stars: null, // 後で取得
          category,
        })
      }

      // GitHub Code Search API は最大1000件まで
      if (page * 100 >= Math.min(result.total_count, 1000)) {
        hasMore = false
      }
      page++
    }
  }

  console.log(`  ✅ ${config.label}: ${items.size} items found`)
  return Array.from(items.values())
}

async function enrichItems(items) {
  console.log(`\n🔧 Enriching ${items.length} items with content & metadata...`)
  const repoCache = new Map()
  let enriched = 0

  for (const item of items) {
    // リポジトリ情報（スター数等）をキャッシュして取得
    if (!repoCache.has(item.repo)) {
      await sleep(RATE_LIMIT_MS)
      const repoData = ghApi(`/repos/${item.repo}`)
      repoCache.set(item.repo, {
        stars: repoData?.stargazers_count ?? 0,
        description: repoData?.description ?? "",
        language: repoData?.language ?? "",
        updated_at: repoData?.updated_at ?? "",
        topics: repoData?.topics ?? [],
      })
    }

    const repoInfo = repoCache.get(item.repo)
    item.repo_stars = repoInfo.stars
    item.repo_description = repoInfo.description
    item.repo_language = repoInfo.language
    item.repo_updated_at = repoInfo.updated_at
    item.repo_topics = repoInfo.topics

    // ファイル内容を取得（frontmatter 解析用）
    if (item.category !== "hooks") {
      await sleep(RATE_LIMIT_MS)
      const content = getFileContent(item.repo, item.path)
      if (content) {
        const fm = extractFrontmatter(content)
        item.description = fm.description || ""
        item.trigger = fm.trigger || ""
        // 本文の最初の200文字を要約として保存
        const body = content.replace(/^---[\s\S]*?---\n*/, "").trim()
        item.summary = body.slice(0, 300)
        item.content_length = content.length
      }
    }

    enriched++
    if (enriched % 20 === 0) {
      console.log(`  Progress: ${enriched}/${items.length}`)
    }
  }

  console.log(`  ✅ Enriched ${enriched} items`)
  return items
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const categoryFilter = args.includes("--category")
    ? args[args.indexOf("--category") + 1]
    : null

  console.log("🐱 ClaudeCat Data Collector")
  console.log(`   Data dir: ${DATA_DIR}`)
  if (dryRun) console.log("   DRY RUN mode")

  mkdirSync(DATA_DIR, { recursive: true })

  // 収集するカテゴリを決定
  const categoriesToCollect = categoryFilter
    ? { [categoryFilter]: CATEGORIES[categoryFilter] }
    : CATEGORIES

  if (categoryFilter && !CATEGORIES[categoryFilter]) {
    console.error(
      `Unknown category: ${categoryFilter}. Available: ${Object.keys(CATEGORIES).join(", ")}`
    )
    process.exit(1)
  }

  // 検索実行
  let allItems = []
  for (const [key, config] of Object.entries(categoriesToCollect)) {
    if (dryRun) {
      console.log(`[DRY RUN] Would search: ${config.label}`)
      continue
    }
    const items = await searchCategory(key, config)
    allItems = [...allItems, ...items]
  }

  if (dryRun) {
    console.log("\nDry run complete.")
    return
  }

  // コンテンツ取得とエンリッチ
  const enrichedItems = await enrichItems(allItems)

  // カテゴリ別に保存
  const byCategory = {}
  for (const item of enrichedItems) {
    if (!byCategory[item.category]) {
      byCategory[item.category] = []
    }
    byCategory[item.category].push(item)
  }

  for (const [category, items] of Object.entries(byCategory)) {
    // スター数でソート
    const sorted = [...items].sort((a, b) => (b.repo_stars ?? 0) - (a.repo_stars ?? 0))
    const outPath = join(DATA_DIR, `${category}.json`)
    writeFileSync(outPath, JSON.stringify(sorted, null, 2))
    console.log(`📄 ${outPath}: ${sorted.length} items`)
  }

  // 統合ファイルも保存
  const allSorted = [...enrichedItems].sort(
    (a, b) => (b.repo_stars ?? 0) - (a.repo_stars ?? 0)
  )
  writeFileSync(join(DATA_DIR, "all.json"), JSON.stringify(allSorted, null, 2))

  // メタデータ
  const meta = {
    collected_at: new Date().toISOString(),
    total_items: enrichedItems.length,
    categories: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [k, v.length])
    ),
    unique_repos: new Set(enrichedItems.map((i) => i.repo)).size,
  }
  writeFileSync(join(DATA_DIR, "meta.json"), JSON.stringify(meta, null, 2))

  console.log(`\n🐱 Collection complete!`)
  console.log(`   Total: ${meta.total_items} items from ${meta.unique_repos} repos`)
  console.log(`   Categories: ${JSON.stringify(meta.categories)}`)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
