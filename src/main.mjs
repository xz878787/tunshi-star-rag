import "dotenv/config";
import { parse } from 'path'; // path 解析路径
import {
  MilvusClient,//操作入口
  DataType,//字段类型
  MetricType,//相似度算法
  IndexType//向量索引类型
} from '@zilliz/milvus2-sdk-node'
import {
  OpenAIEmbeddings
} from '@langchain/openai'
import { 
  EPubLoader
} from '@langchain/community/document_loaders/fs/epub';
import {
  RecursiveCharacterTextSplitter
} from "@langchain/textsplitters"

// config 
const COLLECTION_NAME = 'ebook8'; // 编程习惯
const VECTOR_DIM = 1024;
const CHUNK_SIZE = 500;
const EPUB_FILE = './吞噬星空 (我吃西红柿) .epub'
const ADDRESS = process.env.MILVUS_ADDRESS;
// api key
const TOKEN = process.env.MILVUS_TOKEN;
const { name: BOOK_NAME } = parse(EPUB_FILE);
console.log(BOOK_NAME);

// 初始化embeddings 模型
const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.EMBEDDINGS_MODEL_NAME,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL
  },
  dimensions:VECTOR_DIM
});

async function getEmbedding(text) {
  const result = await  embeddings.embedQuery(text);
  return result;
}

// 向量数据库的初始化
const client = new MilvusClient({
  address: ADDRESS,
  token: TOKEN
});

async function ensureCollection(bookId) {
  // 没有就建立
  // 有就忽略
  try {
    // 判断是否已经创建
    const hasCollection = await client.hasCollection({
      collection_name: COLLECTION_NAME
    });
    if(!hasCollection.value) {
      console.log('创建集合....');
      await client.createCollection({
        collection_name: COLLECTION_NAME,
        fields: [
          { name: 'id', data_type: DataType.VarChar, 
            max_length: 100, is_primary_key: true},
          { name: 'book_id', data_type: DataType.VarChar, 
            max_length:100},
          {
            name: 'book_name', data_type: DataType.VarChar,
            max_length:200
          },
          // 第几章的
          {
            name: 'chapter_num', data_type: DataType.Int32,
          },
          // 第几个数据切片
          {
            name: 'index',
            data_type: DataType.Int32
          },
          {
            name: 'content', data_type: DataType.VarChar,
            max_length: 10000
          }, 
          {
            name: 'vector', data_type: DataType.FloatVector,
            dim: VECTOR_DIM
          }
        ]
      });
      console.log('集合创建成功');
      console.log('创建索引');
      await client.createIndex({
        collection_name: COLLECTION_NAME,
        field_name: 'vector',
        // nlist 是K-Means 聚类的簇数
        index_type: IndexType.IVF_FLAT,
        metric_type: MetricType.COSINE,
        params: {nlist: 1024}
      })
      // cosine 高维相识度， 不慢 ， 数据量大了
      console.log('索引创建成功');
    }
    // 细节捕捉错误
    // 每次要做的
    try {
      await client.loadCollection({ 
        collection_name: COLLECTION_NAME
      });
      console.log('集合加载成功');
    } catch(err) {
      console.error('集合已经处于加载状态');
    }
  } catch(err) {
    console.error('创建集合时出错'); 
  }
}

async function loadAndProcessEPubStreaming(bookId) {
  try {
    console.log(`\n 开始加载EPUB文件: ${EPUB_FILE}`);
    const loader = new EPubLoader(EPUB_FILE, {
      // 加载后就会按章节生成多个document
      // 内存需求的必然 
      splitChapters: true
    });
    const documents = await loader.load();
    console.log(`加载完成, 共${documents.length}个章节`);

    const textSplitter = new RecursiveCharacterTextSplitter({
      // 没有传separtor 就用默认的 \n 。 
      chunkSize: CHUNK_SIZE,
      chunkOverlap: 50, // 重叠50个字符， 保持上下文连贯性
    });
    let totalInserted = 0; // 计数
    let documentLen = documents.length; // 缓存
    for (let chapterIndex = 0; 
      chapterIndex < documentLen; chapterIndex++) {
      // Document 这一章的
      const chapter = documents[chapterIndex];
      const chapterContent = chapter.pageContent;
      // 跳过只有图片引用的短章节（EPUB插图页）
      if (chapterContent.length < 100) {
        console.log(`跳过第 ${chapterIndex + 1} 章（内容过短，可能是插图页）\n`);
        continue;
      }
      console.log(`处理第 ${chapterIndex + 1} / ${documentLen}
      章...
      `);
      const chunks = await textSplitter.splitText(
        chapterContent);
      console.log(`拆分为 ${chunks.length}个片段`);
      if (chunks.length === 0) {
        console.log(`推过空章节\n`);
        continue;
      }
      console.log(`生成向量并插入中...`);
      const insertedCount = await insertChunksBatch(
        chunks,
        bookId,
        chapterIndex + 1
      );

      totalInserted += insertedCount;
      console.log(`
      已插入${insertedCount}条记录  
      `)
    }

    console.log(`\n总共插入${totalInserted}条记录\n`);
    return totalInserted;
  } catch(err) {
    console.log("加载EPUB文件时出错", err);
  }
}
// 将一批chunk 插入向量数据库
async function insertChunksBatch(chunks, bookId, chapterNum) {
  try {
    // 为空 不需要做的
    if (chunks.length === 0) {
       return 0;
    }
    // 逐条处理，避免并发过高触发API限流
    const insertData = [];
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      const vector = await getEmbedding(chunk);
      insertData.push({
        id: `${bookId}_${chapterNum}_${chunkIndex}`,
        book_id: bookId,
        book_name: BOOK_NAME,
        chapter_num: chapterNum,
        index: chunkIndex,
        content: chunk,
        vector: vector
      });
    }
    const insertResult = await client.insert({
      collection_name: COLLECTION_NAME,
      data: insertData
    });

    // 函数的返回结果要有可预测性 一致。
    return Number(insertResult.insert_cnt) || 0;

  } catch(err) {
    console.error(`插入章节${chapterNum}的数据时出错:`, 
      err.message);
    throw err;
  }
}

const main = async () => {
  try {
    console.log('='.repeat(80));
    console.log('点子书处理程序');
    console.log('='.repeat(80));
    console.log('\n连接Milvus。。。');
    await client.connectPromise;
    console.log('已连接');
    const bookId = 1;
    // 确保集合建立了
    await ensureCollection(bookId);
    // 加载和处理EPUB文件
    // 一边切割一边embedding, 一边存数据库
    await loadAndProcessEPubStreaming(bookId);
  } catch(err) {

  }
  
}
main()
  .catch(err => {

  })