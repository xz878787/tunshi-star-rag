import 'dotenv/config';
import {
  MilvusClient,    // C/S B/S
  MetricType, // 相似度求方法 
  IndexType, 
  DataType  // 字段数据类型约束
} from '@zilliz/milvus2-sdk-node';
import {
  OpenAIEmbeddings
} from '@langchain/openai';

const ADDRESS = process.env.MILVUS_ADDRESS;
// api key
const TOKEN = process.env.MILVUS_TOKEN;
const COLLECTION_NAME = 'ebook8';
const VECTOR_DIM = 1024;

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.EMBEDDINGS_MODEL_NAME,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL
  },
  dimensions: VECTOR_DIM
});

const client = new MilvusClient({
  address: ADDRESS,
  token: TOKEN
})
const getEmbedding = async (text) => {
  const result = await embeddings.embedQuery(text);
  return result;
}

async function main() {
  try {
    console.log('Connecting to Milvus');
    await client.connectPromise;
    console.log('connected\n');

    await client.loadCollection({
      collection_name: COLLECTION_NAME
    });

    const query = '罗峰会什么武功?';
    const queryVector = await getEmbedding(query);
    const searchResult = await client.search({
      collection_name:COLLECTION_NAME,
      vector: queryVector,
      limit: 3,
      metric_type: MetricType.COSINE,
      output_fields: ["id", "book_id", "chapter_num", 
        "index", "content"]
    });
    searchResult.results.forEach((item, index) => {
      console.log(`
      ${index + 1}.[Score:${item.score.toFixed(4)}]\n
      ID: ${item.id}  \n
      BookId: ${item.book_id}\n
      Content: ${item.content} \n 
      `)
    })
  } catch(err) {
    console.log(err);
  }
}

main()
  .catch(err => {
    console.log(err);
  })