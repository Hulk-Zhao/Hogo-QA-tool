# `.probe/` —— 真机验收脚本（作者的工作台，不是产品代码）

这个目录里是**真浏览器（Chrome CDP）真机验收**脚本：每条修复都要求在真实页面上证明有效，
而不是只在 jsdom 里绿。它们解释了仓库里那些「实测数字」是怎么来的。

## 两条规则

1. **脚本入库，产物不入库**：`*.mjs / *.ts / *.py` 是脚本（保留）；
   同目录的 `*.json / *.txt` 是某台机器某次运行的输出（已在 `.gitignore` 中忽略）。
   想看某个数字怎么来的，重跑对应脚本即可。
2. **多数脚本写死了作者本机环境**（Chrome 路径、`E:/tools/Hogo-QA-tool`、端口、临时 profile），
   在自己的机器上跑之前先改这两个常量：

   ```js
   const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'; // 你的 Chrome
   const ROOT   = 'E:/tools/Hogo-QA-tool';                                  // 你的仓库路径
   ```

   端口段也各脚本不同（多在 87xx–95xx），同时跑多个脚本前先确认没撞端口。

## 开箱可用的两个

```bash
node .probe/make-defect-xlsx.mjs   # 生成一份样例 xlsx（缺陷数据）
node .probe/mock-ai-server.mjs     # 起一个 OpenAI 兼容的桩 LLM，用于离线验证 AI 链路
```

## 真 LLM 验收（需要你自己的 key）

```bash
# 三种给 key 的方式任选其一：环境变量 / .secrets/deepseek.key / Windows 用户变量
node .probe/p9-real-llm.mjs
```

它会列出服务端**真实可用**的模型名、预检 `chat/completions`，再驱动真页面跑一遍
「数据问答」与「一键全面诊断」，断言回复点名了子组编号与判异规则、没有推诿话术、
引用的图表**真的画出来了**。没配 key 时打印用法并 `exit 2`，不算失败。

它刻意走 `--no-proxy-server` **直连** —— 所以「探针绿、界面红」指向你的代理 / VPN 那一层。

## 常用脚本对照

| 脚本 | 作用 |
|---|---|
| `p0-verify.mjs` ~ `p9-*.mjs` | 各轮迭代的真机验收（编号即迭代轮次） |
| `p7-chat-window.mjs` / `p9-ai-stream.mjs` | AI 助手对话视窗、断流与「停止」按钮 |
| `p8-ai-context.mjs` | 提问时发送的上下文与图表引用渲染 |
| `p4-print-truth.mjs` / `p6-print-pages.mjs` | 打印分页与纸上限（真实 print 媒体路径） |
| `p5-docx-check.py` / `p6-docx-charts-verify.py` | 用 python-docx 独立核对 Word 产物（第三方视角） |
| `cdp-drive.mjs` | 最小 CDP 驱动，其它脚本的底座 |