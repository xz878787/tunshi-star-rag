// ==================== MySQL 连接池 ====================
// 统一封装 mysql2 连接池，业务层不直接依赖 mysql 驱动
import mysql from 'mysql2/promise'

// 从 .env 读取数据库连接配置
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'rag_system',
  waitForConnections: true,      // 连接池满时排队等待，不直接报错
  connectionLimit: 10,           // 最大连接数
  queueLimit: 0,                 // 无限排队
  charset: 'utf8mb4',            // 支持中文
})

/**
 * 执行 SQL 的通用入口
 * 使用参数化查询（? 占位符），天然防止 SQL 注入
 * @param {string} sql SQL 语句
 * @param {Array} params 参数数组
 * @returns {Promise<Array>} 查询结果行
 */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params)
  return rows
}

// 测试连接（启动时调用一次）
export async function testConnection() {
  const conn = await pool.getConnection()
  await conn.ping()
  conn.release()
  console.log('MySQL 连接成功')
}

export default pool
