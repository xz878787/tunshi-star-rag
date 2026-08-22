// const express = require('express');//装框架
// const jwt = require('jsonwebtoken');//装鉴权
// const cors = require('cors');//装跨域

// const app = express();//启动服务实例
// app.use(cors());
// app.use(express.json());

// // ==================== 配置 ====================
// // 生产环境务必放到环境变量！不要硬编码
// const JWT_SECRET = 'your_strong_secret_key_2026';
// const JWT_EXPIRES_IN = '2h'; // token有效期

// // ==================== 1. 手写 JWT 签发工具函数 ====================
// /**
//  * 生成 accessToken
//  * @param {Object} payload 业务载荷（userId, username等，不要放敏感密码！）
//  * @returns {string} token
//  */
// function generateToken(payload) {
//     // 剔除敏感字段，只保留非隐私信息
//     const safePayload = { ...payload };
//     delete safePayload.password;
//     return jwt.sign(safePayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
// }

// // ==================== 2. 手写鉴权中间件（核心） ====================
// function authMiddleware(req, res, next) {
//     // 1. 从请求头拿 token，规范格式：Authorization: Bearer xxxxxx
//     const authHeader = req.headers.authorization;
//     if (!authHeader) {
//         return res.status(401).json({ code: 401, msg: '未提供身份令牌，请登录' });
//     }

//     // 分割 Bearer
//     const [scheme, token] = authHeader.split(' ');
//     if (scheme !== 'Bearer' || !token) {
//         return res.status(401).json({ code: 401, msg: '令牌格式错误，标准格式：Bearer token' });
//     }

//     try {
//         // 校验 & 解析token
//         const decoded = jwt.verify(token, JWT_SECRET);
//         // 将解析出来的用户信息挂载到req，后续路由直接使用 req.user
//         req.user = decoded;
//         next(); // 校验通过，放行
//     } catch (err) {
//         // 捕获：过期、密钥错误、篡改token等情况
//         if (err.name === 'TokenExpiredError') {
//             return res.status(401).json({ code: 401, msg: 'token已过期，请重新登录' });
//         }
//         return res.status(401).json({ code: 401, msg: '非法令牌，验证失败' });
//     }
// }

// // ==================== 3. 测试路由 ====================
// // 登录接口：签发 token
// app.post('/login', (req, res) => {
//     const { username, password } = req.body;
//     // 模拟数据库校验
//     if (username === 'admin' && password === '123456') {
//         const userInfo = {
//             userId: 10001,
//             username: 'admin',
//             role: 'admin'
//         };
//         const accessToken = generateToken(userInfo);
//         return res.json({
//             code: 200,
//             msg: '登录成功',
//             data: { accessToken }
//         });
//     }
//     res.status(400).json({ code: 400, msg: '账号密码错误' });
// });

// // 需要鉴权的接口，路由使用 authMiddleware
// app.get('/profile', authMiddleware, (req, res) => {
//     // req.user 就是jwt解析出来的载荷
//     res.json({
//         code: 200,
//         msg: '获取个人信息成功',
//         data: req.user
//     });
// });

// // 公开接口，不需要鉴权
// app.get('/public', (req, res) => {
//     res.json({ code: 200, msg: '公开数据，无需登录' });
// });

// const PORT = 3000;
// const HOST = '0.0.0.0';
// app.listen(PORT, HOST, () => {
//     console.log(`服务启动：http://localhost:${HOST}:${PORT}`);
//     // console.log("服务启动：http://localhost:" + PORT);
// });



import express from 'express';
import jwt from 'jsonwebtoken';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// ==================== 配置 ====================
// 生产环境务必放到环境变量！不要硬编码
const JWT_SECRET = 'your_strong_secret_key_2026';
const JWT_EXPIRES_IN = '2h'; // token有效期

// ==================== 1. 手写 JWT 签发工具函数 ====================
/**
 * 生成 accessToken
 * @param {Object} payload 业务载荷（userId, username等，不要放敏感密码！）
 * @returns {string} token
 */
function generateToken(payload) {
    // 剔除敏感字段，只保留非隐私信息
    const safePayload = { ...payload };
    delete safePayload.password;
    return jwt.sign(safePayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// ==================== 2. 手写鉴权中间件（核心） ====================
function authMiddleware(req, res, next) {
    // 1. 从请求头拿 token，规范格式：Authorization: Bearer xxxxxx
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ code: 401, msg: '未提供身份令牌，请登录' });
    }

    // 分割 Bearer
    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ code: 401, msg: '令牌格式错误，标准格式：Bearer token' });
    }

    try {
        // 校验 & 解析token
        const decoded = jwt.verify(token, JWT_SECRET);
        // 将解析出来的用户信息挂载到req，后续路由直接使用 req.user
        req.user = decoded;
        next(); // 校验通过，放行
    } catch (err) {
        // 捕获：过期、密钥错误、篡改token等情况
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ code: 401, msg: 'token已过期，请重新登录' });
        }
        return res.status(401).json({ code: 401, msg: '非法令牌，验证失败' });
    }
}

// ==================== 3. 测试路由 ====================
// 登录接口：签发 token
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    // 模拟数据库校验
    if (username === 'admin' && password === '123456') {
        const userInfo = {
            userId: 10001,
            username: 'admin',
            role: 'admin'
        };
        const accessToken = generateToken(userInfo);
        return res.json({
            code: 200,
            msg: '登录成功',
            data: { accessToken }
        });
    }
    res.status(400).json({ code: 400, msg: '账号密码错误' });
});

// 需要鉴权的接口，路由使用 authMiddleware
app.get('/profile', authMiddleware, (req, res) => {
    // req.user 就是jwt解析出来的载荷
    res.json({
        code: 200,
        msg: '获取个人信息成功',
        data: req.user
    });
});

// 公开接口，不需要鉴权
app.get('/public', (req, res) => {
    res.json({ code: 200, msg: '公开数据，无需登录' });
});

const PORT = 3000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`服务启动：http://${HOST}:${PORT}`);
});
