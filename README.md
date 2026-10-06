# Claude in Chrome for Gateway

> **Claude in Chrome 浏览器插件网关解绑与功能增强开源版**  
> 支持自定义 API 网关 · 自定义模型 · 深度融合设置 · 历史会话 · Opus 5.5 推理努力程度 · 全局免授权 · 简体中文 · 遥测脱敏

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![Community](https://img.shields.io/badge/Community-LINUX%20DO-orange.svg)](https://linux.do)

---

## 💡 项目背景与特色

官方 **Claude in Chrome** 扩展深度绑定了 Anthropic 官方账号与 OAuth 登录，并在扩展内集成了多种远程分析和遥测。

本项目为开箱即用的纯净开源版本，专为配合中转网关、自建反向代理以及本地模型服务而设计，彻底解绑官方账号限制，并针对实际工作流进行了大量原生级增强：

1. **解绑官方 OAuth 登录**：去除官方强制登录与付费墙门禁，直连兼容 Anthropic Messages API（`/v1/messages`）的任意 API 网关。初次安装零死锁，无需登录即可直接进入网关配置页。
2. **设置页与历史记录深度融合**：网关配置与历史会话无缝内嵌到 Claude in Chrome 原生 Options 设置页，在宽屏标签页中舒适操作，告别拥挤狭窄的侧边小窗口。
3. **原生历史会话（Chat History）与一键恢复**：
   - 自动记录侧边栏多轮对话及上下文。
   - 支持关键词搜索、对话详情展开、一键复制为完整 Markdown 文档、全量 JSON 导出与清理。
   - **支持一键恢复会话**：点击「恢复到侧边栏」，过去任意会话即刻无缝加载回侧边栏，支持继续输入接续对话！
   - 原生菜单无缝集成，无任何违和的外部注入图标。
4. **推理努力程度（Reasoning Effort）全量支持**：
   - 紧跟最新模型标准（如 Claude 3.7 / Opus 5.5 自适应思考）。
   - 提供 `low`（轻量快速）、`medium`（均衡推荐）、`high`（深度推理）、`xhigh`（超强深度）、`max`（极限思考）预设。
   - 支持自由手动输入自定义数值与推理参数。
5. **全局网站权限（直接允许所有网站）**：
   - 在原生权限管理中加入全局免授权开关。
   - 开启后 Claude 在所有网页自动执行浏览、点击、表单输入等操作，免去频繁弹窗授权。
6. **全量简体中文本地化（zh-CN）**：
   - 内置超过 900+ 条关键字段的完整简体中文翻译包（`zh-CN.json`）。
   - 中文系统环境下自动默认激活，界面自然流畅。
7. **彻底移除官方遥测**：
   - 屏蔽 Sentry、Datadog RUM/Profiler、event_logging、GrowthBook、statsig 等一切遥测打点。
   - 纯净运行，零网络隐私泄露。
8. **React 稳定性增强**：
   - 彻底修复 useMergedRefs 与 SlotClone 引发的 ref 抖动循环（React #185）。
   - 注入健壮错误边界与诊断日志。

---

## 📦 安装方法

本仓库为完全独立、纯净的已编译扩展包，无需安装额外构建依赖：

### 步骤 1：下载扩展文件
直接克隆或下载本仓库到本地任意目录：
```bash
git clone https://github.com/your-username/claude-in-chrome-for-gateway.git
```
或直接点击 GitHub 的 **Code -> Download ZIP** 并解压。

### 步骤 2：加载到 Chrome 浏览器
1. 打开 Google Chrome 或基于 Chromium 的浏览器（Edge、Brave 等）。
2. 在地址栏输入并打开：
   ```text
   chrome://extensions/
   ```
3. 打开页面右上角的 **“开发者模式”**（Developer mode）开关。
4. 点击左上角出现的 **“加载已解压的扩展程序”**（Load unpacked）按钮。
5. 选择解压后的本仓库根目录（即包含 `manifest.json` 的目录）。
6. 安装完成后，扩展栏将出现 **Claude in Chrome for Gateway** 图标。

---

## 🚀 快速上手配置

1. **打开配置界面**：
   - 点击浏览器扩展栏的 Claude 图标打开侧边栏，点击右上角菜单（`...`）中的【Settings】；
   - 或直接右键扩展图标 -> 选择【选项】直接进入完整设置页。
2. **填写网关信息**：
   - **Base URL**：填写您的 API 网关地址（如 `https://api.your-gateway.com` 或本地反代 `http://127.0.0.1:8080`）。
   - **API Key**：填写网关对应的 API 密钥。
   - **认证方式**：根据网关类型选择 `x-api-key` 或 `Authorization: Bearer`。
   - 点击【保存并登录】。
3. **配置模型**：
   - 切换到【自定义模型】选项卡，添加您所使用的模型（如 `claude-3-7-sonnet-20250219`、`claude-opus-5-5` 等）。
   - 可针对模型单独开启思考能力（thinking）并配置推理努力程度（effort）。
4. **开始使用**：
   - 打开侧边栏即可开始流畅对话、操作浏览器！
   - 点击右上角菜单的【历史会话】，可随时查看、导出或一键恢复历史对话继续聊天。

---

## 📁 目录结构

```text
claude-in-chrome-for-gateway/
├── manifest.json              # 扩展清单配置 (Manifest V3)
├── options.html               # 深度融合的原生设置主界面
├── sidepanel.html             # 侧边栏交互主界面
├── gateway/                   # 网关运行时垫片与配置视图
│   ├── shim.js                # 核心运行时垫片（API 改写、遥测拦截、会话记录）
│   ├── index.html             # 网关与模型配置控制台
│   ├── gateway.css            # 原生风格样式
│   └── gateway.js             # 控制台交互逻辑
├── i18n/                      # 多语言本地化字典（含 zh-CN.json 全量中文包）
├── assets/                    # 前端核心依赖与组件
├── public/                    # 静态资源
├── sounds/                    # 提示音效
└── README.md                  # 说明文档
```

---

## 🙏 致谢与声明

- 感谢 **[LINUX DO 社区](https://linux.do)** 提供的高质量技术土壤与灵感分享！
- 本项目纯粹作为社区技术探索与学习交流分享，全部源码透明公开，不附带任何专有协议或限制，欢迎社区伙伴自由交流与研究。
