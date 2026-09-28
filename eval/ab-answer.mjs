// ==================== 答案层 A/B 对照评测（全链路） ====================
// 与 eval/ab-compare.mjs 的分工：
//   ab-compare.mjs —— 只测【检索层】（单轮 retrieveWithRerank，隔离变量、极便宜）
//   本文件        —— 测【答案层】（完整 runAgenticRAG：路由→拆解→多跳检索→规划→生成）
//
// 为什么答案层要把「代价」一起量：改造前基线（2026-09-19 全链路评测）答案层已达 19/20，
// 正确率几乎没有抬升空间。真正可能变化的是【拿到同样答案需要多少轮检索 / 多少片段 / 多少时间】——
// 单轮召回变好，多跳链路就应该更早收敛。所以正确率和代价必须一起报，否则会得出「增强没用」的错觉。
//
// 双模式（同 ab-compare）：
//   父进程（默认）    —— 编排配置，各起一个子进程跑全链路，汇总后渲染 Markdown
//   子进程（AB_CHILD=1）—— 按当前进程 env 跑一遍，结果以 ABJSON: 行输出
//
// 用法：npm run eval:ab:answer            20 题 × 2 组（基线 / 全开）
//       npm run eval:ab:answer -- --limit=6   只跑前 6 题（快速冒烟）
//       npm run eval:ab:answer -- --report-only
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
const K = 5
const MAX_ROUNDS = 3 // 与 run-project-eval.mjs 一致

// ===== 两组配置：改造前基线 vs 检索增强全开 =====
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
    key: 'C',
    label: '检索增强全开',
    desc: '向量+BM25 双路 RRF 融合 → 宽召 15 → DashScope 重排取 5',
    env: {
      SPARSE_BACKEND: 'auto',
      RERANK_ENABLED: 'true',
      RERANK_CANDIDATE_K: '15',
      QUERY_AUGMENT_ENABLED: 'false',
    },
  },
]

// ===== 子进程模式 =====
if (process.env.AB_CHILD === '1') {
  const { initRagGraph, runAgenticRAG } = await import('../src/ragGraph.mjs')
  const all = JSON.parse(await readFile(join(__dirname, 'questions.json'), 'utf8'))
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))
  const questions = limitArg ? all.slice(0, Number(limitArg.split('=')[1])) : all
  await initRagGraph()

  const rows = []
  for (const item of questions) {
    const startedAt = performance.now()
    let firstTokenAt = null
    let answer = ''
    let state = null
    let error = null
    try {
      state = await runAgenticRAG({
        question: item.question,
        k: K,
        maxRetrievalCount: MAX_ROUNDS,
        sink: {
          onToken(text) {
            if (firstTokenAt === null) firstTokenAt = performance.now()
            answer += text
          },
        },
      })
    } catch (e) {
      error = String(e.message).split('\n')[0]
    }
    if (!answer) answer = state?.generation ?? ''

    const documents = state?.documents ?? []
    const matchedKeywords = item.answerKeywords.filter((kw) => answer.includes(kw))
    rows.push({
      id: item.id,
      correct: matchedKeywords.length >= item.minKeywordHits,
      matchedKeywords,
      answer: answer.slice(0, 400),
      ttftMs: firstTokenAt === null ? null : Math.round(firstTokenAt - startedAt),
      totalMs: Math.round(performance.now() - startedAt),
      retrievalCount: state?.retrievalCount ?? 0,
      subQuestionCount: (state?.subQuestions ?? []).length,
      docCount: documents.length,
      sparseDocCount: documents.filter((d) => d.channel === 'sparse').length,
      chapters: documents.map((d) => Number(d.chapter_num)),
      lastTopScore: Number(state?.lastTopScore) || 0,
      webSearched: !!state?.webSearched,
      error,
    })
    process.stderr.write(`  [${process.env.AB_LABEL}] ${item.id}/${questions.length}\n`)
  }
  process.stdout.write(`ABJSON:${JSON.stringify(rows)}\n`)
  process.exit(0)
}

// ===== 父进程模式 =====
const questions = JSON.parse(await readFile(join(__dirname, 'questions.json'), 'utf8'))
const limitArg = process.argv.find((a) => a.startsWith('--limit='))
const subset = limitArg ? questions.slice(0, Number(limitArg.split('=')[1])) : questions

async function runConfig(config) {
  console.log(`\n▶ 运行配置 ${config.key} ${config.label}（${config.desc}）｜${subset.length} 题 × 最多 ${MAX_ROUNDS} 轮检索`)
  const { stdout, stderr } = await execFileAsync(process.execPath, [fileURLToPath(import.meta.url), ...(limitArg ? [limitArg] : [])], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, AB_CHILD: '1', AB_LABEL: config.label, ...config.env },
    maxBuffer: 128 * 1024 * 1024,
    timeout: 1000 * 60 * 60,
  })
  const line = stdout.split('\n').find((l) => l.startsWith('ABJSON:'))
  if (!line) throw new Error(`子进程未返回结果（${config.label}）\n尾部日志：${(stderr || stdout).slice(-1500)}`)
  return JSON.parse(line.slice('ABJSON:'.length))
}

function summarize(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const details = subset.map((q) => {
    const row = byId.get(q.id) ?? {}
    const chapters = row.chapters ?? []
    const matched = [...new Set(chapters.filter((c) => q.goldChapters.includes(c)))]
    return {
      ...q,
      ...row,
      chapters,
      matched,
      topHit: (row.chapters ?? [])[0] != null && q.goldChapters.includes(row.chapters[0]),
    }
  })
  const avg = (pick) => {
    const vals = details.map(pick).filter((v) => v != null)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }
  return {
    details,
    correct: details.filter((d) => d.correct).length,
    retrievalHit: details.filter((d) => d.matched.length > 0).length,
    avgRounds: avg((d) => d.retrievalCount),
    maxRounds: Math.max(0, ...details.map((d) => d.retrievalCount ?? 0)),
    roundsAtCap: details.filter((d) => d.retrievalCount >= MAX_ROUNDS).length,
    avgSubQuestions: avg((d) => d.subQuestionCount),
    avgDocs: avg((d) => d.docCount),
    avgSparseDocs: avg((d) => d.sparseDocCount),
    avgTtftMs: avg((d) => d.ttftMs),
    avgTotalMs: avg((d) => d.totalMs),
    webSearched: details.filter((d) => d.webSearched).length,
    errors: details.filter((d) => d.error).length,
  }
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}
const sign = (n, digits = 0) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`

function buildReport(scores, generatedAt) {
  const [base, ...rest] = scores
  const num = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d))
  const row = (name, pick, digits = 0, unit = '') =>
    `| ${name} | ${scores.map((s) => `${num(pick(s), digits)}${unit}`).join(' | ')} | ` +
    `${scores.slice(1).map((s) => `${CONFIGS[scores.indexOf(s)].key} ${sign(pick(s) - pick(base), digits)}${unit}`).join('；')} |`

  const lines = [
    '# 答案层 A/B 对照表（全链路）',
    '',
    `> 生成时间：${generatedAt}`,
    `> 链路：完整 runAgenticRAG（路由 → 拆解 → 多跳检索 → 规划 → 生成）｜题数 ${subset.length}｜k=${K}｜最多 ${MAX_ROUNDS} 轮检索`,
    '> 判分口径：答案包含该题设定关键词数 ≥ minKeywordHits（与 eval/run-project-eval.mjs 一致）',
    '',
    '## 汇总指标',
    '',
    '| 指标 | ' + scores.map((_, i) => CONFIGS[i].key).join(' | ') + ' | 相对基线 |',
    '|---|' + scores.map(() => '---:').join('|') + '|---|',
    row('正确回答数', (s) => s.correct, 0),
    row('检索命中题数（库内片段含 gold 章节）', (s) => s.retrievalHit, 0),
    row(`平均检索轮数（上限 ${MAX_ROUNDS}）`, (s) => s.avgRounds, 2),
    row('跑满上限轮数的题数', (s) => s.roundsAtCap, 0),
    row('平均子问题条数', (s) => s.avgSubQuestions, 2),
    row('平均库内片段条数', (s) => s.avgDocs, 2),
    row('其中稀疏路片段', (s) => s.avgSparseDocs, 2),
    row('平均首 Token 时间', (s) => s.avgTtftMs, 0, ' ms'),
    row('平均单题总耗时', (s) => s.avgTotalMs, 0, ' ms'),
    row('触发联网兜底题数', (s) => s.webSearched, 0),
    row('异常题数', (s) => s.errors, 0),
    '',
    '## 逐题对照 · 正确性',
    '',
    '| # | 问题 | ' + scores.map((_, i) => `${CONFIGS[i].key} 正确`).join(' | ') + ' | 库内命中章节（' + CONFIGS[scores.length - 1].key + '） |',
    '|---:|---|' + scores.map(() => ':--:').join('|') + '|---|',
  ]
  for (let i = 0; i < subset.length; i++) {
    lines.push(
      `| ${subset[i].id} | ${escapeCell(subset[i].question)} | ` +
        `${scores.map((s) => (s.details[i].correct ? '✅' : '❌')).join(' | ')} | ` +
        `${scores[scores.length - 1].details[i].matched.join(', ') || '-'} |`
    )
  }
  lines.push(
    '',
    '## 逐题对照 · 代价',
    '',
    '| # | 问题 | ' + scores.map((_, i) => `${CONFIGS[i].key} 轮数/片段/耗时`).join(' | ') + ' |',
    '|---:|---|' + scores.map(() => ':--:').join('|') + '|',
    ...subset.map((q, i) => {
      const cells = scores.map((s) => {
        const d = s.details[i]
        return `${d.retrievalCount}轮 / ${d.docCount}片 / ${d.totalMs}ms`
      })
      return `| ${q.id} | ${escapeCell(q.question)} | ${cells.join(' | ')} |`
    })
  )

  // ===== 结论 =====
  const last = scores[scores.length - 1]
  const fixed = base.details.filter((d, i) => !d.correct && last.details[i].correct)
  const broke = base.details.filter((d, i) => d.correct && !last.details[i].correct)
  lines.push(
    '',
    '## 结论（面试可直接复述）',
    '',
    `1. **正确回答数**：${scores.map((s) => `${s.correct}/${subset.length}`).join(' → ')}` +
      `（${sign(last.correct - base.correct)}）${fixed.length + broke.length === 0 ? '—— 两组完全一致。' : ''}`,
    `2. **检索轮数**：${scores.map((s) => num(s.avgRounds, 2)).join(' → ')}，跑满 ${MAX_ROUNDS} 轮上限的题数 ${scores.map((s) => s.roundsAtCap).join(' → ')}` +
      `—— 单轮召回变好，多跳链路应当更早收敛；这是增强在答案层最该省的代价。`,
    `3. **单题总耗时**：${scores.map((s) => `${num(s.avgTotalMs, 0)}ms`).join(' → ')}` +
      `（${sign((last.avgTotalMs ?? 0) - (base.avgTotalMs ?? 0), 0)}ms）；首 Token ${scores.map((s) => `${num(s.avgTtftMs, 0)}ms`).join(' → ')}。`,
    `4. **库内片段构成**：平均 ${scores.map((s) => num(s.avgDocs, 2)).join(' → ')} 条，其中稀疏路 ${scores.map((s) => num(s.avgSparseDocs, 2)).join(' → ')} 条。`,
    `5. **联网兜底**：${scores.map((s) => `${s.webSearched} 题`).join(' → ')}（阈值 0.55 只认稠密路 COSINE，不受稀疏路影响）。`,
    '',
    fixed.length
      ? `### 基线答错、增强后答对（${fixed.length} 题）\n`
      : '### 基线答错、增强后答对：本题集为 0 —— 见下方解读\n',
    ...fixed.map((d) => `- ${d.question}（基线仅命中 ${d.matchedKeywords.join('、') || '无'}）`),
    broke.length ? `\n### 基线答对、增强后答错（${broke.length} 题，需重点核查）\n` : '',
    ...broke.map((d) => `- ${d.question}`),
    '',
    '### 怎么读这个结果（重要）',
    '',
    `本题集改造前基线答案层已达 ${base.correct}/${subset.length}，**正确率接近饱和**，所以「正确回答数」不是能体现增强的指标。`,
    '正确做法是看**代价项**：同样答对，增强若能用更少的检索轮数/片段达成，就是真实收益（更低的延迟与 API 成本）；',
    '若轮数也持平，则说明本题集的 agentic 多跳链路已经把单轮召回的缺口补掉了 —— 这本身就是有价值的结论：',
    '**增强的收益边界在「单轮召回质量」，而不是「最终答案正确率」**；要证明答案层收益，需要换更难的题目（长尾专有名词、跨章节推理）。',
    ''
  )
  return lines.join('\n')
}

const generatedAt = new Date().toISOString()
const reportOnly = process.argv.includes('--report-only')
let scores
if (reportOnly) {
  scores = JSON.parse(await readFile(join(RESULTS_DIR, 'ab-answer.json'), 'utf8')).scores
  console.log('复用已有 ab-answer.json 重新渲染报告')
} else {
  scores = []
  for (const config of CONFIGS) {
    const rows = await runConfig(config)
    const s = summarize(rows)
    scores.push(s)
    console.log(
      `✔ ${config.key} 完成：正确 ${s.correct}/${subset.length}｜平均轮数 ${s.avgRounds?.toFixed(2)}｜平均耗时 ${Math.round(s.avgTotalMs)}ms｜平均片段 ${s.avgDocs?.toFixed(1)}`
    )
  }
}

await mkdir(RESULTS_DIR, { recursive: true })
await writeFile(
  join(RESULTS_DIR, 'ab-answer.json'),
  JSON.stringify({ generatedAt, configs: CONFIGS.map((c) => ({ key: c.key, label: c.label, ...c.env })), scores }, null, 2),
  'utf8'
)
const reportPath = join(RESULTS_DIR, 'ab-answer.md')
await writeFile(reportPath, buildReport(scores, generatedAt), 'utf8')
console.log(`\n对照完成：${reportPath}`)