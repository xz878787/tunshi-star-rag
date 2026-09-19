// ==================== 背景音乐 + 背景图片轮播 ====================

// ===== DOM 引用（由 main.js 在加载时注入）=====
export const mediaRefs = {
  bgm: null,
  musicBtn: null,
  bgSlider: null,
}

let musicLoaded = false

// ========== 背景音乐 ==========

async function loadMusic() {
  if (musicLoaded) return
  try {
    const res = await fetch('/api/audio')
    const data = await res.json()
    if (data.success && data.audio.length > 0) {
      mediaRefs.bgm.src = data.audio[0]
      musicLoaded = true
      console.log('音乐加载成功:', data.audio[0])
    }
  } catch (e) {
    console.log('获取音乐列表失败:', e)
  }
}

export function toggleMusic() {
  loadMusic().then(() => {
    if (mediaRefs.bgm.paused) {
      mediaRefs.bgm.volume = 0.5
      mediaRefs.bgm.play().then(() => {
        mediaRefs.musicBtn.textContent = '🔊'
        mediaRefs.musicBtn.classList.add('playing')
      }).catch(e => console.log('播放失败:', e))
    } else {
      mediaRefs.bgm.pause()
      mediaRefs.musicBtn.textContent = '🔇'
      mediaRefs.musicBtn.classList.remove('playing')
    }
  })
}

// 用户任意点击后尝试自动播放（浏览器自动播放限制）
let autoPlayed = false
export function tryAutoPlay() {
  if (!autoPlayed) {
    autoPlayed = true
    loadMusic().then(() => {
      if (!mediaRefs.bgm.src) return
      mediaRefs.bgm.volume = 0.5
      mediaRefs.bgm.play().then(() => {
        mediaRefs.musicBtn.textContent = '🔊'
        mediaRefs.musicBtn.classList.add('playing')
      }).catch(() => {})
    })
  }
}

// ========== 背景图片轮播 ==========

async function loadImages() {
  try {
    const res = await fetch('/api/images')
    const data = await res.json()
    if (data.success && data.images.length > 0) {
      initSlider(data.images)
    }
  } catch (e) {
    console.log('获取图片列表失败:', e)
  }
}

function initSlider(images) {
  const slider = mediaRefs.bgSlider
  let currentIndex = 0

  images.forEach((src, i) => {
    const img = document.createElement('img')
    img.src = src
    if (i === 0) img.classList.add('active')
    slider.appendChild(img)
  })

  if (images.length > 1) {
    setInterval(() => {
      const imgs = slider.querySelectorAll('img')
      imgs[currentIndex].classList.remove('active')
      currentIndex = (currentIndex + 1) % imgs.length
      imgs[currentIndex].classList.add('active')
    }, 5000)
  }
}

// 启动入口
export function initMedia() {
  loadImages()
}
