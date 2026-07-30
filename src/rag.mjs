import 'dotenv/config'
import {
  MilvusClient, // c|s  B|C 架构
  MetricType , // 相似度求方法
} from '@zilliz/milvus2-sdk-node'
import {
  OpenAIEmbeddings,
  ChatOpenAI,
} from '@langchain/openai'
import { SystemMessage } from '@langchain/core/messages'
import { createInterface } from 'readline'

const ADDRESS =process.env.MILVUS_ADDRESS
const TOKEN=process.env.MILVUS_TOKEN
const COLLECTION_NAME = 'ebook8';
const VECTOR_DIM=1024; 

const embedding = new OpenAIEmbeddings({
 apiKey: process.env.OPENAI_API_KEY,
 model: process.env.EMBEDDINGS_MODEL_NAME,
 configuration: {
  baseURL: process.env.OPENAI_BASE_URL,
 },
 dimensions: VECTOR_DIM,
})
const model = new ChatOpenAI({
  temperature: 0.7,
  model: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL,
  },
})
const client =new MilvusClient({
    address :ADDRESS ,
    token : TOKEN
})
const getEmbedding = async (text) => {
  const result = await embedding.embedQuery(text);
  return result;
}

// Rag 图书业务知识库化
// 函数名可读性
// 一个函数就干一个功能
const retrievevRelevantContent = async (question,k=3) => {
  try{
    const queryVector =await getEmbedding(question)
    const srarchResult = await client.search({
      collection_name: COLLECTION_NAME,
      vectors: [queryVector],
      limit: k,
      metric_type: MetricType.COSINE,
      output_fields: ['id','content',"book_id","chapter_num"],
    })
    return srarchResult.results
  }catch(error){
    console.error('Error:', error);
  }
}

const answerEbookQuestion = async (question,k=3) => {
  try{
    console.log('='.repeat(50))
    console.log(`问题：${question}`);
    console.log('='.repeat(50))
    // rag 模块化
    console.log("检索相关章节内容")
    const retrievedDiaries = await retrievevRelevantContent(question,k)
    if(!retrievedDiaries || retrievedDiaries.length===0){
      console.log("没有找到相关章节内容")
    }
    retrievedDiaries.forEach((diary,index)=>{
      console.log(`章节${index+1}相似度${diary.score.toFixed(4)}\n内容：${diary.content}\n`)
    })

    const context = retrievedDiaries.map((diary,i)=>`[片段]${i+1},章节号:${diary.chapter_num},内容:${diary.content},`).join('\n\n----\n\n')
    const prompt =`你是一个专业的《吞噬星空》小说助手。
    基于小说回答问题，用准确，详细的语言。请根据以下小说片段内容回答问题：
    ${context}
    用户问题：${question}
    回答要求
    1. 如果片段中有相关信息，请结合小说内容给出详细准确的回答,如果没有请说不知道。
    2. 可以综合多个片段的内容，提供完整的答案。
    3. 如果片段中没有相关信息，请如实告知用户。
    4. 回答要准确，符合小说情节和人物设定。
    5 可以引用原文内容来支持你的回答。
    ai助手的回答    `
    return prompt
  }catch(error){
    console.error('Error:', error);
  }
}

async function main(){
  try{
    await client.connect()
    try{
      await client.loadCollection({
        collection_name: COLLECTION_NAME,
      })
      console.log("集合加载完成\n")
    }catch(error){
      console.error('Error:', error);
    }

    // 动态提问：循环等待用户输入，输入 exit/quit 退出
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const askQuestion = () => {
      return new Promise((resolve) => {
        rl.question('请输入你的问题（输入 exit 退出）：', (answer) => {
          resolve(answer.trim());
        });
      });
    };

    while (true) {
      const question = await askQuestion();
      if (!question || question === 'exit' || question === 'quit') {
        console.log('再见！');
        rl.close();
        break;
      }
      const prompt = await answerEbookQuestion(question, 5);
      const response = await model.invoke([new SystemMessage(prompt)]);
      console.log('\n回答：');
      console.log(response.content);
      console.log('\n' + '='.repeat(50) + '\n');
    }
  }catch(error){
    console.error('Error:', error);
  }
}
main().catch(console.error)