// ==================== 鉴权相关路由 ====================
// 只负责 URL → 处理函数的映射
import { Router } from 'express'
import bcrypt from 'bcrypt'
import { signToken } from '../utils/jwt.js'
import { authMiddleware } from '../middleware/auth.js'
import { findUserByUsername, createUser } from '../models/userModel.js'

const router = Router()

// 登录接口：查 MySQL 校验账号密码，签发 token
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body
        if (!username || !password) {
            return res.status(400).json({ code: 400, msg: '用户名和密码不能为空' })
        }

        // 1. 查用户表
        const user = await findUserByUsername(username)
        // 2. 统一提示，不区分"用户不存在"和"密码错误"（防用户名枚举）
        if (!user) {
            return res.status(400).json({ code: 400, msg: '账号或密码错误' })
        }

        // 3. bcrypt 比对密码
        const match = await bcrypt.compare(password, user.password)
        if (!match) {
            return res.status(400).json({ code: 400, msg: '账号或密码错误' })
        }

        // 4. 签发 token（不含敏感字段）
        const userInfo = {
            userId: user.id,
            username: user.username,
            role: user.role || 'user'
        }
        const accessToken = signToken(userInfo)
        return res.json({
            code: 200,
            msg: '登录成功',
            data: { accessToken }
        })
    } catch (err) {
        console.error('登录失败:', err)
        res.status(500).json({ code: 500, msg: '服务器内部错误' })
    }
})

// 注册接口：创建新用户，密码 bcrypt 加密后入库
router.post('/register', async (req, res) => {
    try {
        const { username, password, nickname } = req.body
        if (!username || !password) {
            return res.status(400).json({ code: 400, msg: '用户名和密码不能为空' })
        }
        if (password.length < 6) {
            return res.status(400).json({ code: 400, msg: '密码长度至少 6 位' })
        }

        // 1. 查重
        const exists = await findUserByUsername(username)
        if (exists) {
            return res.status(400).json({ code: 400, msg: '用户名已存在' })
        }

        // 2. bcrypt 哈希（成本因子 10，兼顾安全与性能）
        const passwordHash = await bcrypt.hash(password, 10)
        // 3. 入库
        const { id } = await createUser({ username, passwordHash, nickname })
        return res.json({
            code: 200,
            msg: '注册成功',
            data: { id }
        })
    } catch (err) {
        console.error('注册失败:', err)
        res.status(500).json({ code: 500, msg: '服务器内部错误' })
    }
})

// 受保护接口：验证 token 后返回用户信息（用来测试鉴权是否生效）
router.get('/profile', authMiddleware, (req, res) => {
    res.json({
        code: 200,
        msg: '获取个人信息成功',
        data: req.user
    })
})

export default router
