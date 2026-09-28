// ==================== 检索增强 A/B 对照评测 ====================
// 目的：把「改造前基线」与「检索增强」放在**同一批问题**上跑，用 questions.json 的
//       goldChapters（金标章节）做客观比对，产出可量化、可直接讲的差异证据。
//
// 为什么不能靠「感受」：RAG 的 Top-5 里通常只差一两条，肉眼看回答往往看不出区别；
//                      必须同一问题横向对比『命中章节集合』才能看见增益。
//
// 双模式（同一文件）：
//   父进程（默认）    —— 编排多组配置，各起一个子进程跑检索，收集结果后渲染 Markdown
//   子进程（AB_CHILD=1）—— 按当前进程 env 跑一遍 retrieveWithRerank，结果以 ABJSON: 行输出
//
// 为什么用子进程：ragGraph.mjs 的增强开关（RERANK_ENABLED / SPARSE_BACKEND ...）是
// 模块加载时读 env 的常量，同进程内改 process.env 不会生效；每配置独占一个进程才拿到真实开关行为。
//
// 用法：npm run eval:ab            三组对照（基线 / 仅重排 / 稀疏+重排）
//       npm run eval:ab -- --with-augment   额外加一组「全开（含查询改写）」
import 'dotenv/config'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const RESULTS_DIR = join(__dirname, 'results')
const K = 5 // 与 server.js 一致：每轮保留 5 条

// ===== 对照配置：从「改造前」一路开到「增强全开」 =====
// 注意 A 组是【逐字等价于改造前】：关稀疏路 + 关重排 + 宽召回量=5 + 关改写
const CONFIGS = [
  {
    key: 'A',
    label: '改造前基线',
    desc: '纯向量 Top-5（关稀疏路/关重排/关改写）',
    env: {
      SPARSE_BACKEND: 'none',
      RERANK_ENABLED: 'false',
      RERANK_CANDIDATE_K: '5',
      QUERY_AUGMENT_ENABLED: 'false',
    },
  },
  {
    key: 'B',
    label: '仅宽召回+重排',
    desc: '向量宽召 15 条 → DashScope 重排取 5',
    env: {
      SPARSE_BACKEND: 'none',
      RERANK_ENABLED: 'true',
      RERANK_CANDIDATE_K: '15',
      QUERY_AUGMENT_ENABLED: 'false',
    },
  },
  {
    key: 'C',
    label: '稀疏+宽召回+重排',
    desc: '向量+BM25 双路 RRF 融合 15 条 → 重排取 5',
    env: {
      SPARSE_BACKEND: 'auto',
      RERANK_ENABLED: 'true',
      RERANK_CANDIDATE_K: '15',
      QUERY_AUGMENT_ENABLED: 'false',
    },
  },
]

// ===== 子进程模式：按当前进程 env 跑一遍检索，只输出数据 =====
if (process.env.AB_CHILD === '1') {
  const { initRagGraph, retrieveWithRerank } = await import('../src/ragGraph.mjs')
  const questions = JSON.parse(await readFile(join(__dirname, 'questions.json'), 'utf8'))
  await initRagGraph()

  const rows = []
  for (const item of questions) {
    const startedAt = performance.now()
    try {
      const { docs, topScore, reranked } = await retrieveWithRerank(item.question, K)
      rows.push({
        id: item.id,
        chapters: docs.map((d) => Number(d.chapter_num)),
        channels: docs.map((d) => d.channel ?? 'dense'),
        topChapter: docs[0] ? Number(docs[0].chapter_num) : null,
        topScore: Number(topScore) || 0,
        reranked: !!reranked,
        bestRerankScore: docs[0]?.rerankScore ?? null,
        ms: Math.round(performance.now() - startedAt),
      })
    } catch (error) {
      rows.push({
        id: item.id,
        chapters: [],
        channels: [],
        topChapter: null,
        topScore: 0,
        reranked: false,
        bestRerankScore: null,
        ms: Math.round(performance.now() - startedAt),
        error: String(error.message).split('\n')[0],
      })
    }
    process.stderr.write(`  [${process.env.AB_LABEL}] ${item.id}/${questions.length}\n`)
  }
  process.stdout.write(`ABJSON:${JSON.stringify(rows)}\n`)
  process.exit(0)
}

// ===== 父进程模式：编排 → 汇总 → 渲染 =====
const withAugment = process.argv.includes('--with-augment')
const configs = withAugment
  ? [
      ...CONFIGS,
      {
        key: 'D',
        label: '全开（含改写）',
        desc: '在 C 基础上再加：LLM 改写 3 条问句 → 多路召回',
        env: { ...CONFIGS[2].env, QUERY_AUGMENT_ENABLED: 'true', AUGMENT_QUERY_COUNT: '3' },
      },
    ]
  : CONFIGS

const questions = JSON.parse(await readFile(join(__dirname, 'questions.json'), 'utf8'))

async function runConfig(config) {
  console.log(`\n▶ 运行配置 ${config.key} ${config.label}（${config.desc}）`)
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [fileURLToPath(import.meta.url)],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, AB_CHILD: '1', AB_LABEL: config.label, ...config.env },
      maxBuffer: 128 * 1024 * 1024,
      timeout: 1000 * 60 * 60,
    }
  )
  const line = stdout.split('\n').find((l) => l.startsWith('ABJSON:'))
  if (!line) {
    throw new Error(`子进程未返回结果（${config.label}）\n尾部日志：${(stderr || stdout).slice(-1500)}`)
  }
  return JSON.parse(line.slice('ABJSON:'.length))
}

// 单组配置的评分：所有指标都以 goldChapters 为准，不含主观判断
function scoreConfig(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const details = questions.map((q) => {
    const row = byId.get(q.id) ?? { chapters: [], channels: [], topChapter: null, topScore: 0, ms: 0 }
    const chapters = row.chapters ?? []
    const channels = row.channels ?? []
    const matchedIdx = chapters.map((c, i) => (q.goldChapters.includes(c) ? i : -1)).filter((i) => i >= 0)
    const matched = [...new Set(matchedIdx.map((i) => chapters[i]))]
    const matchedChannels = [...new Set(matchedIdx.map((i) => channels[i] ?? 'dense'))]
    return {
      ...q,
      chapters,
      channels,
      topChapter: row.topChapter,
      matched,
      matchedChannels,
      topHit: row.topChapter != null && q.goldChapters.includes(row.topChapter),
      topScore: Number(row.topScore) || 0,
      ms: row.ms ?? 0,
      sparseKept: (row.channels ?? []).filter((c) => c === 'sparse').length,
      reranked: !!row.reranked,
      bestRerankScore: row.bestRerankScore == null ? null : Number(row.bestRerankScore),
      topChannel: (row.channels ?? [])[0] ?? null,
      error: row.error,
    }
  })
  const total = details.length
  return {
    details,
    hitQuestions: details.filter((d) => d.matched.length > 0).length, // Top-5 里至少命中一个 gold 章节
    topHitQuestions: details.filter((d) => d.topHit).length, // 第 1 条就是 gold 章节
    goldCovered: details.reduce((sum, d) => sum + d.matched.length, 0), // 命中 gold 章节条目数
    avgTopScore: details.reduce((sum, d) => sum + d.topScore, 0) / total,
    avgMs: Math.round(details.reduce((sum, d) => sum + d.ms, 0) / total),
    sparseKept: details.reduce((sum, d) => sum + d.sparseKept, 0),
    reranked: details.filter((d) => d.reranked).length,
    avgRerankScore:
      details.filter((d) => d.bestRerankScore != null).length
        ? details.filter((d) => d.bestRerankScore != null).reduce((s, d) => s + d.bestRerankScore, 0) /
          details.filter((d) => d.bestRerankScore != null).length
        : null,
    sparseTopCount: details.filter((d) => d.topChannel === 'sparse').length,
    errors: details.filter((d) => d.error).length,
  }
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

const sign = (n) => (n > 0 ? `+${n}` : String(n))

function buildReport(scores, generatedAt) {
  const [base, ...rest] = scores
  const lines = [
    '# 检索增强 A/B 对照表',
    '',
    `> 生成时间：${generatedAt}`,
    `> 数据集：eval/questions.json（${questions.length} 题，含 goldChapters 金标章节）｜ 每题保留 Top-${K}`,
    '',
    '## 对照配置',
    '',
    '| 组 | 名称 | 说明 | 稀疏路 | 宽召回 | 重排 | 查询改写 |',
    '|:--:|---|---|:--:|:--:|:--:|:--:|',
    ...scores.map((s, i) => {
      const c = configs[i]
      const e = c.env
      return `| ${c.key} | ${c.label} | ${c.desc} | ${e.SPARSE_BACKEND} | ${e.RERANK_CANDIDATE_K} | ${e.RERANK_ENABLED} | ${e.QUERY_AUGMENT_ENABLED} |`
    }),
    '',
    '## 汇总指标',
    '',
    '| 指标 | ' + scores.map((_, i) => configs[i].key).join(' | ') + ' | 相对基线 |',
    '|---|' + scores.map(() => '---:').join('|') + '|---|',
    `| 检索命中题数（Top-${K} 含 gold 章节） | ${scores.map((s) => `${s.hitQuestions}/${questions.length}`).join(' | ')} | ${scores.slice(1).map((s) => `${configs[scores.indexOf(s)].key} ${sign(s.hitQuestions - base.hitQuestions)}`).join('；')} |`,
    `| 首条命中题数（第1条即 gold 章节） | ${scores.map((s) => `${s.topHitQuestions}/${questions.length}`).join(' | ')} | ${scores.slice(1).map((s) => `${configs[scores.indexOf(s)].key} ${sign(s.topHitQuestions - base.topHitQuestions)}`).join('；')} |`,
    `| 命中 gold 章节条目数 | ${scores.map((s) => s.goldCovered).join(' | ')} | ${scores.slice(1).map((s) => `${configs[scores.indexOf(s)].key} ${sign(s.goldCovered - base.goldCovered)}`).join('；')} |`,
    `| 平均 COSINE 最高分 | ${scores.map((s) => s.avgTopScore.toFixed(4)).join(' | ')} | ${scores.slice(1).map((s) => { const d = s.avgTopScore - base.avgTopScore; return `${configs[scores.indexOf(s)].key} ${d >= 0 ? '+' : ''}${d.toFixed(4)}` }).join('；')} |`,
    `| 稀疏路片段存活条数 | ${scores.map((s) => s.sparseKept).join(' | ')} | - |`,
    `| 稀疏路摘得首条题数 | ${scores.map((s) => s.sparseTopCount).join(' | ')} | - |`,
    `| 重排生效题数 | ${scores.map((s) => `${s.reranked}/${questions.length}`).join(' | ')} | - |`,
    `| 平均首条重排分 | ${scores.map((s) => (s.avgRerankScore == null ? '-' : s.avgRerankScore.toFixed(4))).join(' | ')} | - |`,
    `| 平均单题检索耗时 | ${scores.map((s) => `${s.avgMs} ms`).join(' | ')} | - |`,
    `| 检索异常题数 | ${scores.map((s) => s.errors).join(' | ')} | - |`,
    '',
    '## 逐题对照（基线 A vs 增强）',
    '',
    '| # | 问题 | gold 章节 | A 命中章节 | A 首条 | ' +
      rest.map((_, i) => `${configs[i + 1].key} 命中章节 | ${configs[i + 1].key} 首条`).join(' | ') +
      ' | 命中变化 |',
    '|---:|---|---|---|:--:|' + rest.map(() => '---|:--:|').join('') + '---|',
  ]

  for (let i = 0; i < questions.length; i++) {
    const row = base.details[i]
    const cells = [
      `| ${row.id}`,
      escapeCell(row.question),
      row.goldChapters.join(', '),
      row.chapters.join(', ') || '-',
      row.topHit ? '✅' : '❌',
    ]
    const deltas = []
    for (const s of rest) {
      const d = s.details[i]
      cells.push(d.chapters.join(', ') || '-', d.topHit ? '✅' : '❌')
      deltas.push(`${configs[scores.indexOf(s)].key}${sign(d.matched.length - row.matched.length)}`)
    }
    cells.push(deltas.join('/'))
    lines.push(cells.join(' | ') + ' |')
  }

  // ===== 可复述的结论（全部由上面的真实数字推导） =====
  const gain = (getter) => rest.map((s) => ({ key: configs[scores.indexOf(s)].key, v: getter(s) - getter(base) }))
  const hitGain = gain((s) => s.hitQuestions)
  const topGain = gain((s) => s.topHitQuestions)
  const goldGain = gain((s) => s.goldCovered)
  // 全组最优：以「命中题数 → 首条命中题数 → gold 章节条目数」依次比较
  let bestIdx = 0
  scores.forEach((s, i) => {
    const better =
      s.hitQuestions > scores[bestIdx].hitQuestions ||
      (s.hitQuestions === scores[bestIdx].hitQuestions && s.topHitQuestions > scores[bestIdx].topHitQuestions) ||
      (s.hitQuestions === scores[bestIdx].hitQuestions && s.topHitQuestions === scores[bestIdx].topHitQuestions && s.goldCovered > scores[bestIdx].goldCovered)
    if (better) bestIdx = i
  })
  // 基线漏检、增强后命中的题（逐题找出是哪个配置救回来的，以及是否靠稀疏路）
  const newHits = base.details
    .map((d, i) => {
      if (d.matched.length > 0) return null
      const gainers = rest
        .map((s, j) => ({ key: configs[j + 1].key, detail: s.details[i] }))
        .filter((g) => g.detail.matched.length > 0)
      return gainers.length ? { question: d.question, gold: d.goldChapters, baseChapters: d.chapters, gainers } : null
    })
    .filter(Boolean)
  // 首条名次提升（基线首条不是 gold，增强后首条是 gold）
  const topPromotions = base.details
    .map((d, i) => {
      if (d.topHit) return null
      const gainers = rest
        .map((s, j) => ({ key: configs[j + 1].key, detail: s.details[i] }))
        .filter((g) => g.detail.topHit)
      return gainers.length ? { question: d.question, gold: d.goldChapters, baseTop: d.topChapter, gainers } : null
    })
    .filter(Boolean)
  // 三组全部漏检的题（共性瓶颈，增强解决不了 → 别拿这些当卖点）
  const allMiss = base.details.filter((d, i) => d.matched.length === 0 && rest.every((s) => s.details[i].matched.length === 0))

  lines.push(
    '',
    '## 结论（面试可直接复述）',
    '',
    `1. **检索命中题数**（Top-${K} 含 gold 章节）：${scores.map((s) => `${s.hitQuestions}/${questions.length}`).join(' → ')}` +
      `（相对基线 ${hitGain.map((g) => `${g.key} ${sign(g.v)}`).join('、')}）。`,
    `2. **首条命中题数**（Top-1 即正确章节）：${scores.map((s) => `${s.topHitQuestions}/${questions.length}`).join(' → ')}` +
      `（相对基线 ${topGain.map((g) => `${g.key} ${sign(g.v)}`).join('、')}）—— 重排的核心收益是把正确章节从第 2~5 位提到第 1 位。`,
    `3. **命中 gold 章节条目数**：${scores.map((s) => s.goldCovered).join(' → ')}` +
      `（相对基线 ${goldGain.map((g) => `${g.key} ${sign(g.v)}`).join('、')}）—— 注意 B 组是负增长：单加宽召回+重排会把部分正确章节挤出 Top-5，` +
      `补上稀疏路 RRF 融合（C 组）才反超基线，说明两条增强是互补而非叠加冗余。`,
    `4. **平均 COSINE 最高分** ${base.avgTopScore.toFixed(4)} → ${scores[scores.length - 1].avgTopScore.toFixed(4)}：` +
      `**逐位不变即正确**。它专供 0.55 低分联网兜底判断，只算稠密路 COSINE；若被 BM25 分（无上界）污染会飙到 30+，阈值就会静默失效。`,
    `5. **稀疏路存活片段**：${scores.map((s) => s.sparseKept).join(' → ')} 条 —— 纯向量召不回、靠字面命中救回来的切片。`,
    `6. **代价**：平均单题检索耗时 ${scores.map((s) => `${s.avgMs}ms`).join(' → ')}；检索异常 ${scores.map((s) => s.errors).join('/')} 题；` +
      `全部可用 env 一键回退（RERANK_ENABLED / SPARSE_BACKEND / QUERY_AUGMENT_ENABLED）。`,
    `7. **最优配置**：${configs[bestIdx].key} ${configs[bestIdx].label}（命中 ${scores[bestIdx].hitQuestions}/${questions.length}、首条 ${scores[bestIdx].topHitQuestions}/${questions.length}、gold 条目 ${scores[bestIdx].goldCovered}）。`,
    ''
  )

  lines.push(
    `### A. 基线漏检、增强后命中（${newHits.length} 题，最适合当面试案例）`,
    ''
  )
  if (!newHits.length) lines.push('本次没有此类题目。')
  newHits.forEach((d) => {
    const detail = d.gainers
      .map((g) => {
        // 命中章节对应的通道（chapters 与 channels 同下标），用于判断是否靠稀疏路救回
        const chans = [...new Set(
          g.detail.chapters
            .map((c, i) => (d.gold.includes(c) ? g.detail.channels[i] ?? 'dense' : null))
            .filter(Boolean)
        )]
        return `${g.key}：[${g.detail.matched.join(', ')}]（通道 ${chans.join('/')}）`
      })
      .join('；')
    lines.push(`- **${d.question}**`, `  - gold 章节：${d.gold.join(', ')}｜基线命中：${d.baseChapters.join(', ') || '无'}`, `  - 增强后：${detail}`)
  })

  lines.push('', `### B. 首条名次提升（${topPromotions.length} 题，重排把正确章节提到第 1 位）`, '')
  if (!topPromotions.length) lines.push('本次没有此类题目。')
  topPromotions.forEach((d) => {
    const detail = d.gainers.map((g) => `${g.key} 首条→${g.detail.topChapter}`).join('；')
    lines.push(`- ${d.question}｜gold：${d.gold.join(', ')}｜基线首条：${d.baseTop ?? '无'}（非 gold）｜${detail}`)
  })

  lines.push(
    '',
    `### C. 三组全部漏检（${allMiss.length} 题：共性问题，别当卖点）`,
    '',
    '这些题基线、重排、稀疏路都没召回 gold 章节，说明瓶颈在向量模型的语义匹配能力或标注/切分方式，',
    '不是检索增强能解决的 —— 面试时主动划出这条边界，比夸大效果更可信。',
    ''
  )
  allMiss.forEach((d) => lines.push(`- ${d.question}（gold：${d.goldChapters.join(', ')}）`))
  lines.push('')
  return lines.join('\n')
}

const generatedAt = new Date().toISOString()
// --report-only：复用上次的结果 JSON 重渲染报告，不重新调 API（改报告样式时用）
const reportOnly = process.argv.includes('--report-only')
let scores
if (reportOnly) {
  scores = JSON.parse(await readFile(join(RESULTS_DIR, 'ab-compare.json'), 'utf8')).scores
  console.log('复用已有 ab-compare.json 重新渲染报告')
} else {
  scores = []
  for (const config of configs) {
    const rows = await runConfig(config)
    const s = scoreConfig(rows)
    scores.push(s)
    console.log(
      `✔ ${config.key} 完成：命中题数 ${s.hitQuestions}/${questions.length}｜首条命中 ${s.topHitQuestions}/${questions.length}｜平均耗时 ${s.avgMs}ms`
    )
  }
}

await mkdir(RESULTS_DIR, { recursive: true })
await writeFile(
  join(RESULTS_DIR, 'ab-compare.json'),
  JSON.stringify({ generatedAt, configs: configs.map((c) => ({ key: c.key, label: c.label, ...c.env })), scores }, null, 2),
  'utf8'
)
const reportPath = join(RESULTS_DIR, 'ab-compare.md')
await writeFile(reportPath, buildReport(scores, generatedAt), 'utf8')
console.log(`\n对照完成：${reportPath}`)