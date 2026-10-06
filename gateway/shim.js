/*
 * gateway/shim.js — Claude in Chrome · 网关版运行时垫片
 * ------------------------------------------------------------------
 * 1) 将 Anthropic API 流量重写到自定义网关（/v1/messages…）：
 *    - 认证改为网关 API Key（x-api-key 或 Bearer，可配置）
 *    - 按自定义模型配置注入推理参数（temperature/top_p/top_k/max_tokens/
 *      stop_sequences/thinking/附加 JSON），并做模型名映射
 *    - 按模型模态配置过滤内容块（图片/文件/工具/思考/提示缓存）
 * 2) 合成 api.anthropic.com / claude.ai 控制面响应
 *    （登录态、profile、特性开关 chrome_ext_models、模型列表…），
 *    使扩展无需 Claude 账号即可工作。
 * 3) 屏蔽 Anthropic 各类遥测：
 *    - Sentry（ingest.us.sentry.io）
 *    - Datadog RUM/Profiler/Replay（datadoghq.com / browser-intake-*）
 *    - event_logging / Segment 风格埋点（api.anthropic.com/api/event_logging）
 *    - GrowthBook 实验平台（cdn.growthbook.io /api/features /api/eval /sub）
 *    - statsig（featuregates.org / statsigapi.net）
 *    并拦截 sendBeacon / XHR / EventSource 通道。
 *
 * 该文件在 service worker、sidepanel、settings 等所有扩展上下文中最先加载。
 */
(function () {
  "use strict";
  if (globalThis.__GATEWAY_SHIM__) return;
  globalThis.__GATEWAY_SHIM__ = true;

  var DEBUG = false;
  var BUILD_TAG = "gateway-shim-r13";

  // 内置默认系统提示词（配置页可覆盖）：
  // 官方的系统提示词由服务端下发，缺失时应用会抛
  // “Unable to initialize the chat session”（见 ue/Ce 的 !e 检查）。
  var DEFAULT_SYSTEM_PROMPT = [
    "You are Claude in Chrome, an AI assistant that operates the user's web browser through the provided browser tools.",
    "",
    "How to work:",
    "- Before acting, inspect the page (read_page / get_page_text / screenshots) to understand the current state.",
    "- Use the browser tools (computer, find, form_input, browser_batch, etc.) to click, type, scroll and navigate.",
    "- Prefer the smallest number of steps that completes the task; narrate briefly what you are doing and why.",
    "- After each action, verify the result before moving on. If something unexpected happens, stop and report.",
    "",
    "Safety rules:",
    "- Never enter passwords, credit-card numbers or other sensitive data, and never submit such forms, without explicit confirmation from the user in this conversation.",
    "- Respect permission prompts and site boundaries chosen by the user.",
    "- Stay strictly on the user's task; if a task is ambiguous or blocked, ask the user instead of guessing.",
    "",
    "Style:",
    "- Reply in the user's language. Be concise and concrete.",
    "- When the task is done, summarize what was done and the result."
  ].join("\n");
  function log() {
    if (!DEBUG) return;
    var a = ["[gateway-shim]"].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, a);
  }

  /* ============================== 配置 ============================== */

  var CFG_KEY = "gatewayConfig";
  var cfgCache = null;

  function defaultConfig() {
    return {
      version: 1,
      baseUrl: "",
      apiKey: "",
      authType: "x-api-key", // "x-api-key" | "bearer"
      anthropicVersion: "2023-06-01",
      extraHeaders: {},
      betas: [], // 追加的 anthropic-beta 值
      gatewayNoStream: false, // 网关不支持 SSE 时：改为非流式并把 JSON 响应转回 SSE
      unknownModelPolicy: "map-default", // "map-default" | "passthrough"
      defaultModel: "",
      fastModel: "",
      models: []
    };
  }

  function normalizeModel(m) {
    m = m || {};
    var inf = m.inference || {};
    var mod = m.modalities || {};
    return {
      id: String(m.id || "").trim(),
      apiModel: String(m.apiModel || m.id || "").trim(),
      name: String(m.name || m.id || "").trim(),
      description: String(m.description || ""),
      knowledgeCutoff: m.knowledgeCutoff || "",
      inference: {
        temperature: numOrNull(inf.temperature),
        top_p: numOrNull(inf.top_p),
        top_k: intOrNull(inf.top_k),
        max_output_tokens: intOrNull(inf.max_output_tokens),
        stop_sequences: Array.isArray(inf.stop_sequences) ? inf.stop_sequences : [],
        thinking: inf.thinking || "off", // "off" | "budget" | "effort"
        thinking_budget: intOrNull(inf.thinking_budget) || 2048,
        thinking_effort: inf.thinking_effort || "medium", // "low"|"medium"|"high"
        systemAppend: String(inf.systemAppend || ""),
        extra: inf.extra && typeof inf.extra === "object" ? inf.extra : {}
      },
      modalities: {
        vision: mod.vision !== false,
        documents: mod.documents !== false,
        tools: mod.tools !== false,
        thinking: mod.thinking !== false,
        caching: mod.caching !== false
      }
    };
  }

  function numOrNull(v) {
    if (v === "" || v === null || v === undefined || v === "null") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function intOrNull(v) {
    var n = numOrNull(v);
    return n === null ? null : Math.round(n);
  }

  function normalizeConfig(raw) {
    var d = defaultConfig();
    if (!raw || typeof raw !== "object") return d;
    var c = Object.assign(d, raw);
    c.models = Array.isArray(raw.models) ? raw.models.map(normalizeModel).filter(function (m) { return m.id; }) : [];
    c.systemPrompt = typeof raw.systemPrompt === "string" ? raw.systemPrompt : "";
    if (!c.defaultModel || !c.models.some(function (m) { return m.id === c.defaultModel; })) {
      c.defaultModel = c.models.length ? c.models[0].id : "";
    }
    if (!c.fastModel || !c.models.some(function (m) { return m.id === c.fastModel; })) {
      var fast = c.models.find(function (m) { return /haiku|fast|mini|small/i.test(m.id + m.apiModel); });
      c.fastModel = fast ? fast.id : c.defaultModel;
    }
    return c;
  }

  function getCfg() {
    if (cfgCache) return Promise.resolve(cfgCache);
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(CFG_KEY, function (r) {
          cfgCache = normalizeConfig(r && r[CFG_KEY]);
          resolve(cfgCache);
        });
      } catch (e) {
        cfgCache = normalizeConfig(null);
        resolve(cfgCache);
      }
    });
  }

  try {
    chrome.storage.local.get("gatewayAllowAllSites", function (r) {
      globalThis.__gatewayAllowAllSites = !!(r && r.gatewayAllowAllSites);
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local") {
        if (changes[CFG_KEY]) {
          cfgCache = normalizeConfig(changes[CFG_KEY].newValue);
          log("config changed", cfgCache.baseUrl, cfgCache.models.length, "models");
          syncAuthState();
        }
        if (changes.gatewayAllowAllSites) {
          globalThis.__gatewayAllowAllSites = !!changes.gatewayAllowAllSites.newValue;
        }
      }
    });
  } catch (e) { /* 非扩展上下文 */ }

  /* ====================== 登录态 / 特性缓存同步 ====================== */

  function buildFeatures(cfg) {
    var options = cfg.models.map(function (m) {
      return {
        model: m.id,
        name: m.name || m.id,
        description: m.description || "",
        notice_text: "",
        overflow: false,
        effort_options: m.inference.thinking === "effort" ? ["low", "medium", "high", "xhigh", "max"] : undefined,
        xml_system_reminders: true,
        capabilities: Object.keys(m.modalities).filter(function (k) { return m.modalities[k]; }),
        knowledgeCutoff: m.knowledgeCutoff || undefined
      };
    });
    if (!options.length) {
      // 兜底：保证 UI 的模型选择器永远有选项，避免空列表导致渲染异常
      options = [{ model: "claude-sonnet-4-5-20250929", name: "默认模型（未配置）", description: "请在网关配置页添加自定义模型", notice_text: "", overflow: false, xml_system_reminders: true }];
    }
    return {
      chrome_ext_models: {
        on: true,
        value: {
          default: (cfg.defaultModel && cfg.models.some(function (m) { return m.id === cfg.defaultModel; }))
            ? cfg.defaultModel : options[0].model,
          small_fast_model: (cfg.fastModel && cfg.models.some(function (m) { return m.id === cfg.fastModel; }))
            ? cfg.fastModel : undefined,
          options: options,
          default_model_override_id: null
        }
      },
      // 系统提示词：缺失会导致会话初始化抛错（“Unable to initialize the chat session”）
      chrome_ext_system_prompt: {
        on: true,
        value: { systemPrompt: cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT }
      },
      chrome_ext_skip_perms_system_prompt: {
        on: true,
        value: { skipPermissionsSystemPrompt: cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT }
      },
      chrome_ext_multiple_tabs_system_prompt: { on: true, value: { multipleTabsSystemPrompt: "" } },
      chrome_ext_supplemental_guidance: { on: true, value: "" },
      chrome_ext_backend_model_selector: { on: false, value: false },
      chrome_ext_cowork_iframe: { on: false, value: false },
      chrome_ext_announcement: { on: false, value: {} }
    };
  }

  function growthBookFeatures(cfg) {
    // GrowthBook 形状：{features:{key:{defaultValue}}}
    var out = { features: {} };
    var f = buildFeatures(cfg);
    Object.keys(f).forEach(function (k) {
      out.features[k] = { defaultValue: f[k].value };
    });
    return out;
  }

  var AUTH_KEYS_TO_CLEAR_SESSION = [
    "accessToken", "refreshToken", "tokenExpiry", "startupReauthState"
  ];
  var AUTH_KEYS_TO_CLEAR_LOCAL = [
    "anthropicApiKey", "accountUuid", "lastAuthFailureReason", "signInState", "tokenOrg"
  ];

  var syncInFlight = null;
  var LAST_STATE_KEY = null;
  // 固定值（不要用 Date.now()：每次写入不同值会触发 chrome.storage.onChanged，
  // 进而触发应用内多个订阅者 setState，容易形成重渲染风暴）
  var FIXED_TOKEN_EXPIRY = Date.UTC(2099, 11, 31);

  // 合法 posture（形状与官方 nt() 组装结果一致）：
  // 关键点：官方页面侧 `Ot()` 若在 chrome.storage.session 找不到带 gen 的 posture，
  // 会发 `get_posture` 消息等待 SW 的 posture 派生引导（await _t）——一旦派生链挂起，
  // foe 门禁与 features 初始化会永久等待（表现为白屏/转圈）。
  // 这里直接写入合法 posture，让所有 Ot() 调用就地短路。
  var SYNTH_POSTURE = {
    gen: 1, managed: false, source: null, allowedOrgs: null,
    pairedPeer: null, identity: null, awaiting: null, policy: { orgs: null }
  };

  function syncAuthState() {
    if (syncInFlight) return syncInFlight;
    syncInFlight = new Promise(function (resolve) {
      getCfg().then(function (cfg) {
        try {
          // 注意：官方代码中 accessToken/tokenExpiry 等存放于 chrome.storage.session
          //（见共享块的 H=new Set(["accessToken","refreshToken","tokenExpiry",…])），
          // isAuthenticated = 存在 accessToken && profile 拉取成功，因此必须写到 session 分区。
          var sess = chrome.storage.session;
          if (cfg.baseUrl && cfg.apiKey) {
            var stateKey = JSON.stringify([cfg.baseUrl, cfg.apiKey, cfg.defaultModel, cfg.fastModel, cfg.models]);
            if (stateKey === LAST_STATE_KEY) { sess.set({ posture: SYNTH_POSTURE }, function () { resolve(); }); return; } // 未变化则不重复写入
            LAST_STATE_KEY = stateKey;
            chrome.storage.local.set({
              anthropicApiKey: cfg.apiKey,
              accountUuid: "gateway-account",
              features: { payload: { features: buildFeatures(cfg) }, timestamp: Date.now() }
            }, function () {
              sess.set({
                // 占位 OAuth 令牌：让扩展进入“已登录”状态，实际流量由本垫片改写到网关
                accessToken: "gateway-session",
                tokenExpiry: FIXED_TOKEN_EXPIRY,
                posture: SYNTH_POSTURE
              }, function () { resolve(); });
            });
            log("auth state: gateway session installed");
          } else {
            LAST_STATE_KEY = null;
            chrome.storage.local.remove(AUTH_KEYS_TO_CLEAR_LOCAL, function () {
              sess.remove(AUTH_KEYS_TO_CLEAR_SESSION, function () {
                sess.set({ posture: SYNTH_POSTURE }, function () { resolve(); });
              });
            });
            log("auth state: cleared (gateway not configured)");
          }
        } catch (e) { resolve(); }
      });
    }).finally(function () { syncInFlight = null; });
    return syncInFlight;
  }

  /* ============================ 遥测屏蔽 ============================ */

  var TELEMETRY_HOST_SUFFIX = [
    "sentry.io", "ingest.sentry.io", "datadoghq.com", "datadoghq.eu", "ddog-gcp.com",
    "datad0g.com", "dd0g.com", "growthbook.io", "statsig.com", "statsigapi.net",
    "featuregates.org", "segment.io", "segment.com", "amplitude.com", "mixpanel.com"
  ];
  var TELEMETRY_PATH_RE = /^\/(api\/event_logging\/|api\/v2\/profiling\/|api\/telemetry\/|api\/features\/[^/]+$|api\/eval\/[^/]+$|sub\/[^/]+$)/i;

  function isTelemetryHost(h) {
    h = String(h || "").toLowerCase();
    if (h.indexOf("browser-intake") >= 0) return true; // Datadog RUM intake
    return TELEMETRY_HOST_SUFFIX.some(function (s) { return h === s || h.endsWith("." + s); });
  }

  function isTelemetryUrl(u) {
    try {
      var base = (typeof location !== "undefined" && location.href) ? location.href : "https://api.anthropic.com/";
      var url = new URL(u, base);
      if (isTelemetryHost(url.hostname)) return true;
      // GrowthBook/statsig 风格路径（且不是发往网关本身）
      if (url.hostname !== gatewayHost && TELEMETRY_PATH_RE.test(url.pathname)) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  function blockedResponse() {
    return new Response(null, { status: 204, statusText: "No Content (telemetry blocked)" });
  }

  /* ====================== 网关请求日志（对接调试） ====================== */

  var CALL_LOG_KEY = "gatewayCallLog";
  function logGatewayCall(url, status, reqModel, sentModel, snippet) {
    try {
      chrome.storage.local.get(CALL_LOG_KEY, function (r) {
        var list = (r && r[CALL_LOG_KEY]) || [];
        list.unshift({
          kind: "gateway", ctx: CTX,
          message: "HTTP " + status + " → " + String(url) + " · 请求模型:" + String(reqModel) + " · 发送:" + String(sentModel),
          stack: String(snippet == null ? "" : snippet).slice(0, 800),
          ts: Date.now()
        });
        chrome.storage.local.set({ [CALL_LOG_KEY]: list.slice(0, 20) });
      });
    } catch (e) {}
  }

  /* ====================== 控制面合成响应 ====================== */

  function jsonResponse(data, status) {
    return new Response(JSON.stringify(data === undefined ? {} : data), {
      status: status || 200,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  function sseResponse(events) {
    var body = events.map(function (e) {
      return "event: " + e.event + "\n" + "data: " + JSON.stringify(e.data) + "\n\n";
    }).join("");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" }
    });
  }

  function syntheticProfile() {
    return {
      account: {
        uuid: "gateway-account",
        email: "gateway@localhost",
        full_name: "Gateway User",
        display_name: "Gateway",
        account_settings: {},
        // 网关版 entitlement：不满足时 UI 会挂"requires a paid plan"付费墙
        //（见 XJ/QJ/JJ：has_claude_pro / has_claude_max / organization_type）
        has_claude_pro: true,
        has_claude_max: true,
        has_claude_opus: true
      },
      organization: {
        uuid: "gateway-org", name: "Gateway Org", hybrid: false, capabilities: [],
        organization_type: "claude_team"
      },
      organizations: [{
        uuid: "gateway-org", name: "Gateway Org", role: "admin", capabilities: [],
        organization_type: "claude_team"
      }],
      settings: {}
    };
  }

  // 处理 api.anthropic.com/api/* 与 claude.ai/* 的合成响应
  function controlPlaneResponse(cfg, url, method) {
    var path = url.pathname;
    var query = url.search || "";

    // ---- 精确路由 ----
    if (/\/api\/oauth\/profile\/?$/.test(path)) return jsonResponse(syntheticProfile());
    if (/\/api\/oauth\/account\/settings/.test(path)) return jsonResponse({ settings: {} });
    if (/\/api\/bootstrap\/features\//.test(path)) return jsonResponse({ features: buildFeatures(cfg) });
    if (/\/api\/bootstrap\/?$/.test(path)) return jsonResponse({ features: buildFeatures(cfg) });

    if (/\/model_selector_state\//.test(path)) {
      // PATCH 保存所选模型 / GET 读取
      return jsonResponse({ model_selector_state: [{ model: cfg.defaultModel }] });
    }
    if (/\/model_selector\//.test(path)) {
      return jsonResponse({
        model_selector_config: [{
          models: cfg.models.map(function (m) {
            return {
              id: m.id,
              name: m.name || m.id,
              description: m.description || "",
              disabled_reason: null,
              section: null,
              thinking: m.inference.thinking === "effort"
                ? { effort_options: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }] }
                : undefined
            };
          })
        }],
        model_selector_state: [{ model: cfg.defaultModel }]
      });
    }

    if (/\/mcp\/v2\/bootstrap/.test(path)) {
      return sseResponse([{ event: "server_list", data: { servers: [] } }]);
    }
    if (/\/spotlight/.test(path)) return jsonResponse({});
    if (/\/url_hash_check\//.test(path)) return jsonResponse({ org_policy: "allow", category: "category0" });
    if (/\/event_logging\//.test(path)) return blockedResponse();
    if (/\/profiling\//.test(path)) return blockedResponse();
    if (/\/local_pairing/.test(path)) return jsonResponse({});

    // ---- 通配兜底 ----
    log("control-plane fallback", method, path + query);
    return jsonResponse({});
  }

  /* ==================== /v1/messages 请求改写 ==================== */

  function pickModel(cfg, requested) {
    var req = String(requested || "").trim();
    var byId = cfg.models.find(function (m) { return m.id === req || m.apiModel === req; });
    if (byId) return byId;
    if (/haiku|fast|mini|small/i.test(req)) {
      var fast = cfg.models.find(function (m) { return m.id === cfg.fastModel; });
      if (fast) return fast;
    }
    if (cfg.unknownModelPolicy === "passthrough") {
      return normalizeModel({ id: req, apiModel: req, name: req });
    }
    var def = cfg.models.find(function (m) { return m.id === cfg.defaultModel; });
    return def || (cfg.models[0] || normalizeModel({ id: req, apiModel: req, name: req }));
  }

  function applyInference(body, m) {
    var inf = m.inference;
    body.model = m.apiModel || m.id;

    var thinkingOn = inf.thinking === "budget" || inf.thinking === "effort";
    if (!thinkingOn) {
      if (inf.temperature !== null && inf.temperature !== undefined) body.temperature = inf.temperature;
      if (inf.top_p !== null && inf.top_p !== undefined) body.top_p = inf.top_p;
      if (inf.top_k !== null && inf.top_k !== undefined) body.top_k = inf.top_k;
    }
    if (inf.stop_sequences && inf.stop_sequences.length) body.stop_sequences = inf.stop_sequences;

    if (inf.max_output_tokens !== null && inf.max_output_tokens !== undefined) {
      var cap = inf.max_output_tokens;
      body.max_tokens = Math.min(typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : cap, cap);
    }
    if (typeof body.max_tokens !== "number" || !body.max_tokens) body.max_tokens = 8192;

    if (inf.thinking === "budget") {
      body.thinking = { type: "enabled", budget_tokens: inf.thinking_budget || 2048 };
    } else if (inf.thinking === "effort") {
      var eff = inf.thinking_effort || "medium";
      body.thinking = { type: "adaptive", effort: eff };
      body.output_config = Object.assign(body.output_config || {}, { effort: eff });
    }
    if (thinkingOn) {
      // thinking 开启时 temperature/top_p/top_k 受 API 约束（不能自定义），移除以免报错
      delete body.temperature;
      delete body.top_p;
      delete body.top_k;
    }

    // 附加请求体参数（高级，允许覆盖任何字段）
    if (inf.extra && typeof inf.extra === "object") {
      Object.keys(inf.extra).forEach(function (k) { body[k] = inf.extra[k]; });
    }
    return body;
  }

  function stripCaching(block) {
    if (block && typeof block === "object") {
      if (block.cache_control) delete block.cache_control;
      if (Array.isArray(block.content)) block.content.forEach(stripCaching);
    }
    return block;
  }

  function enforceModalities(body, mod) {
    if (!mod) return body;

    if (!mod.tools) {
      delete body.tools;
    }

    // system：可为字符串或块数组
    if (typeof body.system === "string") {
      if (!mod.caching) { /* 字符串无 cache_control */ }
    } else if (Array.isArray(body.system)) {
      body.system = body.system.map(function (b) { return mod.caching ? b : stripCaching(b); });
    }

    var MSG = {
      image: "[图片已按当前模型模态设置移除 / image removed: vision disabled]",
      document: "[文件已按当前模型模态设置移除 / document removed: documents disabled]",
      tool: "[工具调用已按当前模型模态设置移除 / tool call removed: tools disabled]",
      thinking: "[思考块已按当前模型模态设置移除 / thinking block removed]"
    };

    function mapBlock(blk) {
      if (!blk || typeof blk !== "object") return blk;
      var t = blk.type;
      if (t === "image" && !mod.vision) return { type: "text", text: MSG.image };
      if ((t === "document" || t === "pdf" || t === "file" || t === "video" || t === "audio") && !mod.documents) {
        return { type: "text", text: MSG.document };
      }
      if ((t === "thinking" || t === "redacted_thinking") && !mod.thinking) {
        return { type: "text", text: MSG.thinking };
      }
      if (t === "tool_use" && !mod.tools) return { type: "text", text: MSG.tool };
      if (t === "tool_result") {
        var c = blk.content;
        if (Array.isArray(c)) {
          c = c.map(mapBlock).filter(Boolean);
          blk = Object.assign({}, blk, { content: c.length ? c : [{ type: "text", text: MSG.tool }] });
        }
      }
      return mod.caching ? blk : stripCaching(blk);
    }

    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map(function (msg) {
        if (!msg || typeof msg.content === "string" || !Array.isArray(msg.content)) return msg;
        var content = msg.content.map(mapBlock).filter(Boolean);
        if (!content.length) content = [{ type: "text", text: "(空消息)" }];
        return Object.assign({}, msg, { content: content });
      });
    }
    return body;
  }

  function applySystemAppend(body, text) {
    if (!text) return;
    if (typeof body.system === "string") {
      body.system = body.system + "\n" + text;
    } else if (Array.isArray(body.system)) {
      body.system = body.system.concat([{ type: "text", text: text }]);
    } else {
      body.system = text;
    }
  }

  /* -------- JSON 响应 → SSE（网关不支持流式时的兼容转换） -------- */

  function jsonToSseStream(json) {
    var chunks = [];
    function ev(name, data) {
      return "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
    }
    var msg = {
      id: json.id || "msg_gateway",
      type: "message",
      role: "assistant",
      model: json.model || "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: json.usage || {}
    };
    chunks.push(ev("message_start", { type: "message_start", message: msg }));

    var blocks = Array.isArray(json.content) ? json.content : [];
    blocks.forEach(function (blk, i) {
      if (blk.type === "text") {
        chunks.push(ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }));
        chunks.push(ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: blk.text || "" } }));
      } else if (blk.type === "thinking") {
        chunks.push(ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } }));
        chunks.push(ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: blk.thinking || "" } }));
        if (blk.signature) {
          chunks.push(ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: blk.signature } }));
        }
      } else if (blk.type === "tool_use") {
        chunks.push(ev("content_block_start", {
          type: "content_block_start", index: i,
          content_block: { type: "tool_use", id: blk.id, name: blk.name, input: {} }
        }));
        chunks.push(ev("content_block_delta", {
          type: "content_block_delta", index: i,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(blk.input || {}) }
        }));
      } else {
        chunks.push(ev("content_block_start", { type: "content_block_start", index: i, content_block: blk }));
      }
      chunks.push(ev("content_block_stop", { type: "content_block_stop", index: i }));
    });

    chunks.push(ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: json.stop_reason || "end_turn", stop_sequence: json.stop_sequence || null },
      usage: { output_tokens: (json.usage && json.usage.output_tokens) || 0 }
    }));
    chunks.push(ev("message_stop", { type: "message_stop" }));

    var stream = new ReadableStream({
      start: function (c) {
        chunks.forEach(function (x) { c.enqueue(new TextEncoder().encode(x)); });
        c.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    });
  }

  /* ======================= 网关请求执行 ======================= */

  var gatewayHost = "";
  function apiRoot(cfg) {
    var base = String(cfg.baseUrl).replace(/\/+$/, "");
    return /\/v1$/.test(base) ? base : base + "/v1";
  }

  function rewriteHeaders(headers, cfg) {
    var out = new Headers();
    if (headers) {
      headers.forEach(function (v, k) {
        var lk = k.toLowerCase();
        if (lk === "authorization" || lk === "x-api-key") return;         // 认证由网关配置决定
        if (lk === "cookie") return;
        if (lk === "anthropic-beta") return;                               // 稍后重建
        if (lk === "anthropic-client-platform" || lk === "anthropic-client-version") return; // 遥测元数据
        if (lk.indexOf("x-stainless-") === 0) return;                      // SDK 遥测头
        if (lk === "traceparent" || lk === "tracestate" || lk === "baggage" || lk === "b3" ||
            lk === "x-b3-traceid" || lk === "x-b3-spanid" || lk === "x-b3-sampled" ||
            lk === "x-cloud-trace-context" || lk === "x-datadog-trace-id" ||
            lk === "x-datadog-parent-id" || lk === "x-sampling-trace-id") return; // 分布式追踪遥测头
        out.append(k, v);
      });
    }
    if (cfg.authType === "bearer") {
      out.set("Authorization", "Bearer " + cfg.apiKey);
    } else {
      out.set("x-api-key", cfg.apiKey);
    }
    if (!out.has("anthropic-version")) out.set("anthropic-version", cfg.anthropicVersion || "2023-06-01");
    if (cfg.extraHeaders && typeof cfg.extraHeaders === "object") {
      Object.keys(cfg.extraHeaders).forEach(function (k) {
        if (cfg.extraHeaders[k] !== null && cfg.extraHeaders[k] !== undefined) out.set(k, String(cfg.extraHeaders[k]));
      });
    }
    return out;
  }

  function rebuildBetas(bodyBetas, headerBetas, cfg) {
    var list = [];
    function push(v) {
      if (!v) return;
      String(v).split(",").forEach(function (x) {
        x = x.trim();
        if (x && x !== "oauth-2025-04-20" && list.indexOf(x) < 0) list.push(x); // 去掉 OAuth beta（遥测/登录相关）
      });
    }
    if (Array.isArray(bodyBetas)) bodyBetas.forEach(push);
    if (headerBetas) push(headerBetas);
    (cfg.betas || []).forEach(push);
    return list;
  }

  function rewriteMessagesBody(rawBody, cfg) {
    var body = JSON.parse(rawBody);
    var m = pickModel(cfg, body.model);
    applyInference(body, m);
    enforceModalities(body, m.modalities);
    applySystemAppend(body, m.inference.systemAppend);
    body.betas = rebuildBetas(body.betas, null, cfg);
    if (!body.betas.length) delete body.betas;
    return { body: body, model: m };
  }

  function extractTextContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(function (b) {
        if (!b) return "";
        if (b.type === "text") return b.text || "";
        if (b.type === "thinking") return "[思考] " + (b.thinking || "");
        if (b.type === "tool_use") return "[调用工具: " + (b.name || "") + "]";
        if (b.type === "tool_result") return "[工具返回: " + (typeof b.content === "string" ? b.content.slice(0, 100) : "") + "]";
        return "";
      }).filter(Boolean).join("\n");
    }
    return "";
  }

  function recordHistoryTurn(body, modelName) {
    if (!body || !Array.isArray(body.messages) || !body.messages.length) return;
    try {
      chrome.storage.local.get("gatewayChatHistory", function (r) {
        var list = (r && r.gatewayChatHistory) || [];
        var messages = body.messages;
        var firstUserMsg = messages.find(function (m) { return m.role === "user"; });
        var firstText = firstUserMsg ? extractTextContent(firstUserMsg.content) : "新会话";
        var title = firstText.trim().replace(/\s+/g, " ").slice(0, 48) || "未命名会话";

        var lastUserMsg = null;
        for (var i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") { lastUserMsg = messages[i]; break; }
        }
        var preview = lastUserMsg ? extractTextContent(lastUserMsg.content).trim().replace(/\s+/g, " ").slice(0, 80) : "";

        var sessionKey = firstText.trim().slice(0, 60);
        var existingIdx = -1;
        for (var j = 0; j < list.length; j++) {
          if (list[j].sessionKey === sessionKey) {
            existingIdx = j;
            break;
          }
        }

        var entry = {
          id: existingIdx >= 0 ? list[existingIdx].id : "chat_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          sessionKey: sessionKey,
          title: title,
          model: modelName || body.model || "",
          turnCount: messages.length,
          preview: preview,
          updatedAt: Date.now(),
          createdAt: existingIdx >= 0 ? list[existingIdx].createdAt : Date.now(),
          messages: messages.map(function (m) {
            return {
              role: m.role,
              text: extractTextContent(m.content)
            };
          }),
          rawMessages: messages.map(function (m) {
            return {
              role: m.role,
              content: m.content
            };
          })
        };

        if (existingIdx >= 0) {
          list.splice(existingIdx, 1);
        }
        list.unshift(entry);
        if (list.length > 60) list = list.slice(0, 60);
        chrome.storage.local.set({ gatewayChatHistory: list });
      });
    } catch (e) {}
  }

  async function gatewayFetch(url, init, cfg) {
    // url: 目标 URL 对象（已指向网关）；init: {method, headers(Headers), body(string|undefined), signal}
    var res = await origFetch(url.toString(), {
      method: init.method || "POST",
      headers: init.headers,
      body: init.body,
      signal: init.signal
    });
    return res;
  }

  async function handleApiMessage(urlStr, init, cfg) {
    var url = new URL(urlStr);
    var isMessages = /\/v1\/messages\/?$/.test(url.pathname);
    var rest = url.pathname.replace(/^.*\/v1/, ""); // 去掉原始 /v1 前缀
    var sp = new URLSearchParams(url.search);
    sp.delete("beta"); // 去掉 SDK 附加的 ?beta=true（oauth beta 已被移除）
    var qs = sp.toString();
    var target = new URL(apiRoot(cfg) + (isMessages ? "/messages" : rest) + (qs ? "?" + qs : ""));

    // 先取出入站 anthropic-beta（rewriteHeaders 会重建该头）
    var betaIn = new Headers(init.headers || {}).get("anthropic-beta");
    var headers = rewriteHeaders(init.headers, cfg);
    var hb = rebuildBetas(null, betaIn, cfg);
    if (hb.length) headers.set("anthropic-beta", hb.join(", "));
    else headers.delete("anthropic-beta");
    var body = init.body;

    if (isMessages && typeof body === "string" && body.length) {
      try {
        var parsed = rewriteMessagesBody(body, cfg);
        recordHistoryTurn(parsed.body, parsed.model ? (parsed.model.name || parsed.model.id) : parsed.body.model);
        var wantsStream = parsed.body.stream === true;
        if (wantsStream && cfg.gatewayNoStream) {
          parsed.body.stream = false;
          var res = await gatewayFetch(target, {
            method: init.method || "POST", headers: headers,
            body: JSON.stringify(parsed.body), signal: init.signal
          }, cfg);
          if (!res.ok) return res;
          var json = await res.json();
          return jsonToSseStream(json);
        }
        body = JSON.stringify(parsed.body);
      } catch (e) {
        log("body rewrite failed, passing through", e);
      }
    }

    log("gateway ->", init.method || "POST", target.toString());
    var resp = await gatewayFetch(target, {
      method: init.method || "POST", headers: headers, body: body, signal: init.signal
    }, cfg);
    try {
      var sentModel = "";
      try { sentModel = JSON.parse(body || "{}").model || ""; } catch (e2) {}
      var reqModel = "";
      try { reqModel = JSON.parse(init.body || "{}").model || ""; } catch (e2) {}
      if (!resp.ok) {
        resp.clone().text().then(function (txt) {
          logGatewayCall(target.toString(), resp.status, reqModel, sentModel, txt);
        }).catch(function () {});
      } else {
        logGatewayCall(target.toString(), resp.status, reqModel, sentModel, "(成功，响应流已透传)");
      }
    } catch (e2) {}
    return resp;
  }

  /* ========================== fetch 补丁 ========================== */

  var origFetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;

  function headersFromInit(init, req) {
    var h = new Headers();
    if (req && req.headers) req.headers.forEach(function (v, k) { h.append(k, v); });
    if (init && init.headers) {
      if (init.headers.forEach) init.headers.forEach(function (v, k) { h.append(k, v); });
      else Object.keys(init.headers).forEach(function (k) { h.append(k, init.headers[k]); });
    }
    return h;
  }

  if (origFetch) {
    globalThis.fetch = function (input, init) {
      var urlStr = typeof input === "string" ? input : (input && input.url) ? input.url : String(input);
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();

      // 1) 遥测：直接吞掉
      if (isTelemetryUrl(urlStr)) {
        log("telemetry blocked:", method, urlStr);
        return Promise.resolve(blockedResponse());
      }

      var url;
      try { url = new URL(urlStr, typeof location !== "undefined" ? location.href : undefined); }
      catch (e) { return origFetch(input, init); }

      var isAnthropic = url.hostname === "api.anthropic.com";
      var isClaudeAi = /(^|\.)claude\.ai$/.test(url.hostname);

      // 2) /v1/* → 网关
      if (isAnthropic && /^\/v1\//.test(url.pathname)) {
        return getCfg().then(function (cfg) {
          if (!cfg.baseUrl || !cfg.apiKey) {
            return new Response(JSON.stringify({
              error: {
                type: "gateway_not_configured",
                message: "未配置网关：请在扩展的「网关配置」页填写网关地址与 API Key"
              }
            }), { status: 401, headers: { "content-type": "application/json" } });
          }
          try { gatewayHost = new URL(cfg.baseUrl).hostname; } catch (e) {}
          var reqBody = init && init.body;
          if (!reqBody && input && typeof input.text === "function" && method !== "GET") {
            // Request 对象携带 body（少见路径）：直接透传原请求但换 URL/头
            return input.clone().text().then(function (txt) {
              return handleApiMessage(urlStr, {
                method: method,
                headers: headersFromInit(init, input),
                body: txt,
                signal: (init && init.signal) || input.signal
              }, cfg);
            });
          }
          return handleApiMessage(urlStr, {
            method: method,
            headers: headersFromInit(init, input),
            body: typeof reqBody === "string" ? reqBody : undefined,
            signal: (init && init.signal) || (input && input.signal)
          }, cfg);
        });
      }

      // 3) 控制面 → 合成响应
      if (isAnthropic && /^\/api\//.test(url.pathname)) {
        return getCfg().then(function (cfg) {
          log("control-plane:", method, url.pathname + url.search);
          return controlPlaneResponse(cfg, url, method);
        });
      }
      if (isClaudeAi) {
        return getCfg().then(function (cfg) {
          log("claude.ai synthetic:", method, url.pathname + url.search);
          return controlPlaneResponse(cfg, url, method);
        });
      }

      // 4) 其余请求原样放行
      return origFetch(input, init);
    };
  }

  /* =============== WebSocket / sendBeacon / XHR / EventSource 补丁 =============== */

  try {
    // 屏蔽 Anthropic 浏览器中继桥（bridge.claudeusercontent.com）与遥测 WebSocket：
    // 返回“永远停留在 CONNECTING”的假 WS——不触发任何事件回调，
    // 避免 403 重连风暴与 bridge 状态变更引发的 React 状态循环。
    if (globalThis.WebSocket) {
      var OrigWS = globalThis.WebSocket;
      var BLOCK_WS_RE = /(claudeusercontent\.com|sentry\.io|datadoghq|growthbook\.io|statsig|featuregates\.org|segment\.(io|com))/i;
      var FakePendingWS = function (url) {
        this.url = String(url);
        this.readyState = 0; // CONNECTING，永不变化
        this.bufferedAmount = 0;
        this.binaryType = "blob";
        this.extensions = "";
        this.protocol = "";
        this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      };
      FakePendingWS.prototype.send = function () {};
      FakePendingWS.prototype.close = function () {};
      FakePendingWS.prototype.addEventListener = function () {};
      FakePendingWS.prototype.removeEventListener = function () {};
      FakePendingWS.prototype.dispatchEvent = function () { return false; };
      FakePendingWS.CONNECTING = 0; FakePendingWS.OPEN = 1; FakePendingWS.CLOSING = 2; FakePendingWS.CLOSED = 3;
      globalThis.WebSocket = function (url, protocols) {
        if (BLOCK_WS_RE.test(String(url))) {
          log("WebSocket blocked:", String(url));
          return new FakePendingWS(url);
        }
        return protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      };
      globalThis.WebSocket.prototype = OrigWS.prototype;
      globalThis.WebSocket.CONNECTING = 0; globalThis.WebSocket.OPEN = 1;
      globalThis.WebSocket.CLOSING = 2; globalThis.WebSocket.CLOSED = 3;
    }
  } catch (e) {}

  try {
    if (navigator.sendBeacon) {
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        if (isTelemetryUrl(String(url))) { log("sendBeacon blocked:", url); return true; }
        return origBeacon(url, data);
      };
    }
  } catch (e) {}

  try {
    if (globalThis.XMLHttpRequest) {
      var origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        if (isTelemetryUrl(String(url))) {
          log("XHR blocked:", url);
          throw new Error("[gateway-shim] telemetry request blocked: " + url);
        }
        return origOpen.apply(this, arguments);
      };
    }
  } catch (e) {}

  try {
    if (globalThis.EventSource) {
      var OrigES = globalThis.EventSource;
      var FakeES = function (url) {
        if (isTelemetryUrl(String(url))) {
          log("EventSource blocked:", url);
          var dummy = {
            url: String(url), readyState: 2, CONNECTING: 0, OPEN: 1, CLOSED: 2,
            onopen: null, onmessage: null, onerror: null,
            addEventListener: function () {}, removeEventListener: function () {},
            dispatchEvent: function () { return false; }, close: function () {}
          };
          setTimeout(function () { if (dummy.onerror) dummy.onerror(new Event("error")); }, 0);
          return dummy;
        }
        return new OrigES(url);
      };
      FakeES.prototype = OrigES.prototype;
      FakeES.CONNECTING = 0; FakeES.OPEN = 1; FakeES.CLOSED = 2;
      globalThis.EventSource = FakeES;
    }
  } catch (e) {}

  /* ====================== 错误诊断记录 ====================== */

  var DIAG_KEY = "gatewayDiagnostics";
  var CTX = typeof ServiceWorkerGlobalScope !== "undefined" ? "service-worker" :
    (typeof location !== "undefined" && /sidepanel\.html/.test(location.pathname)) ? "sidepanel" :
    (typeof location !== "undefined" && /gateway\//.test(location.pathname)) ? "gateway-page" : "page";

  function recordDiag(kind, message, stack, where) {
    try {
      chrome.storage.local.get(DIAG_KEY, function (r) {
        var list = (r && r[DIAG_KEY]) || [];
        list.unshift({
          kind: kind, ctx: CTX,
          message: String(message == null ? "" : message).slice(0, 400),
          stack: String((where ? "[" + where + "] " : "") + (stack == null ? "" : stack)).slice(0, 1500),
          ts: Date.now()
        });
        var out = list.slice(0, 25);
        chrome.storage.local.set({ [DIAG_KEY]: out });
      });
    } catch (e) {}
  }

  try {
    if (globalThis.addEventListener) {
      globalThis.addEventListener("error", function (e) {
        var where = (e && e.filename) ? (String(e.filename).split("/").pop() + ":" + e.lineno + ":" + e.colno) : "";
        recordDiag("error", e && (e.message || (e.error && e.error.message)), e && e.error && e.error.stack, where);
      });
      globalThis.addEventListener("unhandledrejection", function (e) {
        var r = e && e.reason;
        recordDiag("rejection", r && r.message ? r.message : String(r), r && r.stack, "");
      });
    }
    // 心跳：让配置页能验证“当前加载的构建”与“哪些上下文已激活垫片”
    try {
      chrome.storage.local.get("gatewayShimStatus", function (r) {
        var s = (r && r["gatewayShimStatus"]) || {};
        s[CTX] = Date.now();
        s.build = BUILD_TAG;
        chrome.storage.local.set({ gatewayShimStatus: s });
      });
    } catch (e) {}
    recordDiag("info", "shim loaded (" + BUILD_TAG + ")", "");
  } catch (e) {}

  /* ============================ 启动 ============================ */

  syncAuthState();
  log("installed in", typeof ServiceWorkerGlobalScope !== "undefined" ? "service-worker" : "page");
})();
