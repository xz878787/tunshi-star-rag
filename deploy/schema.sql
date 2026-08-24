-- ==================== 吞噬星空 RAG 助手 - 建表脚本 ====================
-- 由 docker-compose 挂载到 /docker-entrypoint-initdb.d，MySQL 首次启动时自动执行
-- 生产环境建议本地先校验无误再部署
-- 注意：挂载到 initdb.d 的脚本仅在数据卷为空（首次初始化）时执行一次，之后不会重复执行

-- 用户表：存账号密码与角色
CREATE TABLE IF NOT EXISTS sys_user (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(100) NOT NULL,          -- bcrypt 哈希，绝不存明文
  nickname VARCHAR(30),
  role VARCHAR(20) DEFAULT 'user',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 会话表：一次对话（与用户 1:N）
CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  title VARCHAR(100),
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user (user_id, update_time)
);

-- 消息表：会话内的每条问答（与会话 1:N）
CREATE TABLE IF NOT EXISTS messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  role VARCHAR(10) NOT NULL,               -- user / assistant
  content TEXT NOT NULL,
  sources JSON NULL,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conv (conversation_id, create_time)
);