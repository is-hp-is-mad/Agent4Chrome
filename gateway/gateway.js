/* gateway.js — 网关登录 + 自定义模型配置界面
 * 配置存储于 chrome.storage.local.gatewayConfig（与 gateway/shim.js 共享）
 */
(function () {
  "use strict";

  var CFG_KEY = "gatewayConfig";

  /* ---------------- 工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function val(id) { return $(id).value.trim(); }
  function numOrNull(v) {
    v = String(v).trim();
    if (v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function tryJson(text, label) {
    var t = String(text || "").trim();
    if (!t) return {};
    try {
      var o = JSON.parse(t);
      if (!o || typeof o !== "object") throw new Error("必须是 JSON 对象");
      return o;
    } catch (e) {
      throw new Error(label + " JSON 无效：" + e.message);
    }
  }
  function splitList(text) {
    return String(text || "")
      .split(/[,\n]/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function defaultConfig() {
    return {
      version: 1,
      baseUrl: "",
      apiKey: "",
      authType: "x-api-key",
      anthropicVersion: "2023-06-01",
      extraHeaders: {},
      betas: [],
      gatewayNoStream: false,
      unknownModelPolicy: "map-default",
      defaultModel: "",
      fastModel: "",
      models: []
    };
  }

  function defaultModel() {
    return {
      id: "",
      apiModel: "",
      name: "",
      description: "",
      knowledgeCutoff: "",
      inference: {
        temperature: null,
        top_p: null,
        top_k: null,
        max_output_tokens: null,
        stop_sequences: [],
        thinking: "off",
        thinking_budget: 2048,
        thinking_effort: "medium",
        systemAppend: "",
        extra: {}
      },
      modalities: { vision: true, documents: true, tools: true, thinking: true, caching: true }
    };
  }

  var cfg = defaultConfig();

  function loadCfg() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(CFG_KEY, function (r) {
        if (r && r[CFG_KEY]) {
          cfg = Object.assign(defaultConfig(), r[CFG_KEY]);
          cfg.models = Array.isArray(cfg.models) ? cfg.models : [];
        }
        resolve(cfg);
      });
    });
  }

  function saveCfg() {
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [CFG_KEY]: cfg }, resolve);
    });
  }

  /* ---------------- 顶部状态 ---------------- */
  function renderStatus() {
    var badge = $("statusBadge");
    if (cfg.baseUrl && cfg.apiKey && cfg.models.length) {
      badge.textContent = "已配置 · " + cfg.models.length + " 个模型";
      badge.className = "badge badge-on";
    } else if (cfg.baseUrl && cfg.apiKey) {
      badge.textContent = "已登录 · 未添加模型";
      badge.className = "badge badge-warn";
    } else {
      badge.textContent = "未配置";
      badge.className = "badge badge-off";
    }
  }

  /* ---------------- 网关登录表单 ---------------- */
  function fillLoginForm() {
    $("baseUrl").value = cfg.baseUrl || "";
    $("apiKey").value = cfg.apiKey || "";
    $("authType").value = cfg.authType || "x-api-key";
    $("anthropicVersion").value = cfg.anthropicVersion || "2023-06-01";
    $("unknownModelPolicy").value = cfg.unknownModelPolicy || "map-default";
    $("gatewayNoStream").checked = !!cfg.gatewayNoStream;
    $("extraHeaders").value = JSON.stringify(cfg.extraHeaders || {}, null, 2);
    $("betas").value = (cfg.betas || []).join(", ");
    $("systemPrompt").value = cfg.systemPrompt || "";
  }

  function readLoginForm() {
    cfg.baseUrl = val("baseUrl").replace(/\/+$/, "");
    cfg.apiKey = val("apiKey");
    cfg.authType = $("authType").value;
    cfg.anthropicVersion = val("anthropicVersion") || "2023-06-01";
    cfg.unknownModelPolicy = $("unknownModelPolicy").value;
    cfg.gatewayNoStream = $("gatewayNoStream").checked;
    cfg.extraHeaders = tryJson($("extraHeaders").value, "附加请求头");
    cfg.betas = splitList($("betas").value);
    cfg.systemPrompt = $("systemPrompt").value.trim();
  }

  function msg(el, text, ok) {
    el.textContent = text;
    el.className = "msg " + (ok ? "ok" : "err");
    if (ok) setTimeout(function () { if (el.textContent === text) el.textContent = ""; }, 6000);
  }

  /* ---------------- 测试连接 ---------------- */
  function apiRoot(base) {
    base = String(base).replace(/\/+$/, "");
    return /\/v1$/.test(base) ? base : base + "/v1";
  }

  function authHeaders() {
    var h = { "content-type": "application/json", "anthropic-version": cfg.anthropicVersion || "2023-06-01" };
    if (cfg.authType === "bearer") h["Authorization"] = "Bearer " + cfg.apiKey;
    else h["x-api-key"] = cfg.apiKey;
    Object.keys(cfg.extraHeaders || {}).forEach(function (k) {
      if (cfg.extraHeaders[k] !== null) h[k] = String(cfg.extraHeaders[k]);
    });
    return h;
  }

  $("testBtn").addEventListener("click", function () {
    var m = $("loginMsg");
    try {
      readLoginForm();
      if (!cfg.baseUrl || !cfg.apiKey) throw new Error("请先填写网关地址与 API Key");
      var model = cfg.models[0] ? (cfg.models[0].apiModel || cfg.models[0].id) : "claude-sonnet-4-5";
      msg(m, "测试中…", true);
      var t0 = Date.now();
      fetch(apiRoot(cfg.baseUrl) + "/messages", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: model,
          max_tokens: 16,
          messages: [{ role: "user", content: "ping" }]
        })
      }).then(function (res) {
        return res.text().then(function (text) {
          var ms = Date.now() - t0;
          if (res.ok) {
            var info = "";
            try {
              var j = JSON.parse(text);
              info = " 返回模型：" + (j.model || "?");
            } catch (e) {}
            msg(m, "✔ 连接成功（HTTP " + res.status + "，" + ms + "ms）" + info, true);
          } else {
            msg(m, "✘ HTTP " + res.status + "：" + text.slice(0, 300), false);
          }
        });
      }).catch(function (e) {
        msg(m, "✘ 连接失败：" + e.message, false);
      });
    } catch (e) {
      msg(m, "✘ " + e.message, false);
    }
  });

  function notifySaved() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "gateway-config-saved" }, "*");
      }
    } catch (e) {}
  }

  /* ---------------- 获取网关模型列表 ---------------- */
  $("listModelsBtn").addEventListener("click", function () {
    var m = $("loginMsg");
    var box = $("modelListRemote");
    try {
      readLoginForm();
      if (!cfg.baseUrl || !cfg.apiKey) throw new Error("请先填写网关地址与 API Key");
      msg(m, "拉取中…", true);
      fetch(apiRoot(cfg.baseUrl) + "/models", { method: "GET", headers: authHeaders() })
        .then(function (res) {
          return res.text().then(function (txt) {
            if (!res.ok) throw new Error("HTTP " + res.status + "：" + txt.slice(0, 200));
            var ids = [];
            try {
              var j = JSON.parse(txt);
              var arr = Array.isArray(j) ? j : (j.data || j.models || []);
              ids = arr.map(function (x) { return typeof x === "string" ? x : (x.id || x.model || x.name); }).filter(Boolean);
            } catch (e) { throw new Error("响应无法解析：" + txt.slice(0, 120)); }
            if (!ids.length) throw new Error("模型列表为空");
            box.innerHTML = "<div class='rm-title'>网关模型列表（点击任意一个填入「API 实际模型名」）：</div>";
            ids.forEach(function (id) {
              var b = document.createElement("button");
              b.className = "btn ghost sm rm-item";
              b.textContent = id;
              b.addEventListener("click", function () {
                $("m_apiModel").value = id;
                if (!$("m_id").value) $("m_id").value = id;
                box.classList.add("hidden");
                msg(m, "✔ 已填入 API 实际模型名：" + id, true);
              });
              box.appendChild(b);
            });
            box.classList.remove("hidden");
            msg(m, "✔ 获取到 " + ids.length + " 个模型", true);
          });
        })
        .catch(function (e) {
          msg(m, "✘ 获取失败：" + e.message, false);
          box.classList.add("hidden");
        });
    } catch (e) {
      msg(m, "✘ " + e.message, false);
    }
  });

  /* ---------------- 登录 / 退出 ---------------- */
  $("saveBtn").addEventListener("click", function () {
    var m = $("loginMsg");
    try {
      readLoginForm();
      if (!cfg.baseUrl) throw new Error("请填写网关地址");
      if (!cfg.apiKey) throw new Error("请填写 API Key");
      try { new URL(cfg.baseUrl); } catch (e) { throw new Error("网关地址不是合法 URL"); }
      saveCfg().then(function () {
        renderStatus();
        renderModelList();
        msg(m, "✔ 已保存并登录，侧边栏将自动恢复会话", true);
        notifySaved();
      });
    } catch (e) {
      msg(m, "✘ " + e.message, false);
    }
  });

  $("logoutBtn").addEventListener("click", function () {
    cfg.apiKey = "";
    $("apiKey").value = "";
    saveCfg().then(function () {
      renderStatus();
      msg($("loginMsg"), "已退出登录（网关地址与模型配置已保留）", true);
    });
  });

  $("toggleKey").addEventListener("click", function () {
    var inp = $("apiKey");
    var show = inp.type === "password";
    inp.type = show ? "text" : "password";
    this.textContent = show ? "隐藏" : "显示";
  });

  /* ---------------- 模型列表 ---------------- */
  function renderSelect(sel, value) {
    sel.innerHTML = "";
    cfg.models.forEach(function (m) {
      var o = document.createElement("option");
      o.value = m.id;
      o.textContent = (m.name || m.id) + "（" + m.id + "）";
      sel.appendChild(o);
    });
    if (value) sel.value = value;
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  }

  function renderModelList() {
    renderSelect($("defaultModelSel"), cfg.defaultModel);
    renderSelect($("fastModelSel"), cfg.fastModel);
    var list = $("modelList");
    list.innerHTML = "";
    if (!cfg.models.length) {
      list.innerHTML = '<div class="empty">还没有模型 — 点击「＋ 添加模型」创建第一个自定义模型</div>';
      return;
    }
    cfg.models.forEach(function (m, idx) {
      var card = document.createElement("div");
      card.className = "model-card";
      var mods = Object.keys(m.modalities || {}).filter(function (k) { return m.modalities[k]; });
      var inf = m.inference || {};
      var paramBits = [];
      if (inf.temperature !== null && inf.temperature !== undefined) paramBits.push("temperature=" + inf.temperature);
      if (inf.top_p !== null && inf.top_p !== undefined) paramBits.push("top_p=" + inf.top_p);
      if (inf.top_k !== null && inf.top_k !== undefined) paramBits.push("top_k=" + inf.top_k);
      if (inf.max_output_tokens) paramBits.push("max_tokens≤" + inf.max_output_tokens);
      if (inf.thinking === "budget") paramBits.push("thinking(budget=" + (inf.thinking_budget || 2048) + ")");
      if (inf.thinking === "effort") paramBits.push("thinking(effort=" + (inf.thinking_effort || "medium") + ")");

      card.innerHTML =
        '<div class="mc-main">' +
        '  <div class="mc-title">' +
        '    <strong>' + esc(m.name || m.id) + "</strong>" +
        '    <code>' + esc(m.id) + (m.apiModel && m.apiModel !== m.id ? " → " + esc(m.apiModel) : "") + "</code>" +
        (m.id === cfg.defaultModel ? '<span class="tag">默认</span>' : "") +
        (m.id === cfg.fastModel ? '<span class="tag tag-fast">快速</span>' : "") +
        "  </div>" +
        (m.description ? '<div class="mc-desc">' + esc(m.description) + "</div>" : "") +
        '  <div class="mc-meta">模态：' + esc(mods.join(" / ") || "文本") + "</div>" +
        (paramBits.length ? '<div class="mc-meta">推理：' + esc(paramBits.join("，")) + "</div>" : "") +
        "</div>" +
        '<div class="mc-actions">' +
        '  <button class="btn ghost sm" data-act="edit">编辑</button>' +
        '  <button class="btn ghost sm" data-act="default">设为默认</button>' +
        '  <button class="btn ghost sm" data-act="fast">设为快速</button>' +
        '  <button class="btn danger ghost sm" data-act="delete">删除</button>' +
        "</div>";
      card.querySelector('[data-act="edit"]').addEventListener("click", function () { openEditor(idx); });
      card.querySelector('[data-act="default"]').addEventListener("click", function () {
        cfg.defaultModel = m.id; saveCfg().then(renderModelList);
      });
      card.querySelector('[data-act="fast"]').addEventListener("click", function () {
        cfg.fastModel = m.id; saveCfg().then(renderModelList);
      });
      card.querySelector('[data-act="delete"]').addEventListener("click", function () {
        if (!confirm("删除模型 " + m.id + "？")) return;
        cfg.models.splice(idx, 1);
        if (cfg.defaultModel === m.id) cfg.defaultModel = cfg.models[0] ? cfg.models[0].id : "";
        if (cfg.fastModel === m.id) cfg.fastModel = cfg.defaultModel;
        saveCfg().then(renderModelList);
      });
      list.appendChild(card);
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  $("defaultModelSel").addEventListener("change", function () {
    cfg.defaultModel = this.value;
    saveCfg().then(renderModelList);
  });
  $("fastModelSel").addEventListener("change", function () {
    cfg.fastModel = this.value;
    saveCfg().then(renderModelList);
  });

  /* ---------------- 模型编辑器 ---------------- */
  var editingIdx = -1;

  function syncThinkingFields() {
    var v = $("m_thinking").value;
    $("thinkingBudgetField").style.display = v === "budget" ? "" : "none";
    $("thinkingEffortField").style.display = v === "effort" ? "" : "none";
  }
  $("m_thinking").addEventListener("change", syncThinkingFields);
  $("m_thinking_effort_preset").addEventListener("change", function () {
    if (this.value !== "custom") {
      $("m_thinking_effort").value = this.value;
    } else {
      $("m_thinking_effort").focus();
    }
  });

  function openEditor(idx) {
    editingIdx = typeof idx === "number" ? idx : -1;
    var m = editingIdx >= 0 ? JSON.parse(JSON.stringify(cfg.models[editingIdx])) : defaultModel();
    m.inference = Object.assign(defaultModel().inference, m.inference || {});
    m.modalities = Object.assign(defaultModel().modalities, m.modalities || {});

    $("editorTitle").textContent = editingIdx >= 0 ? "编辑模型：" + m.id : "添加模型";
    $("m_id").value = m.id;
    $("m_apiModel").value = m.apiModel || "";
    $("m_name").value = m.name || "";
    $("m_description").value = m.description || "";
    $("m_knowledgeCutoff").value = m.knowledgeCutoff || "";
    $("m_temperature").value = m.inference.temperature === null || m.inference.temperature === undefined ? "" : m.inference.temperature;
    $("m_top_p").value = m.inference.top_p === null || m.inference.top_p === undefined ? "" : m.inference.top_p;
    $("m_top_k").value = m.inference.top_k === null || m.inference.top_k === undefined ? "" : m.inference.top_k;
    $("m_max_output_tokens").value = m.inference.max_output_tokens || "";
    $("m_stop_sequences").value = (m.inference.stop_sequences || []).join("\n");
    $("m_thinking").value = m.inference.thinking || "off";
    $("m_thinking_budget").value = m.inference.thinking_budget || 2048;
    var eff = m.inference.thinking_effort || "medium";
    $("m_thinking_effort").value = eff;
    var presets = ["low", "medium", "high", "xhigh", "max"];
    if (presets.indexOf(eff) >= 0) {
      $("m_thinking_effort_preset").value = eff;
    } else {
      $("m_thinking_effort_preset").value = "custom";
    }
    $("m_systemAppend").value = m.inference.systemAppend || "";
    $("m_extra").value = JSON.stringify(m.inference.extra || {}, null, 2);
    $("m_mod_vision").checked = m.modalities.vision !== false;
    $("m_mod_documents").checked = m.modalities.documents !== false;
    $("m_mod_tools").checked = m.modalities.tools !== false;
    $("m_mod_thinking").checked = m.modalities.thinking !== false;
    $("m_mod_caching").checked = m.modalities.caching !== false;
    syncThinkingFields();

    $("modelEditor").classList.remove("hidden");
    $("modelEditor").scrollIntoView({ behavior: "smooth", block: "nearest" });
    $("m_id").focus();
  }

  $("addModelBtn").addEventListener("click", function () { openEditor(-1); });
  $("modelCancelBtn").addEventListener("click", function () {
    $("modelEditor").classList.add("hidden");
    $("modelMsg").textContent = "";
  });

  $("modelSaveBtn").addEventListener("click", function () {
    var mEl = $("modelMsg");
    try {
      var id = val("m_id");
      if (!id) throw new Error("模型 ID 不能为空");
      var dup = cfg.models.some(function (x, i) { return x.id === id && i !== editingIdx; });
      if (dup) throw new Error("模型 ID 已存在：" + id);

      var m = {
        id: id,
        apiModel: val("m_apiModel") || id,
        name: val("m_name") || id,
        description: val("m_description"),
        knowledgeCutoff: val("m_knowledgeCutoff"),
        inference: {
          temperature: numOrNull($("m_temperature").value),
          top_p: numOrNull($("m_top_p").value),
          top_k: numOrNull($("m_top_k").value),
          max_output_tokens: numOrNull($("m_max_output_tokens").value),
          stop_sequences: splitList($("m_stop_sequences").value),
          thinking: $("m_thinking").value,
          thinking_budget: numOrNull($("m_thinking_budget").value) || 2048,
          thinking_effort: $("m_thinking_effort").value,
          systemAppend: $("m_systemAppend").value.trim(),
          extra: tryJson($("m_extra").value, "附加请求体参数")
        },
        modalities: {
          vision: $("m_mod_vision").checked,
          documents: $("m_mod_documents").checked,
          tools: $("m_mod_tools").checked,
          thinking: $("m_mod_thinking").checked,
          caching: $("m_mod_caching").checked
        }
      };

      if (editingIdx >= 0) {
        var oldId = cfg.models[editingIdx].id;
        cfg.models[editingIdx] = m;
        if (cfg.defaultModel === oldId) cfg.defaultModel = m.id;
        if (cfg.fastModel === oldId) cfg.fastModel = m.id;
      } else {
        cfg.models.push(m);
      }
      if (!cfg.defaultModel) cfg.defaultModel = m.id;
      if (!cfg.fastModel) cfg.fastModel = m.id;

      saveCfg().then(function () {
        $("modelEditor").classList.add("hidden");
        renderModelList();
        renderStatus();
      });
    } catch (e) {
      msg(mEl, "✘ " + e.message, false);
    }
  });

  /* ---------------- 导入 / 导出 / 重置 ---------------- */
  $("exportBtn").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "claude-gateway-config.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("importInput").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(reader.result);
        cfg = Object.assign(defaultConfig(), obj);
        cfg.models = Array.isArray(obj.models) ? obj.models : [];
        saveCfg().then(function () {
          fillLoginForm();
          renderModelList();
          renderStatus();
          msg($("cfgMsg"), "✔ 配置已导入", true);
        });
      } catch (e) {
        msg($("cfgMsg"), "✘ 导入失败：" + e.message, false);
      }
    };
    reader.readAsText(f);
    this.value = "";
  });

  $("resetBtn").addEventListener("click", function () {
    if (!confirm("确定清空全部网关与模型配置？")) return;
    cfg = defaultConfig();
    saveCfg().then(function () {
      fillLoginForm();
      renderModelList();
      renderStatus();
      msg($("cfgMsg"), "已恢复默认", true);
    });
  });

  /* ---------------- 运行诊断 ---------------- */
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
  }

  function renderDiag() {
    chrome.storage.local.get(["gatewayShimStatus", "gatewayDiagnostics", "gatewayCallLog"], function (r) {
      var s = (r && r.gatewayShimStatus) || {};
      var el = $("shimStatus");
      if (!s.build) {
        el.innerHTML = "⚠ 未检测到垫片心跳 —— 请确认加载的是 <code>claude-gateway/</code> 目录（不是旧副本），并重载扩展";
      } else {
        var ctxs = Object.keys(s).filter(function (k) { return k !== "build"; }).map(function (k) {
          return k + "（" + fmtTime(s[k]) + "）";
        }).join("，") || "尚未有上下文上报";
        el.innerHTML = "✔ 垫片构建：<code>" + esc(s.build) + "</code> ／ 已激活上下文：" + esc(ctxs) +
          "　<span style='opacity:.7'>若构建号与预期不符，说明运行的仍是旧副本</span>";
      }
      var list = ((r && r.gatewayDiagnostics) || []).concat((r && r.gatewayCallLog) || []);
      list.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      var box = $("diagList");
      box.innerHTML = "";
      if (!list.length) {
        box.innerHTML = '<div class="empty">暂无错误记录</div>';
        return;
      }
      list.slice(0, 12).forEach(function (d) {
        var div = document.createElement("div");
        div.className = "diag-item" + (d.kind === "info" ? " diag-info" : "");
        div.innerHTML =
          '<div class="diag-head"><b>' + esc(d.kind) + '</b> · ' + esc(d.ctx) + ' · ' + fmtTime(d.ts) + '</div>' +
          '<div class="diag-msg">' + esc(d.message) + '</div>' +
          (d.stack ? '<pre class="diag-stack">' + esc(d.stack) + '</pre>' : '');
        box.appendChild(div);
      });
    });
  }

  $("diagRefreshBtn").addEventListener("click", renderDiag);
  $("diagClearBtn").addEventListener("click", function () {
    chrome.storage.local.remove(["gatewayDiagnostics", "gatewayCallLog"], renderDiag);
  });
  $("diagReloadBtn").addEventListener("click", function () {
    chrome.runtime.reload();
  });
  // 自动刷新：打开面板后回到本页即可看到最新心跳
  setInterval(renderDiag, 3000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) renderDiag();
  });

  /* ---------------- 全局网站权限（允许所有网站） ---------------- */
  var allowAllCheckbox = $("allowAllSitesCheckbox");
  if (allowAllCheckbox) {
    chrome.storage.local.get("gatewayAllowAllSites", function (r) {
      allowAllCheckbox.checked = !!(r && r.gatewayAllowAllSites);
    });
    allowAllCheckbox.addEventListener("change", function () {
      var enabled = allowAllCheckbox.checked;
      chrome.storage.local.set({ gatewayAllowAllSites: enabled }, function () {
        globalThis.__gatewayAllowAllSites = enabled;
      });
    });
  }

  /* ---------------- 历史会话管理 ---------------- */
  var cachedHistory = [];
  var activeConversation = null;

  function loadHistory() {
    return new Promise(function (resolve) {
      chrome.storage.local.get("gatewayChatHistory", function (r) {
        cachedHistory = Array.isArray(r && r.gatewayChatHistory) ? r.gatewayChatHistory : [];
        resolve(cachedHistory);
      });
    });
  }

  function renderHistory() {
    var listEl = $("historyList");
    if (!listEl) return;
    var query = ($("historySearch") ? $("historySearch").value : "").trim().toLowerCase();
    var filtered = cachedHistory.filter(function (item) {
      if (!query) return true;
      var str = ((item.title || "") + " " + (item.preview || "") + " " + (item.model || "")).toLowerCase();
      return str.indexOf(query) >= 0;
    });

    listEl.innerHTML = "";
    if (!filtered.length) {
      listEl.innerHTML = '<div class="history-empty">' + (query ? '未找到匹配的会话' : '暂无历史会话记录（在侧边栏发起对话后将自动记录）') + '</div>';
      return;
    }

    filtered.forEach(function (conv) {
      var item = document.createElement("div");
      item.className = "history-item";

      var timeStr = fmtTime(conv.updatedAt || conv.createdAt);
      var modelTag = conv.model ? ' · ' + esc(conv.model) : '';
      var turnTag = (conv.turnCount ? conv.turnCount : (conv.messages ? conv.messages.length : 0)) + ' 轮对话';

      item.innerHTML =
        '<div class="hi-head">' +
          '<span class="hi-title">' + esc(conv.title || "未命名会话") + '</span>' +
          '<span class="hi-meta">' + turnTag + modelTag + ' · ' + timeStr + '</span>' +
        '</div>' +
        '<div class="hi-preview">' + esc(conv.preview || "(无预览)") + '</div>' +
        '<div class="hi-actions">' +
          '<button type="button" class="btn primary sm btn-restore">恢复到侧边栏</button>' +
          '<button type="button" class="btn ghost sm btn-view">查看详情</button>' +
          '<button type="button" class="btn ghost sm btn-copy">复制 Markdown</button>' +
          '<button type="button" class="btn danger ghost sm btn-del">删除</button>' +
        '</div>';

      item.querySelector(".btn-restore").addEventListener("click", function (e) {
        e.stopPropagation();
        restoreConversation(conv);
      });
      item.querySelector(".btn-view").addEventListener("click", function (e) {
        e.stopPropagation();
        viewConversation(conv);
      });
      item.querySelector(".btn-copy").addEventListener("click", function (e) {
        e.stopPropagation();
        copyConversationMarkdown(conv);
      });
      item.querySelector(".btn-del").addEventListener("click", function (e) {
        e.stopPropagation();
        if (confirm("确定要删除该条会话记录吗？")) {
          deleteConversation(conv.id);
        }
      });
      item.addEventListener("click", function () {
        viewConversation(conv);
      });

      listEl.appendChild(item);
    });
  }

  function viewConversation(conv) {
    activeConversation = conv;
    var viewer = $("historyViewer");
    var title = $("viewerTitle");
    var msgsEl = $("viewerMessages");
    if (!viewer || !msgsEl) return;

    title.textContent = (conv.title || "会话详情") + (conv.model ? " (" + conv.model + ")" : "");
    msgsEl.innerHTML = "";

    var msgs = Array.isArray(conv.messages) ? conv.messages : [];
    if (!msgs.length) {
      msgsEl.innerHTML = '<div class="empty">该会话暂无详细消息</div>';
    } else {
      msgs.forEach(function (m) {
        var bubble = document.createElement("div");
        bubble.className = "msg-bubble " + (m.role === "assistant" ? "assistant" : "user");
        bubble.innerHTML =
          '<div class="msg-role">' + (m.role === "assistant" ? "Claude" : "User") + '</div>' +
          '<div class="msg-content">' + esc(m.text || "") + '</div>';
        msgsEl.appendChild(bubble);
      });
    }

    viewer.classList.remove("hidden");
    viewer.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function deleteConversation(id) {
    cachedHistory = cachedHistory.filter(function (c) { return c.id !== id; });
    chrome.storage.local.set({ gatewayChatHistory: cachedHistory }, function () {
      if (activeConversation && activeConversation.id === id) {
        if ($("historyViewer")) $("historyViewer").classList.add("hidden");
        activeConversation = null;
      }
      renderHistory();
    });
  }

  function convToMarkdown(conv) {
    var md = "# " + (conv.title || "Claude in Chrome 会话") + "\n\n";
    md += "- **时间**: " + new Date(conv.updatedAt || conv.createdAt).toLocaleString() + "\n";
    if (conv.model) md += "- **模型**: " + conv.model + "\n";
    md += "\n---\n\n";
    (conv.messages || []).forEach(function (m) {
      var roleName = m.role === "assistant" ? "Claude" : "User";
      md += "### " + roleName + "\n\n" + (m.text || "") + "\n\n";
    });
    return md;
  }

  function copyConversationMarkdown(conv) {
    var md = convToMarkdown(conv);
    navigator.clipboard.writeText(md).then(function () {
      alert("会话已以 Markdown 格式复制到剪贴板！");
    }).catch(function () {
      alert("复制失败，请手动选择复制。");
    });
  }

  function restoreConversation(conv) {
    if (!conv) return;
    var msgsToRestore = (conv.rawMessages && conv.rawMessages.length) ? conv.rawMessages :
      (conv.messages || []).map(function (m) {
        return {
          role: m.role,
          content: [{ type: "text", text: m.text || "" }]
        };
      });

    chrome.storage.local.set({
      gatewayPendingRestore: {
        id: conv.id,
        title: conv.title,
        messages: msgsToRestore,
        ts: Date.now()
      }
    }, function () {
      try {
        if (chrome.sidePanel && chrome.sidePanel.open) {
          chrome.windows.getCurrent(function (w) {
            if (w && w.id) {
              chrome.sidePanel.open({ windowId: w.id }).catch(function () {});
            }
          });
        }
      } catch (e) {}
      alert("✔ 会话已恢复！请打开或切换到浏览器侧边栏继续对话。");
    });
  }

  if ($("restoreHistoryBtn")) {
    $("restoreHistoryBtn").addEventListener("click", function () {
      if (activeConversation) restoreConversation(activeConversation);
    });
  }
  if ($("copyHistoryBtn")) {
    $("copyHistoryBtn").addEventListener("click", function () {
      if (activeConversation) copyConversationMarkdown(activeConversation);
    });
  }
  if ($("closeViewerBtn")) {
    $("closeViewerBtn").addEventListener("click", function () {
      if ($("historyViewer")) $("historyViewer").classList.add("hidden");
      activeConversation = null;
    });
  }
  if ($("historySearch")) {
    $("historySearch").addEventListener("input", renderHistory);
  }
  if ($("exportHistoryBtn")) {
    $("exportHistoryBtn").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(cachedHistory, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "claude-gateway-history-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  if ($("clearHistoryBtn")) {
    $("clearHistoryBtn").addEventListener("click", function () {
      if (confirm("确定要清空所有历史会话记录吗？此操作不可撤销。")) {
        cachedHistory = [];
        chrome.storage.local.set({ gatewayChatHistory: [] }, function () {
          if ($("historyViewer")) $("historyViewer").classList.add("hidden");
          renderHistory();
        });
      }
    });
  }

  /* ---------------- 内嵌模式与选项卡 ---------------- */
  var isEmbed = new URLSearchParams(window.location.search).get("embed") === "1";
  if (isEmbed) {
    document.body.classList.add("is-embedded");
  }

  function switchTab(targetId) {
    var tabBtns = document.querySelectorAll(".tab-btn");
    tabBtns.forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === targetId);
    });
    document.querySelectorAll(".tab-pane").forEach(function (pane) {
      pane.classList.toggle("hidden", pane.id !== targetId);
    });
    if (targetId === "tab-history") {
      loadHistory().then(renderHistory);
    }
  }

  var tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var targetId = btn.getAttribute("data-tab");
      switchTab(targetId);
    });
  });

  // URL 指定默认选项卡
  var requestedTab = new URLSearchParams(window.location.search).get("tab");
  if (requestedTab) {
    if (requestedTab === "history" || requestedTab === "tab-history") switchTab("tab-history");
    else if (requestedTab === "models" || requestedTab === "tab-models") switchTab("tab-models");
    else if (requestedTab === "advanced" || requestedTab === "tab-advanced") switchTab("tab-advanced");
  }

  /* ---------------- 初始化 ---------------- */
  loadCfg().then(function () {
    fillLoginForm();
    renderModelList();
    renderStatus();
    syncThinkingFields();
    renderDiag();
    loadHistory();
  });
})();

