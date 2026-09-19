import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initRagGraph,
  retrieveRelevantContent,
  runAgenticRAG,
} from '../src/ragGraph.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const questions = JSON.parse(await readFile(join(__dirname, 'questions.json'), 'utf8'))
const outputDir = join(__dirname, 'results')

function keywordJudge(answer, keywords, minHits) {
  const matched = keywords.filter((keyword) => answer.includes(keyword))
  return { correct: matched.length >= minHits, matched }
}

function retrievalJudge(documents, goldChapters) {
  const retrievedChapters = documents.map((doc) => Number(doc.chapter_num))
  const matchedChapters = [...new Set(
    retrievedChapters.filter((chapter) => goldChapters.includes(chapter))
  )]
  return {
    hit: matchedChapters.length > 0,
    retrievedChapters,
    matchedChapters,
  }
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

async function evaluateOne(item) {
  const top5 = await retrieveRelevantContent(item.question, 5)
  const retrieval = retrievalJudge(top5, item.goldChapters)

  const startedAt = performance.now()
  let firstTokenAt = null
  let answer = ''
  const result = await runAgenticRAG({
    question: item.question,
    k: 5,
    maxRetrievalCount: 3,
    sink: {
      onToken(text) {
        if (firstTokenAt === null) firstTokenAt = performance.now()
        answer += text
      },
    },
  })
  if (!answer) answer = result.generation ?? ''

  const answerJudge = keywordJudge(answer, item.answerKeywords, item.minKeywordHits)
  return {
    ...item,
    top5Hit: retrieval.hit,
    retrievedChapters: retrieval.retrievedChapters,
    matchedChapters: retrieval.matchedChapters,
    correct: answerJudge.correct,
    matchedKeywords: answerJudge.matched,
    ttftMs: firstTokenAt === null ? null : Math.round(firstTokenAt - startedAt),
    answer,
  }
}

function buildReport(results, generatedAt) {
  const retrievalHits = results.filter((row) => row.top5Hit).length
  const correctAnswers = results.filter((row) => row.correct).length
  const measuredTtft = results.filter((row) => row.ttftMs !== null)
  const averageTtftMs = measuredTtft.length
    ? Math.round(measuredTtft.reduce((sum, row) => sum + row.ttftMs, 0) / measuredTtft.length)
    : null
  const answerFailures = results.filter((row) => !row.correct)
  const retrievalFailures = results.filter((row) => !row.top5Hit && row.correct)
  const failures = [...answerFailures, ...retrievalFailures].slice(0, 2)

  const lines = [
    '# RAG 项目数据表',
    '',
    `> 生成时间：${generatedAt}`,
    '',
    '| 指标 | 结果 | 口径 |',
    '|---|---:|---|',
    `| 评测问题数 | ${results.length} | 固定数据集 |`,
    `| Top-5 检索命中数 | ${retrievalHits}/${results.length} | Top-5 章节中至少一个命中 goldChapters |`,
    `| 正确回答数 | ${correctAnswers}/${results.length} | 命中题目设定的最小关键词数 |`,
    `| 平均首 Token 时间 | ${averageTtftMs === null ? 'N/A' : `${averageTtftMs} ms`} | 从 runAgenticRAG 开始到首次 onToken |`,
    '',
    '## 20 道问题明细',
    '',
    '| # | 问题 | Top-5章节 | 检索命中 | 回答正确 | TTFT |',
    '|---:|---|---|:---:|:---:|---:|',
    ...results.map((row) => `| ${row.id} | ${escapeCell(row.question)} | ${row.retrievedChapters.join(', ')} | ${row.top5Hit ? '是' : '否'} | ${row.correct ? '是' : '否'} | ${row.ttftMs ?? 'N/A'} ms |`),
    '',
    '## 失败案例（2个）',
    '',
  ]

  if (failures.length === 0) {
    lines.push('本次没有自然失败样本；为避免伪造失败数据，未强行填充。')
  } else {
    failures.forEach((row, index) => {
      const causes = []
      if (!row.top5Hit) causes.push(`Top-5未命中 gold 章节 ${row.goldChapters.join(', ')}`)
      if (!row.correct) causes.push(`仅命中关键词 ${row.matchedKeywords.join('、') || '无'}`)
      lines.push(
        `### ${index + 1}. ${row.question}`,
        '',
        `- 失败原因：${causes.join('；')}`,
        `- Top-5章节：${row.retrievedChapters.join(', ') || '无'}`,
        `- 回答摘要：${row.answer.slice(0, 300).replaceAll('\n', ' ')}`,
        ''
      )
    })
  }
  return lines.join('\n')
}

if (questions.length !== 20) {
  throw new Error(`数据集必须恰好包含20题，当前为${questions.length}题`)
}

let results
if (process.argv.includes('--report-only')) {
  const previous = JSON.parse(await readFile(join(outputDir, 'project-eval.json'), 'utf8'))
  results = previous.results.map((row) => {
    const item = questions.find((question) => question.id === row.id)
    if (!item) throw new Error(`找不到题目 ${row.id} 的当前标注`)
    const answerJudge = keywordJudge(row.answer, item.answerKeywords, item.minKeywordHits)
    return {
      ...row,
      ...item,
      correct: answerJudge.correct,
      matchedKeywords: answerJudge.matched,
    }
  })
} else {
  await initRagGraph()
  results = []
  for (const item of questions) {
    process.stdout.write(`[${item.id}/20] ${item.question}\n`)
    try {
      results.push(await evaluateOne(item))
    } catch (error) {
      results.push({
        ...item,
        top5Hit: false,
        retrievedChapters: [],
        matchedChapters: [],
        correct: false,
        matchedKeywords: [],
        ttftMs: null,
        answer: '',
        error: error.message,
      })
      console.error(`  失败: ${error.message}`)
    }
  }
}

const generatedAt = new Date().toISOString()
await mkdir(outputDir, { recursive: true })
await writeFile(
  join(outputDir, 'project-eval.json'),
  JSON.stringify({ generatedAt, results }, null, 2),
  'utf8'
)
await writeFile(
  join(outputDir, 'project-data-table.md'),
  buildReport(results, generatedAt),
  'utf8'
)
console.log(`\n评测完成：${join(outputDir, 'project-data-table.md')}`)
