// ==UserScript==
// @name         U校园 自动答题
// @namespace    https://github.com/nai-xu/u-campus-auto-answer
// @version      0.3.2
// @description  U校园教材/单元测试：识别选择、选词填空、填空/写作、翻译题，调用大模型生成答案并填入
// @author       Nai Xu
// @match        https://ucontent.unipus.cn/*
// @match        https://uai.unipus.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_log
// @grant        window.onurlchange
// @connect      api.deepseek.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* ==UserConfig==
模型:
  apiKey:
    title: DeepSeek API Key
    description: platform.deepseek.com 申请，只存在本机脚本存储
    type: password
    default: ''
  model:
    title: 模型
    default: deepseek-chat
  temperature:
    title: 温度
    type: number
    min: 0
    max: 2
    default: 0.2
行为:
  autoSubmit:
    title: 生成后自动提交
    description: 关掉时只填入，由你检查后手动点「提 交」
    type: checkbox
    default: false
  delayMs:
    title: 每题间隔(毫秒)
    type: number
    min: 0
    max: 20000
    default: 600
==/UserConfig== */

(function () {
  "use strict";

  const SEL = {
    reply: ".question-common-abs-reply",
    choiceWrap: ".question-common-abs-choice",
    stem: ".ques-title",
    option: ".option",
    caption: ".caption",
    optionText: ".content",
    inputbox: ".question-inputbox",
    inputHeader: ".question-inputbox-header",
    input: "textarea.question-inputbox-input, input.question-inputbox-input",
    bankedScope: ".question-abs-material-banked-cloze",
    bankedScoop: ".question-material-banked-cloze-scoop",
    bankedWord: ".question-material-banked-cloze-reply .option",
    scoop: ".fe-scoop",
    scoopNo: ".question-number",
    scoopInput: ".comp-abs-input input",
    directions: ".layout-direction-container",
    passage: ".question-common-abs-material",
    submit: "footer a.btn",
    modalBtn: ".ant-modal button",
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let stopRequested = false;

  /* ---------------- 面板 ---------------- */

  GM_addStyle(`
    #uca-panel{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:280px;
      font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif;color:#e8e8e8;
      background:#1f2330;border:1px solid #333a4d;border-radius:10px;
      box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden}
    #uca-panel header{display:flex;align-items:center;justify-content:space-between;
      padding:8px 10px;background:#262b3b;cursor:pointer}
    #uca-panel header b{font-weight:600;font-size:13px}
    #uca-panel header span{opacity:.6;padding:0 4px}
    #uca-body{padding:10px}
    #uca-status{min-height:32px;margin-bottom:8px;color:#9fb0d0;word-break:break-all;white-space:pre-wrap}
    #uca-panel button{width:100%;margin-top:6px;padding:7px 8px;border:0;border-radius:6px;
      background:#3b82f6;color:#fff;font-size:13px;cursor:pointer}
    #uca-panel button.ghost{background:#333a4d;color:#c9d2e4}
    #uca-panel button:disabled{opacity:.45;cursor:not-allowed}
    #uca-log{max-height:110px;overflow:auto;margin-top:8px;font-size:12px;color:#8b98b3;
      border-top:1px solid #2c3242;padding-top:6px}
    #uca-log div{padding:1px 0;word-break:break-all}
  `);

  const panel = document.createElement("div");
  panel.id = "uca-panel";
  panel.innerHTML = `
    <header><b>U校园 自动答题</b><span data-act="toggle">—</span></header>
    <div id="uca-body">
      <div id="uca-status">准备就绪</div>
      <button data-act="run">识别并作答本页</button>
      <button data-act="submit" class="ghost">提交</button>
      <button data-act="stop" class="ghost">停止</button>
      <div id="uca-log"></div>
    </div>`;

  const statusEl = panel.querySelector("#uca-status");
  const logEl = panel.querySelector("#uca-log");

  const setStatus = (text) => (statusEl.textContent = text);
  function log(text) {
    const line = document.createElement("div");
    line.textContent = text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    GM_log("[U校园] " + text, "info");
  }
  function mount() {
    if (!document.getElementById("uca-panel")) document.body.appendChild(panel);
  }

  /* ---------------- 关闭遮挡弹窗 ---------------- */

  function dismissModals() {
    let n = 0;
    document.querySelectorAll(SEL.modalBtn).forEach((b) => {
      if (/我知道了|知道了|确定|关闭/.test(b.innerText || "")) {
        b.click();
        n++;
      }
    });
    return n;
  }

  /* ---------------- 扫描题目 ---------------- */

  function readDirections() {
    for (const el of document.querySelectorAll(SEL.directions)) {
      if (!visible(el)) continue;
      const t = ((el.innerText || "") || "").trim();
      if (t) return t.slice(0, 1500);
    }
    return "";
  }

  // 阅读理解类页面在题目之外还有一篇共享正文（.question-common-abs-material），
  // 不带进 prompt 模型就没法答词义题和推断题
  function readPassage() {
    let best = "";
    document.querySelectorAll(SEL.passage).forEach((el) => {
      if (!visible(el)) return;
      const t = ((el.innerText || "") || "").trim();
      if (t.length > best.length) best = t;
    });
    return best.slice(0, 3000);
  }

  // 把段落里的空替换成 __1__ 这样的标记（按 DOM 顺序编号，与页面上的 1) 2) 对得上，
  // 不用页面自己的 .question-number —— 实测它取到的是 0，会导致编号错位）
  function passageWithMarks(scope) {
    const clone = scope.cloneNode(true);
    clone.querySelectorAll(SEL.scoop).forEach((s, i) => {
      const holder = document.createElement("span");
      holder.textContent = " __" + (i + 1) + "__ ";
      s.replaceWith(holder);
    });
    return (clone.textContent || "").replace(/\s+/g, " ").trim().slice(0, 2600);
  }

  // 切页签后 React 会把旧页签的 DOM 留在文档里（只是 display:none），
  // 不过滤可见性就会把上一页的题重复算进来
  function visible(el) {
    return !!el && el.getClientRects().length > 0;
  }

  function scan() {
    const tasks = [];

    document.querySelectorAll(SEL.reply).forEach((node) => {
      if (!visible(node)) return;
      const choice = node.querySelector(SEL.choiceWrap);
      if (choice) {
        const stem = ((choice.querySelector(SEL.stem) || {}).innerText || "").trim();
        const options = Array.from(choice.querySelectorAll(SEL.option)).map((o) => ({
          cap: ((o.querySelector(SEL.caption) || {}).innerText || "").trim(),
          text: ((o.querySelector(SEL.optionText) || {}).innerText || "").trim(),
          el: o,
        }));
        if (stem && options.length) tasks.push({ kind: "choice", stem, options });
        return;
      }
      const box = node.querySelector(SEL.inputbox);
      if (box) {
        const stem = ((box.querySelector(SEL.inputHeader) || {}).innerText || "").trim();
        const input = box.querySelector(SEL.input);
        if (stem && input) tasks.push({ kind: "text", stem, input });
      }
    });

    document.querySelectorAll(SEL.bankedScope).forEach((scope) => {
      if (!visible(scope)) return;
      const raw = document.querySelectorAll(SEL.bankedWord);
      const words = Array.from(raw).map((w) => (w.innerText || "").trim()).filter(Boolean);
      const scoops = Array.from(scope.querySelectorAll(SEL.scoop)).map((s, i) => ({
        no: (((s.querySelector(SEL.scoopNo) || {}).innerText || "").replace(/\D/g, "")) || String(i + 1),
        input: s.querySelector(SEL.scoopInput),
      })).filter((s) => s.input);
      if (scoops.length) {
        tasks.push({
          kind: "banked",
          words,
          scoops,
          passage: passageWithMarks(scope.querySelector(SEL.bankedScoop) || scope),
        });
      }
    });

    return tasks;
  }

  function describe(tasks) {
    const c = { choice: 0, text: 0, banked: 0 };
    tasks.forEach((t) => c[t.kind]++);
    const parts = [];
    if (c.choice) parts.push(c.choice + " 选择题");
    if (c.banked) parts.push(c.banked + " 选词填空");
    if (c.text) parts.push(c.text + " 填空/写作");
    return parts.join(" + ") || "无题";
  }

  // 浏览器的自动翻译会把英文原文整段替换成中文（DOM 里只剩译文，原文拿不回来），
  // 题干一旦被翻，词形辨析题就没法做了，所以先拦一道
  function uiIsTranslated() {
    const tabs = Array.from(document.querySelectorAll(".pc-header-tab-default"))
      .map((e) => (e.innerText || "").trim()).join("|");
    return /[\u4e00-\u9fff]/.test(tabs);
  }

  /* ---------------- 写页面 ---------------- */

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function applyChoice(task, answer) {
    const letters = new Set(String(answer || "").toUpperCase().replace(/[^A-Z]/g, "").split(""));
    let hit = 0;
    task.options.forEach((o) => {
      if (letters.has(o.cap.toUpperCase())) {
        o.el.click();
        hit++;
      }
    });
    return hit;
  }

  function applyBanked(task, answers) {
    let hit = 0;
    task.scoops.forEach((s, i) => {
      const w = answers[i];
      if (w) {
        setNativeValue(s.input, String(w).trim());
        hit++;
      }
    });
    return hit;
  }

  function clickSubmit() {
    dismissModals();
    const btn = Array.from(document.querySelectorAll(SEL.submit)).find((a) => /提\s*交/.test(a.innerText || ""));
    if (!btn) {
      log("没找到「提 交」按钮");
      return false;
    }
    btn.click();
    log("已点击提交");
    return true;
  }

  /* ---------------- 大模型 ---------------- */

  function askModel(system, user) {
    const apiKey = (GM_getValue("模型.apiKey", "") || "").trim();
    const model = GM_getValue("模型.model", "deepseek-chat") || "deepseek-chat";
    const temperature = Number(GM_getValue("模型.temperature", 0.2));
    if (!apiKey) return Promise.reject(new Error("没填 API Key（脚本设置 → 模型 → DeepSeek API Key）"));

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: "https://api.deepseek.com/chat/completions",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        data: JSON.stringify({
          model,
          temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        timeout: 60000,
        onload(res) {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error("HTTP " + res.status + " " + String(res.responseText).slice(0, 160)));
            return;
          }
          try {
            const data = JSON.parse(res.responseText);
            const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            if (!text) reject(new Error("返回里没有内容"));
            else resolve(text.trim());
          } catch (e) {
            reject(new Error("响应解析失败: " + e.message));
          }
        },
        onerror: () => reject(new Error("网络错误")),
        ontimeout: () => reject(new Error("请求超时")),
      });
    });
  }

  function parseJson(text) {
    const s = String(text).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try {
      return JSON.parse(s);
    } catch (_) {}
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {}
    }
    return null;
  }

  async function solveChoice(directions, task, passage) {
    const opts = task.options.map((o) => o.cap + ". " + o.text).join("\n");
    const out = await askModel(
      '你是英语教材助教。只输出 JSON，形如 {"answer":"B"}，不要解释。',
      (passage ? "阅读材料:\n" + passage + "\n\n" : "") +
        (directions ? "Directions:\n" + directions + "\n\n" : "") +
        "题目:\n" + task.stem + "\n\n选项:\n" + opts +
        "\n\n若为多选，answer 写成 \"AC\" 这样的字母串。"
    );
    const obj = parseJson(out);
    const answer = obj && obj.answer ? obj.answer : (out.match(/[A-D]/g) || []).join("");
    if (!answer) throw new Error("没解析出选项字母: " + out.slice(0, 60));
    return answer;
  }

  async function solveText(directions, task, passage) {
    const out = await askModel(
      '你是英语教材的助教。只输出 JSON，形如 {"answer":"..."}，不要解释。',
      (passage ? "参考材料:\n" + passage + "\n\n" : "") +
        (directions ? "Directions:\n" + directions + "\n\n" : "") + "题目:\n" + task.stem +
        "\n\n要求：英文作答，只给最终答案本身；若题目要求翻译成中文，就给中文译文。"
    );
    const obj = parseJson(out);
    const answer = obj && obj.answer ? obj.answer : out;
    if (!answer) throw new Error("空答案");
    return String(answer).trim();
  }

  async function solveBanked(directions, task) {
    const out = await askModel(
      '你是英语教材的助教。只输出 JSON，形如 {"answers":["word1","word2"]}，按空号从小到大排列，每个空一个词，不要解释。',
      (directions ? "Directions:\n" + directions + "\n\n" : "") +
        "可选词库（每个词最多用一次）:\n" + task.words.join(", ") +
        "\n\n段落（__n__ 是第 n 个空）:\n" + task.passage +
        "\n\n共 " + task.scoops.length + " 个空，请给出 " + task.scoops.length + " 个答案。"
    );
    const obj = parseJson(out);
    let answers = obj && Array.isArray(obj.answers) ? obj.answers : null;
    if (!answers) answers = out.split(/[\n,]/).map((s) => s.replace(/[^A-Za-z'-]/g, "")).filter(Boolean);
    if (!answers || !answers.length) throw new Error("没解析出选词答案");
    return answers;
  }

  /* ---------------- 主流程 ---------------- */

  async function run() {
    stopRequested = false;
    logEl.textContent = "";
    dismissModals();
    if (uiIsTranslated()) {
      const msg = "页面被浏览器翻译成中文了，英文原文已被替换。点地址栏的翻译图标 →「显示原文」，再点一次。";
      setStatus(msg);
      GM_notification({ title: "U校园 自动答题", text: msg });
      return;
    }
    const tasks = scan();
    if (!tasks.length) {
      setStatus("本页没识别到题目。确认停在有题的页签（如 Exercise 1 / Banked cloze）。");
      return;
    }
    const directions = readDirections();
    const passage = readPassage();
    setStatus("识别到 " + describe(tasks) + "，开始作答…");
    log("识别：" + describe(tasks) + (passage ? "（含阅读材料 " + passage.length + " 字符）" : ""));
    const delay = Number(GM_getValue("行为.delayMs", 600)) || 600;

    let done = 0;
    let failed = 0;
    for (let i = 0; i < tasks.length; i++) {
      if (stopRequested) {
        setStatus("已停止（完成 " + done + " 题）");
        return;
      }
      const t = tasks[i];
      setStatus("作答 " + (i + 1) + "/" + tasks.length + "（" + describe([t]) + "）…");
      try {
        if (t.kind === "choice") {
          const ans = await solveChoice(directions, t, passage);
          const hit = applyChoice(t, ans);
          log("第 " + (i + 1) + " 题 选择 " + ans + "（点中 " + hit + " 项）");
        } else if (t.kind === "text") {
          const ans = await solveText(directions, t, passage);
          setNativeValue(t.input, ans);
          log("第 " + (i + 1) + " 题：" + ans.slice(0, 70));
        } else {
          const ans = await solveBanked(directions, t);
          const hit = applyBanked(t, ans);
          log("第 " + (i + 1) + " 题 选词 " + hit + "/" + t.scoops.length + "：" + ans.join(", "));
        }
        done++;
      } catch (err) {
        failed++;
        log("第 " + (i + 1) + " 题失败：" + (err && err.message ? err.message : String(err)));
        if (/API Key/.test(String(err && err.message))) {
          setStatus(String(err.message));
          return;
        }
      }
      await sleep(delay);
    }

    setStatus("完成 " + done + " 题" + (failed ? "，失败 " + failed + " 题" : "") + "。检查后点「提交」。");
    if (done && GM_getValue("行为.autoSubmit", false)) {
      await sleep(600);
      clickSubmit();
    }
  }

  /* ---------------- 外部注入（无 Key 时用） ---------------- */

  function fillFromExternal(detail) {
    const tasks = scan();
    if (!tasks.length) {
      setStatus("当前页没识别到题目");
      return;
    }
    const payload = detail || {};
    const byIndex = Array.isArray(payload.answers) ? payload.answers : null;
    let n = 0;
    tasks.forEach((t, i) => {
      const item = byIndex ? byIndex[i] : null;
      if (item == null) return;
      if (t.kind === "choice") n += applyChoice(t, item) ? 1 : 0;
      else if (t.kind === "text") {
        setNativeValue(t.input, String(item));
        n++;
      } else if (Array.isArray(item)) n += applyBanked(t, item) ? 1 : 0;
    });
    setStatus("外部注入：处理 " + n + "/" + tasks.length + " 题");
  }

  document.addEventListener("uca:fill", (e) => fillFromExternal(e && e.detail));
  document.addEventListener("uca:scan", () => {
    const tasks = scan();
    setStatus("扫描结果：" + describe(tasks));
  });

  /* ---------------- 事件 ---------------- */

  panel.addEventListener("click", (e) => {
    const act = e.target && e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === "toggle") {
      const body = panel.querySelector("#uca-body");
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      e.target.textContent = hidden ? "—" : "+";
      return;
    }
    if (act === "run") run();
    if (act === "stop") {
      stopRequested = true;
      setStatus("正在停止…");
    }
    if (act === "submit") clickSubmit();
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();

  window.addEventListener("urlchange", () => {
    stopRequested = true;
    setTimeout(mount, 800);
  });
})();