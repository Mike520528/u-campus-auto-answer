---
name: u-campus-auto-answer
description: 在 U校园（ucontent.unipus.cn / uai.unipus.cn）的教材页与单元测试页上自动作答——识别单选/多选、选词填空、短语变形、填空写作翻译、Task 改写六类题目，调大模型生成答案并按页面要求的控件类型填入，可选自动提交。触发词：U校园、unipus、ucontent、教材答案、单元测试答案、自动答题、刷题、unipus auto answer。
---

# U校园 自动答题 —— 给 AI agent 的操作手册

这是一个**脚本猫用户脚本**（`u-campus-auto-answer.user.js`），不是命令行工具。它跑在用户的浏览器里，用用户自己的登录态和 API Key。agent 能做的是：把它装进用户的脚本猫、验证它正常注入、调试它的选择器。

## 前置条件

1. 脚本猫 **v1.5.0+**（低版本读不到 `==UserConfig==`，配置项会显示成原始变量名，仍能跑但要手填）。
2. 用户在浏览器里**已登录 U校园**（`sso.unipus.cn` 的 jwt 在 cookie 里）。
3. 用户有一个 DeepSeek API Key，填在脚本设置里。没 key 时能识别题目但生成不了答案。
4. 浏览器**没有开着自动翻译**。翻译后题干英文原文在 DOM 里被替换成 `_msttexthash`，脚本会主动拒绝执行。

## 安装

```bash
# 脚本猫已和 sctl 配对时（推荐）
sctl install "<绝对路径>/u-campus-auto-answer.user.js"
```

`sctl install` 会在浏览器里打开 `chrome-extension://<脚本猫 id>/src/install.html` 的确认页，**必须由人在页面上点「安装 / 更新」**——扩展页面不允许跨扩展注入，脚本点不动它。装完 sctl 会返回：

```
installed: U校园 自动答题 (<uuid>) version= enabled=true
```

装完核对版本（安装返回里 version 字段是空的）：

```bash
sctl get <uuid> -o json | grep version
```

也可以用桌面自动化点确认页的按钮，但按钮位置随窗口大小变，先截图定位。

## 验证

```bash
# 1. 页面注入了没有
sctl page eval --tab <tab> "document.querySelector('#uca-panel')?.innerText"
# 期望：U校园 自动答题 / 准备就绪 / 识别并作答本页 提交 停止

# 2. 有没有报错
sctl debug console --tab <tab> --level error
# 期望：只有第三方 SDK 的 Permissions policy violation，脚本自身零报错

# 3. 扫一遍当前页能识别多少题（只读，不填）
sctl page eval --tab <tab> "document.dispatchEvent(new CustomEvent('uca:scan')), document.querySelector('#uca-status').innerText"
```

## 页面结构速查（改选择器时看这张表）

| 元素 | 选择器 | 备注 |
|---|---|---|
| 主内容 | `main.pc-content-container` / `.question-wrap` | 都命中，取并集 |
| 题干 | `.component-htmlview.ques-title` | 选择题用 |
| 选择题容器 | `.question-common-abs-choice` | |
| 选项 | `.option`，内含 `.caption`（A/B/C/D）+ `.component-htmlview.content` | 选中后 class 变 `option selected` |
| 选词填空容器 | `.question-abs-material-banked-cloze` | |
| 词库 | `.question-material-banked-cloze-reply .option` | 词库 DOM 里每个词出现两次，用这个选择器只取到一份 |
| 空 | `.question-material-banked-cloze-scoop span.fe-scoop > .comp-abs-input > input` | 非 readonly，可赋值 |
| 填空/写作 | `textarea.question-inputbox-input` | 右下角 `x/1000` 是**词数**不是字符数 |
| 阅读正文 | `.question-common-abs-material` | 取可见且最长的那个，截 3000 字符 |
| Directions | `.layout-direction-container` / `.layout-material-container` | Task 页和材料页不同 |
| 题型页签 | `.pc-header-tab-default.tab` 里面的 `.pc-tab-view-container` | **点外层无效，必须点内层** |
| 子页签 | `.pc-task` | 英文界面是 `Exercise 1`，中文界面是「练习1」 |
| 提交按钮 | `footer.ant-layout-footer a.btn` | 文本「提 交」，汉字间有空格，用 `/提\s*交/`；不是 `<button>` |
| 挡路弹窗 | `.ant-modal` 里文本含「我知道了」的按钮 | 切题型页签时会弹「本单元学习时间/是否必修」 |

## 调试通道

脚本监听两个自定义事件，用来绕过模型、直接验证「识别」和「填写」两段链路。

**`uca:scan`** —— 扫当前可见页签并把结果写进面板状态行（不返回值，要读 DOM）：

```bash
sctl page eval --tab <tab> "document.dispatchEvent(new CustomEvent('uca:scan')), document.querySelector('#uca-status').innerText"
# 期望形如：扫描结果：5 道选择题
```

**`uca:fill`** —— 按题目顺序给答案，`answers` 与 `scan()` 的题目下标一一对应：

```js
document.dispatchEvent(new CustomEvent('uca:fill', {
  detail: { answers: [
    'B',                                  // 第 1 题是 choice → 传字母
    'Some sentence.',                     // 第 2 题是 text   → 传字符串
    ['turn','likely','expected']          // 第 3 题是 banked → 传数组，按空顺序
  ]}
}));
```

类型不匹配的项会被跳过（`choice` 传数组、`banked` 传字符串都不生效），所以先用 `uca:scan` 看清这一页有哪几类题、各几道，再拼 `answers`。填完 `#uca-status` 会显示「外部注入：处理 n/m 题」。

填完读回验证：

```bash
# 选择题
sctl page eval --tab <tab> "Array.from(document.querySelectorAll('.question-common-abs-choice')).map(q=>q.querySelector('.option.selected .caption')?.textContent)"
# 选词填空
sctl page eval --tab <tab> "Array.from(document.querySelectorAll('.fe-scoop input')).map(i=>i.value)"
# 填空/写作
sctl page eval --tab <tab> "Array.from(document.querySelectorAll('.question-inputbox-input')).map(t=>t.value)"
```

## 坑

1. **React 受控组件不能直接 `el.value = x`**。要用
   `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, v)` + `dispatchEvent(new Event('input',{bubbles:true}))`，脚本里的 `setNativeValue()` 就是干这个的。
2. **切页签后旧页 DOM 还在**（`display:none`），扫描必须过滤可见性：`el.getClientRects().length > 0`。
3. **切换题型页签会弹模态框**，挡住后续点击，要自动点掉「我知道了」。
4. **Edge 的自动翻译会让英文题干彻底消失**（`innerHTML` 只剩译文 + `_msttexthash`），无法从 DOM 恢复。脚本检测到界面出现中文就拒绝执行。关闭路径：地址栏右侧「文A」→「显示原文」。
5. **`sctl page screenshot` 对后台标签页会报 `PAGE_HIDDEN`**，要加 `--activate`，或先用 pwsh `SetForegroundWindow` 把窗口提到前台。
6. **答案存在服务端草稿里**，刷新页面不会丢，别误以为是脚本注入失败。
7. 主观题（翻译、写作）的答案是模型生成的，**提交前应由人读一遍**。

## 已知未验证

- 真实提交后的判分结果（本机只验证到填入，没点提交看分）。
- 跨页签连续自动遍历（当前是「识别并作答本页」，一页一页来）。
- `https://uai.unipus.cn/*` 作业页的题型结构（只按 `ucontent.unipus.cn` 的教材页写过）。