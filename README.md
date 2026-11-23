# U校园 自动答题

一个脚本猫（ScriptCat / Tampermonkey）用户脚本：在 U校园 教材页和单元测试页上**识别题目 → 让大模型生成答案 → 填进页面**，可选自动提交。

跑在你自己的浏览器里，用的是你自己的登录态和你自己的 API Key。

## 覆盖的题型

| 题型 | 页面上的样子 | 脚本怎么处理 |
|---|---|---|
| 单项/多项选择 | `.question-common-abs-choice`，A/B/C/D 选项 | 让模型返回字母，脚本点 `.option.selected` |
| 选词填空（Banked cloze） | 词库 + 段落里若干 `span.fe-scoop > input` | 模型返回一空一个词，逐空填 `input` |
| 短语变形填空 | 同上结构，但 Directions 要求 "change the form" | 同上，模型按语境变形 |
| 填空 / 写作 / 翻译 | `textarea.question-inputbox-input` | 模型返回整句，写进 textarea |
| 改写句子（Task 页） | 同上，6 道开放式改写 | 同上 |

考卷里出现新题型时脚本会报「本页没有识别到题目」，不会乱填。

## 安装

### 方式一：脚本猫（推荐）

1. 装 [脚本猫](https://scriptcat.org/)（v1.5.0+ 才认 `==UserConfig==` 配置块）。
2. 把 `u-campus-auto-answer.user.js` 拖进浏览器窗口，或在脚本猫管理面板里「导入脚本」。
3. 首次安装会让你确认权限：`GM_xmlhttpRequest`（调模型）、`GM_getValue`/`GM_setValue`（存设置）、`GM_addStyle`（面板样式）、`GM_notification`、`GM_log`、`window.onurlchange`。

### 方式二：用 sctl 命令行装

```bash
sctl install "<仓库目录>/u-campus-auto-answer.user.js"
```

会弹出脚本猫的安装确认页，需要你本人点一下「安装 / 更新」（这一步不能自动化，扩展页面不允许脚本注入）。

### 方式三：Tampermonkey

同样拖入即可，配置项会显示成原始变量名（Tampermonkey 不认 `==UserConfig==`），在「设置」里手填。

## 配置

脚本猫管理面板 → 找到「U校园 自动答题」→「设置」：

| 分组 | 项 | 说明 |
|---|---|---|
| 模型 | `apiKey` | DeepSeek 的 key，[platform.deepseek.com](https://platform.deepseek.com) 申请。只存在本机脚本存储里，不上传 |
| 模型 | `model` | 默认 `deepseek-chat` |
| 模型 | `temperature` | 默认 `0.2`，越低越稳 |
| 行为 | `autoSubmit` | 关（默认）时只填入，你检查完手动点「提 交」；开则填完自动提交 |
| 行为 | `delayMs` | 每题之间的间隔，默认 600 ms |

没有 key 时脚本能识别题目但不会生成答案，面板会提示。

## 使用

打开 U校园 的教材页或单元测试页，右下角会出现一个小面板：

1. **识别并作答本页** —— 扫描当前可见页签上的题目，逐题调模型、填答案。
2. **提交** —— 点页面底部的「提 交」（两个汉字之间有空格，脚本用 `/提\s*交/` 匹配）。
3. **停 止** —— 中途叫停。

一道题填完会在面板日志里留一行「第 n 题：B ✓」之类。填错了可以直接在页面上改，脚本不会覆盖你已经手改过的输入。

## 几个坑

- **浏览器翻译会毁掉英文原文**。Edge/Chrome 自动翻译后，题干元素的 `innerHTML` 变成中文译文加 `_msttexthash`，英文原文在 DOM 里已经不存在，词形辨析题直接失去意义。脚本会检测这种状态并拒绝执行，提示你先点地址栏的「文A」图标 →「显示原文」。
- **切换题型页签后，上一页的 DOM 还在文档里（只是 `display:none`）**。脚本用 `getClientRects().length > 0` 过滤可见性，只处理当前页签的题。
- **刷新不丢答案**。U校园 把已填内容存在服务端草稿里，刷新后题目里仍是上次的内容。
- **答案需要你自己核对**。模型生成的主观题（翻译、写作）尤其要读一遍再提交。
- **只用你自己的账号**。脚本不改任何成绩判定逻辑，只填答案。

## 给其他 agent 用

这个仓库同时是一个 skill，`SKILL.md` 里写了「怎么装、怎么验证、怎么调试」的操作流程。给 agent 接：

```bash
git clone https://github.com/Mike520528/u-campus-auto-answer ~/.agents/skills/u-campus-auto-answer
```

私有仓库需要先认证：`gh auth login`，或用 `https://<token>@github.com/Mike520528/u-campus-auto-answer` 拉。

## 文件

| 文件 | 说明 |
|---|---|
| `u-campus-auto-answer.user.js` | 脚本本体，单文件，无依赖 |
| `SKILL.md` | 给 AI agent 看的操作手册 |
| `安装说明.md` | 给同学看的一页纸（含四类题型对照、三步使用、四个坑） |

## 现状

版本 0.3.2。已在本机实测：Vocabulary Exercise 1/2、Banked cloze、Reading comprehension、Translation、Task 改写六类页面全部识别正确，25 处作答值与注入值逐项一致（5/5、7/7、5/5、3/3、6/6）。

**未验证**：真实提交后的判分结果、跨页签连续自动遍历、DeepSeek 接口在同学机器上的连通性。