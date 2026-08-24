# ==================== 吞噬星空 RAG 助手 - 应用镜像 ====================
# 基于 node:20 完整版镜像（基于 buildpack-deps，自带 gcc/make/python3）
# 原因：bcrypt 是 C++ 原生模块，node:20-slim 缺编译工具链会导致 npm install 编译失败

FROM node:20

# 工作目录
WORKDIR /app

# 先复制依赖清单，利用 Docker 层缓存加速后续构建
COPY package*.json ./
# 项目使用 LangChain 多个独立包，版本范围可能产生 peer dependency 冲突；
# legacy-peer-deps 只放宽 npm 的 peer 校验，不会安装开发依赖。
# ECS/国内网络访问 npm 官方源可能超时，使用 npm 镜像源提高构建稳定性。
RUN npm config set registry https://registry.npmmirror.com \
  && npm install --omit=dev --legacy-peer-deps

# 复制源码与前端静态资源（.env 等敏感文件由 .dockerignore 排除，通过 compose 注入）
COPY . .

# 服务端口
EXPOSE 3000

# 启动服务（端口由环境变量 PORT 控制，默认 3000）
CMD ["node", "src/server.js"]
