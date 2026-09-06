import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '@xterm/xterm/css/xterm.css'
// MiSans 自托管字体（npm 包分片 woff2 + unicode-range 按需加载）
import 'misans/lib/Normal/MiSans-Regular.min.css'
import 'misans/lib/Normal/MiSans-Medium.min.css'
import 'misans/lib/Normal/MiSans-Demibold.min.css'
// 语法高亮明暗双主题在 theme.css（按 data-theme 切换）；github-dark 全局引入会导致亮色模式代码不可读
import './styles/theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
