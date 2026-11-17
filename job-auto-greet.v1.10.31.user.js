// ==UserScript==
// @name         招聘平台自动打招呼助手（BOSS / 智联 / 鱼泡）
// @namespace    job-deliver.local
// @version      1.10.32
// @description  在 BOSS直聘、智联招聘、鱼泡直聘职位列表自动打招呼：预设话术、区间扫描、已沟通跳过、BOSS 跨页续跑、速率控制与紧凑配置面板。
// @author       job_deliver
// @match        https://www.zhipin.com/*
// @match        https://www.zhaopin.com/*
// @match        https://sou.zhaopin.com/*
// @match        https://www.yupao.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const HOST_ID = 'jd-auto-greet-host';
  const STORAGE_KEY = 'jd_auto_greet_config_v1';
  const DEFAULT_GREETING = '您好，我看到贵公司正在招聘这个岗位，我有相关工作经验，能吃苦耐劳、工作踏实，可尽快到岗。方便的话想和您进一步沟通，期待您的回复，谢谢！';

  const DEFAULT_PRESETS = [
    DEFAULT_GREETING,
    '您好，我对这个岗位很感兴趣，做事踏实、服从安排，可尽快到岗。方便的话想和您聊聊，期待回复。',
    '您好，打扰一下，我想应聘这个岗位，有相关经验，能吃苦、工作稳定，期待和您进一步沟通，谢谢！'
  ];

  const DEFAULT_CONFIG = {
    greeting: DEFAULT_GREETING,
    presets: DEFAULT_PRESETS.slice(),
    // 当前选中的预设下标；关闭随机模式时固定使用这一条。
    selectedPreset: 0,
    randomPreset: true,
    maxJobs: 20,
    minInterval: 3,
    maxInterval: 6,
    // 自动打招呼总开关：关闭后仍执行卡片切换与已沟通职位跳过，
    // 但不会点击沟通按钮、不填写话术、不发送，避免误触平台沟通/投递。
    enableGreeting: true,
    // v1.10.6：区间扫描。启用后只处理列表中第 rangeStart~rangeEnd 条职位，
    // 与“循环模式（按处理数量）”互斥；关闭时行为与旧版完全一致。
    rangeEnabled: false,
    rangeStart: 1,
    rangeEnd: 20,
    // v1.10.7：BOSS 聊天页发送完成后自动返回列表页（保留筛选条件与滚动位置）。
    // 关闭后停留在聊天页，由用户手动返回；返回列表仍会自动续跑。
    bossAutoReturn: true,
    // v1.10.12：智联「已向对方发送打招呼」结果弹窗自动关闭。
    // 该弹窗带全屏遮罩，不关闭会拦截后续卡片点击，默认开启。
    zhaopinAutoClose: true,
    // v1.10.13：鱼泡输入同步增强。解决「字已写入、计数器仍为 0/300、
    // 发送按钮灰色不可点」——补发完整输入事件并直调 Vue/React 输入处理器。
    yupaoInputFix: true,
    // v1.10.15：BOSS 聊天输入精确校验。聊天框可能残留草稿/上次未发内容，
    // execCommand 追加时会变成「旧内容 + 预设」，默认开启。
    bossInputStrict: true,
    // v1.10.29：BOSS 聊天页会话一致性校验开关。填写/发送前校验当前会话
    // 与目标职位一致，不一致时跳过该职位；详情页与列表项存在正常差异
    // （标题省略、改版文案）导致被误跳过时可关闭。默认开启保持原有防错发行为。
    bossSessionVerify: true,
    // v1.10.8：平滑速率控制（防风控）。三项可独立开关，默认全开。
    // rateControl：不规则随机间隔 + 周期性长休息。
    // humanize：点击前模拟人工悬停、微滚动与阅读停顿。
    // adaptiveRate：连续异常时自动拉长间隔，恢复后逐步回到原速。
    rateControl: true,
    humanize: true,
    adaptiveRate: true
  };

  // 投递/简历类按钮一律不作为沟通按钮候选，避免误点。
  // 归一化结果只计算一次，供热路径复用。
  const FORBIDDEN_ACTION_WORDS = ['发送简历', '发送附件', '发送验证码', '投递', '申请'];
  const FORBIDDEN_ACTION_NORMS = FORBIDDEN_ACTION_WORDS.map(function (word) {
    return String(word).replace(/\s+/g, '').trim();
  });
  // 各平台详情根共用的智联兼容 XPath。
  // 只在 findDetailRoot 中统一拼接一次，zhaopin 配置不再重复声明，
  // 避免同一表达式在一次查找中执行两遍。
  const EXTRA_DETAIL_PATHS = [
    '//div[@class="job-detail-summary__actions"]',
    '//div[contains(@class,"job-detail-summary__actions")]',
    '//div[contains(@class,"job-detail-summary")]'
  ];

  // =========================================================================
  // 平台配置区
  // 统一以 XPath 为主定位；CSS 选择器和文字匹配仅作兜底。
  // 平台改版导致脚本失效时，优先在对应平台的 actionXPaths / inputXPaths 等数组中补充表达式。
  // =========================================================================
  const PLATFORM_DEFS = {
    boss: {
      key: 'boss',
      name: 'BOSS直聘',
      reactInvokeFallback: true,
      // v1.10：卡片点击后必须校验右侧详情已切换（旧版仅在有直调兜底时校验，
      // 且只点一次外层容器，BOSS 内层 li/div 的点击处理函数接不到事件）。
      verifyDetailSwitch: true,
      // 允许在点击无效时直接调用 React/Vue 处理函数（仅用于卡片与沟通按钮兜底）。
      frameworkInvoke: true,
      // 实测：点击「立即沟通」会从列表页跳转到独立聊天页 /web/geek/chat。
      chatPagePath: '/web/geek/chat',
      cardSelectors: [
        '.job-list-box .job-card-wrapper',
        '.job-card-wrapper',
        '.job-card-box',
        '.job-card-wrap',
        '.job-list-box > li'
      ],
      // XPath 主定位：取自禁用 JavaScript 时仍存在的静态 class/文字结构。
      cardXPaths: [
        '//div[contains(concat(" ",normalize-space(@class)," ")," job-card-wrapper ")]',
        '//div[contains(concat(" ",normalize-space(@class)," ")," job-card-wrap ")]',
        '//div[contains(@class,"job-card-box")]'
      ],
      titleSelectors: ['.job-name', '.job-title', '.job-card-left .job-name'],
      // 无职位链接时用于生成稳定 key；排除会随沟通状态变化的徽标文字。
      keySelectors: ['.job-name', '.job-salary', '.company-name', '.job-area'],
      detailSelectors: [
        '.job-detail-box',
        '.job-detail-wrapper',
        '.job-detail-container',
        '.job-detail-card',
        '.job-detail-summary',
        '.job-detail-panel'
      ],
      detailXPaths: [
        '//div[contains(@class,"job-detail-box")]',
        '//div[contains(@class,"job-detail-container")]',
        '//div[contains(@class,"job-detail-wrapper")]'
      ],
      // v1.10：详情切换校验用的“大盘”容器（含职位标题），
      // 与操作按钮区（detailSelectors）区分，避免只拿到按钮条导致校验失效。
      detailPanelSelectors: [
        '.job-detail-box',
        '.job-detail-wrapper',
        '.job-detail-container',
        '.job-detail-card',
        '.job-detail-panel',
        '.job-detail-summary'
      ],
      actionButtonSelectors: [
        'a.op-btn.op-btn-chat',
        'a.op-btn-chat',
        '.start-chat-btn',
        '.btn-startchat',
        '[class*="op-btn-chat"]'
      ],
      actionXPaths: [
        '//a[contains(@class,"op-btn-chat") and contains(normalize-space(.),"立即沟通")]',
        '//a[contains(@class,"op-btn-chat")]',
        '//a[contains(@class,"op-btn") and contains(@class,"op-btn-chat")]',
        '//a[contains(@class,"start-chat-btn")]'
      ],
      actionTexts: ['立即沟通', '马上沟通', '继续沟通'],
      preferredActionTexts: ['立即沟通', '马上沟通', '继续沟通'],
      skipActionTexts: ['继续沟通', '已沟通'],
      clickCardFirst: true,
      // 实测：BOSS 列表为左侧卡片 + 右侧详情面板，需点击卡片内层 li 切换详情。
      // v1.10：按“内层可点击节点 → 标题 → 卡片根”的顺序多目标点击。
      // 旧版只取第一个命中的选择器，命中不到就直接点外层 wrapper，
      // 而点击处理函数常声明在内层 div/li 上，事件接不到导致详情不切换。
      cardClickTargets: [
        'li.job-card-box',
        '.job-card-box',
        '.job-card-wrapper .job-card-left',
        '.job-card-wrapper .job-name',
        '.job-card-wrap .job-name',
        '.job-card-wrapper',
        '.job-card-wrap'
      ],
      // v1.10：卡片/详情上的已沟通状态文字，命中即跳过，不再点沟通按钮。
      communicatedTexts: ['已沟通', '已聊', '沟通中', '继续沟通'],
      actionScope: 'cardThenDetail',
      panelSelectors: [
        '.chat-dialog',
        '.chat-panel',
        '.chat-wrap',
        '.chat-container',
        '.chat-editor',
        '.chat-im',
        '.dialog-wrap',
        '.continue-chat-dialog',
        '[class*="chat-panel"]',
        '[class*="chat-dialog"]',
        '[class*="chat-wrap"]'
      ],
      panelXPaths: [
        '//div[contains(@class,"chat-container")]',
        '//div[contains(@class,"chat-wrap")]',
        '//div[contains(@class,"chat-im")]',
        '//div[contains(@class,"chat-panel")]'
      ],
      inputSelectors: [
        '#chat-input',
        '.chat-input',
        '.chat-editor [contenteditable="true"]',
        '.chat-editor textarea',
        '.chat-input textarea',
        '.chat-wrap [contenteditable="true"]',
        '.chat-wrap textarea',
        '.chat-im [contenteditable="true"]',
        '.chat-im textarea',
        '.dialog-wrap [contenteditable="true"]',
        '.dialog-wrap textarea'
      ],
      inputXPaths: [
        '//div[@id="chat-input"]',
        '//div[contains(@class,"chat-input")]',
        '//div[contains(@class,"chat-editor")]//div[@contenteditable="true"]',
        '//div[contains(@class,"chat-wrap")]//div[@contenteditable="true"]',
        '//div[contains(@class,"chat-wrap")]//textarea'
      ],
      sendButtonSelectors: [
        '.chat-op .btn-send',
        '.btn-send',
        '.send-btn',
        '.chat-send',
        '.chat-op .btn-sure-v2',
        '.dialog-wrap .btn-sure-v2'
      ],
      sendXPaths: [
        '//div[contains(@class,"chat-op")]//button[contains(@class,"btn-send")]',
        '//button[contains(@class,"btn-send")]',
        '//button[contains(@class,"btn-sure-v2")]'
      ],
      sendTexts: ['发送', '发送消息', '确认发送', '确定'],
      closeSelectors: [
        '.chat-op .close',
        '.chat-close',
        '.dialog-close',
        '.close-btn',
        '.dialog-wrap .close',
        '[class*="chat"] [class*="close"]'
      ],
      closeXPaths: [
        '//div[contains(@class,"chat-op")]//*[contains(@class,"close")]',
        '//div[contains(@class,"chat")]//*[contains(@class,"close")]',
        '//*[normalize-space(.)="关闭"]'
      ],
      closeTexts: ['关闭', '知道了', '留在此页'],
      loginSelectors: [
        '.boss-login-dialog',
        '.boss-login-dialog-mask',
        '.login-dialog',
        '[class*="login-dialog"]'
      ]
    },

    zhaopin: {
      key: 'zhaopin',
      name: '智联招聘',
      // v1.10：智联此前没有直调兜底，详情切换校验被整段跳过，
      // 卡片点击未生效时仍会读取上一个职位的操作区按钮。
      verifyDetailSwitch: true,
      frameworkInvoke: true,
      cardSelectors: ['.job-card', '.joblist-box__item', '.job-list-box .job-card'],
      cardXPaths: [
        '//div[contains(concat(" ",normalize-space(@class)," ")," job-card ")]'
      ],
      // 智联列表页为“左侧职位卡片 + 右侧详情面板”，需先点击卡片再读取详情面板按钮。
      // v1.10：补详情头部标题候选，供详情切换校验比对（卡片内不会有这些类名）。
      titleSelectors: [
        '.job-card__name',
        '.jobinfo__name',
        '.job-card__title-main',
        '.job-card__title-clamp',
        '.job-detail-summary__title',
        '.job-detail__title',
        '.job-name',
        'h1'
      ],
      keySelectors: ['.job-card__name', '.job-card__title-main', '.jobinfo__salary', '.job-card__salary', '.job-card__company', '.job-card__location'],
      detailSelectors: [
        '.job-detail-summary__actions',
        '.job-detail-summary',
        '.job-detail-panel',
        '.job-detail-card',
        '.job-detail-modules'
      ],
      // 详情根 XPath 由 EXTRA_DETAIL_PATHS 统一提供，这里不再重复声明。
      // v1.10：详情切换校验用“大盘”容器；detailSelectors 首项只是操作按钮条，
      // 用它做校验会找不到职位标题，从而永远“保守放行”。
      detailPanelSelectors: [
        '.job-detail-summary',
        '.job-detail-panel',
        '.job-detail-card',
        '.job-detail-modules',
        '.job-detail-content',
        '.job-detail',
        '.jobinfo'
      ],
      detailPanelXPaths: [
        '//div[contains(@class,"job-detail-summary") and not(contains(@class,"__actions"))]',
        '//div[contains(@class,"job-detail-modules")]',
        '//div[contains(@class,"job-detail-content")]'
      ],
      actionButtonSelectors: [
        '.job-detail-summary__apply',
        '.jobinfo__apply',
        '.job-card__apply',
        '.job-detail-summary__actions button',
        '.job-detail-summary__actions a'
      ],
      // v1.10：去掉“操作区第 1 个按钮”这种盲取写法（第 1 个可能是「立即投递」），
      // 改为文字优先：明确先点「先聊聊/立即沟通」，投递/申请类一律排除。
      actionXPaths: [
        '//div[contains(@class,"job-detail-summary__actions")]//button[contains(normalize-space(.),"先聊聊")]',
        '//button[contains(normalize-space(.),"先聊聊")]',
        '//a[contains(normalize-space(.),"先聊聊")]',
        '//div[contains(@class,"job-detail-summary__actions")]//button[contains(normalize-space(.),"立即沟通")]',
        '//div[contains(@class,"job-detail-summary__actions")]//button[contains(normalize-space(.),"继续沟通")]',
        '//button[contains(@class,"job-detail-summary__apply")][not(contains(normalize-space(.),"投递")) and not(contains(normalize-space(.),"申请"))]',
        '//div[contains(@class,"job-detail-summary__actions")]//button[not(contains(normalize-space(.),"投递")) and not(contains(normalize-space(.),"申请"))]',
        '//div[contains(@class,"job-detail-summary__actions")]//a[contains(normalize-space(.),"聊")]'
      ],
      actionTexts: ['先聊聊', '立即沟通', '马上沟通', '继续沟通'],
      preferredActionTexts: ['先聊聊', '立即沟通', '马上沟通', '继续沟通'],
      skipActionTexts: ['继续沟通', '已投递', '已沟通'],
      communicatedTexts: ['已沟通', '已聊', '沟通中', '继续沟通', '继续聊'],
      clickCardFirst: true,
      // v1.10：智联卡片点击优先命中标题节点（点击处理函数多挂在标题/内层 div 上），
      // 再退到卡片根节点；配合详情切换校验，避免右侧仍是上一个职位。
      cardClickTargets: [
        '.job-card__name',
        '.job-card__title-main',
        '.job-card__title-clamp',
        '.job-card',
        '.joblist-box__item'
      ],
      actionScope: 'detail',
      panelSelectors: [
        '.deliver-greeting-modal',
        '.chat-panel',
        '.im-chat-panel',
        '.chat-dialog',
        '.dialog-container',
        '[class*="chat-panel"]',
        '[class*="im-chat"]',
        '.a-modal'
      ],
      panelXPaths: [
        '//div[contains(@class,"deliver-greeting-modal")]',
        '//div[contains(@class,"chat-panel")]',
        '//div[contains(@class,"im-chat"] or contains(@class,"im-chat-panel")]'
      ],
      inputSelectors: [
        '.chat-input',
        '.chat-editor [contenteditable="true"]',
        '.chat-panel textarea',
        '.chat-panel [contenteditable="true"]',
        '.im-chat textarea',
        '.im-chat [contenteditable="true"]'
      ],
      inputXPaths: [
        '//div[contains(@class,"chat")]//textarea',
        '//div[contains(@class,"chat")]//*[@contenteditable="true"]',
        '//textarea[contains(@placeholder,"招呼")]'
      ],
      sendButtonSelectors: [
        '.send-btn',
        '.chat-send',
        '.chat-op .btn-send',
        'button[class*="send"]'
      ],
      sendXPaths: [
        '//div[contains(@class,"chat")]//button[contains(normalize-space(.),"发送")]',
        '//button[contains(normalize-space(.),"发送")]'
      ],
      sendTexts: ['发送', '发送消息', '确认发送', '确定'],
      closeSelectors: [
        '.deliver-greeting-modal__close',
        '.dialog-close',
        '.chat-close',
        '[class*="chat"] [class*="close"]'
      ],
      closeXPaths: [
        // v1.10.26：新版结果弹窗的「×」关闭按钮（aria-label=关闭）为首选，
        // 「留在此页」已变为「留在+城市名」动态文案，用 starts-with 兜底匹配。
        // v1.10.27：补「留在此页」实机 class（__footer 内 __btn--secondary）。
        '//div[contains(@class,"deliver-greeting-modal")]//button[@aria-label="关闭"]',
        '//div[contains(@class,"deliver-greeting-modal")]//button[contains(@class,"deliver-greeting-modal__close")]',
        '//div[contains(@class,"deliver-greeting-modal")]//button[contains(@class,"deliver-greeting-modal__btn--secondary")]',
        '//div[contains(@class,"deliver-greeting-modal")]//button[starts-with(normalize-space(.),"留在")]',
        '//div[contains(@class,"deliver-greeting-modal")]//button[contains(normalize-space(.),"留在此页")]',
        '//button[contains(normalize-space(.),"留在此页")]',
        '//div[contains(@class,"deliver-greeting-modal")]//*[contains(@class,"close")]'
      ],
      closeTexts: ['留在此页', '关闭', '知道了'],
      loginSelectors: ['.a-modal', '.zppp-input', '[class*="login-modal"]'],
      successSelectors: ['.deliver-greeting-modal'],
      successXPaths: [
        '//div[contains(@class,"deliver-greeting-modal")]'
      ],
      successTexts: [
        '已向对方发送简历和打招呼语',
        '已发送简历和打招呼语',
        '已向对方发送打招呼语',
        '已发送打招呼语',
        '已向对方发送简历'
      ]
    },

    yupao: {
      key: 'yupao',
      name: '鱼泡直聘',
      reactInvokeFallback: true,
      verifyDetailSwitch: true,
      frameworkInvoke: true,
      // 实测（登录态）：左侧为职位卡片列表（.ahjb 内 .ant-spin-container），
      // 右侧为 #mainR 详情面板，沟通按钮“免费聊/聊一聊/继续聊”位于详情头部。
      cardSelectors: [
        '.ahjb .ant-spin-container > div:first-child > div',
        '.ant-spin-container > div:first-child > div',
        '.list-con',
        '.job-item',
        '.job-list-item',
        '.position-item',
        '.job-card',
        '.list-item'
      ],
      cardXPaths: [
        '//div[contains(@class,"ahjb")]//div[contains(@class,"ant-spin-container")]/div[1]/div',
        '//div[contains(@class,"ant-spin-container")]/div[1]/div[.//a[contains(@href,"zhaogong")]]',
        '//div[contains(@class,"ant-spin-container")]/div[1]/div'
      ],
      // 详情面板标题是 h1.adhjc：titleSelectors 必须含 h1，否则切换校验在
      // 详情头部找不到任何标题元素 → 保守放行 → 重试梯子与直调兜底被短路。
      titleSelectors: ['a[href*="zhaogong"]', '.list-title', '.job-title', '.job-name', 'h3', 'h2', 'h1'],
      keySelectors: ['a[href*="zhaogong"]', '.list-title', '.job-title', '.accbi'],
      detailSelectors: ['#mainR', '.ahjh', '.ahji', '.job-detail', '.detail-box', '.job-detail-panel', '.detail-con'],
      detailXPaths: [
        '//div[@id="mainR"]',
        '//div[contains(@class,"ahjh")]',
        '//div[contains(@class,"ahji")]'
      ],
      actionButtonSelectors: [
        '#mainR div.abffj.abfge',
        '#mainR div.abffj',
        '.bottom-r a',
        '[class*="chat-btn"]',
        '[class*="contact-btn"]',
        '[class*="communicate-btn"]'
      ],
      // 实测：详情头部三个按钮为“发送简历 / 免费聊 / 拨打电话”，
      // 已沟通职位显示“继续聊”。
      // v1.10：先把作用域收紧到详情面板（#mainR / 详情根），再按“按钮容器文字”
      // 命中，最后才用全局文字兜底。旧版首条全局 //*[text()="免费聊"] 会先命中
      // 左侧列表/推荐位里的同名节点，导致点到的不是右侧详情按钮。
      actionXPaths: [
        '//div[@id="mainR"]//div[contains(@class,"abffj")][contains(normalize-space(.),"免费聊") or contains(normalize-space(.),"聊一聊")]',
        '//div[@id="mainR"]//*[normalize-space(text())="免费聊" or normalize-space(text())="聊一聊" or normalize-space(text())="继续聊"]',
        '//div[contains(@class,"ahji")]//div[contains(@class,"abffj")][contains(normalize-space(.),"聊")]',
        '//div[contains(@class,"abffj") and contains(@class,"abfge")][contains(normalize-space(.),"聊")]',
        '//*[normalize-space(text())="免费聊" or normalize-space(text())="聊一聊"]'
      ],
      actionTexts: ['免费聊', '聊一聊', '继续聊', '立即沟通', '马上沟通', '继续沟通'],
      preferredActionTexts: ['免费聊', '聊一聊', '立即沟通', '马上沟通', '继续沟通'],
      skipActionTexts: ['继续聊', '继续沟通', '已沟通'],
      communicatedTexts: ['已沟通', '已聊', '沟通中', '继续聊', '继续沟通'],
      clickCardFirst: true,
      // 点击卡片内标题链接切换右侧详情；safeClick 会阻止链接跳转。
      // v1.10：补齐标题/整卡目标，类名变化时仍能命中可点击节点。
      cardClickTargets: [
        '.accci',
        '.accbb',
        'a[href*="/zhaogong/"]',
        '.list-title',
        '.accbf',
        '.acbj'
      ],
      actionScope: 'detail',
      // 类名混淆：鱼泡每次刷新/发版类名都会变，类名只作首选拔，锚点兜底必须可靠。
      // detailAnchorTexts：只会出现在详情面板头部的按钮文字，用于反查详情根节点。
      detailAnchorTexts: ['免费聊', '聊一聊', '继续聊', '拨打电话'],
      // hrefCardSelector：职位卡片链接锚点，类名选择器全部失效时枚举卡片用。
      hrefCardSelector: 'a[href*="/zhaogong/"]',
      // 实测聊天窗口为 ant-drawer 右侧抽屉：输入 .fb-editor，发送 .btn-send。
      panelSelectors: [
        '.fb-chat-editor',
        '.fb-editor',
        '.ant-drawer-content-wrapper',
        '.ant-drawer-content',
        '.chat-record-page',
        '.chat-panel',
        '.chat-dialog',
        '.chat-box',
        '.chat-container',
        '.dialog-wrap',
        '.layui-layer',
        '.el-dialog',
        '.ant-modal'
      ],
      panelXPaths: [
        '//div[contains(@class,"fb-chat-editor")]',
        '//div[contains(@class,"ant-drawer-content-wrapper")]',
        '//div[contains(@class,"chat-record-page")]',
        '//div[contains(@class,"chat") and contains(@class,"panel")]',
        '//div[contains(@class,"chat-wrap")]'
      ],
      inputSelectors: [
        '.fb-editor',
        '.fb-chat-editor [contenteditable="true"]',
        '.fb-chat-editor textarea',
        '.chat-input',
        '.chat-panel textarea',
        '.chat-panel [contenteditable="true"]',
        '.chat-dialog textarea',
        '.chat-dialog [contenteditable="true"]',
        '.layui-layer textarea',
        '.el-dialog textarea'
      ],
      inputXPaths: [
        '//div[contains(@class,"fb-editor") and @contenteditable="true"]',
        '//div[contains(@class,"fb-chat-editor")]//div[@contenteditable="true"]',
        '//div[contains(@class,"ant-drawer")]//div[@contenteditable="true"]',
        '//textarea[contains(@placeholder,"善语")]',
        '//textarea[contains(@placeholder,"招呼")]',
        '//textarea[contains(@placeholder,"输入")]',
        '//textarea',
        '//div[@contenteditable="true"]'
      ],
      sendButtonSelectors: [
        '.btn-send',
        '.fb-chat-footer .btn-send',
        '.send-btn',
        '.chat-send',
        '[class*="send"]'
      ],
      sendXPaths: [
        '//button[contains(@class,"btn-send")]',
        '//div[contains(@class,"fb-chat-footer")]//button[contains(@class,"btn-send")]',
        '//button[normalize-space(.)="发送"]',
        '//div[normalize-space(.)="发送" and not(*)]',
        '//*[contains(@class,"send") and contains(normalize-space(.),"发送")]'
      ],
      sendTexts: ['发送', '发送消息', '确认发送', '确定'],
      closeSelectors: [
        '.ant-drawer-close',
        '.fb-chat-close',
        '.close-btn',
        '.chat-close',
        '.dialog-close',
        '.layui-layer-close'
      ],
      closeXPaths: [
        '//div[contains(@class,"ant-drawer")]//*[contains(@class,"close")]',
        '//*[normalize-space(.)="返回"]',
        '//*[normalize-space(.)="关闭"]'
      ],
      // 抽屉没有明显关闭按钮时，点击遮罩关闭。
      maskCloseSelectors: ['.ant-drawer-mask', '.ant-modal-mask', '.el-overlay'],
      closeTexts: ['关闭', '返回', '知道了', '取消'],
      loginSelectors: [
        '[class*="login-dialog"]',
        '[class*="login-modal"]',
        '[class*="login-box"]',
        '[class*="login-panel"]'
      ]
    }
  };

  function detectPlatform() {
    const host = location.hostname;
    if (host.indexOf('zhipin.com') !== -1) return PLATFORM_DEFS.boss;
    if (host.indexOf('zhaopin.com') !== -1) return PLATFORM_DEFS.zhaopin;
    if (host.indexOf('yupao.com') !== -1) return PLATFORM_DEFS.yupao;
    return null;
  }

  // 平台文字规则只归一化一次，避免在卡片/按钮扫描的热循环里反复 replace。
  function preparePlatformNorms(def) {
    def.actionNorms = def.actionTexts.map(norm);
    def.preferredActionNorms = (def.preferredActionTexts || def.actionTexts).map(norm);
    def.skipActionNorms = (def.skipActionTexts || []).map(norm);
    def.communicatedNorms = (def.communicatedTexts || def.skipActionTexts || []).map(norm);
    def.sendTextNorms = def.sendTexts.map(norm);
    def.closeTextNorms = def.closeTexts.map(norm);
    def.successTextNorms = (def.successTexts || []).map(norm);
  }

  const platform = detectPlatform();
  if (!platform) return;
  if (document.documentElement.hasAttribute('data-jd-auto-greet')) return;
  document.documentElement.setAttribute('data-jd-auto-greet', '1');
  preparePlatformNorms(platform);

  // =========================================================================
  // 运行状态
  // =========================================================================
  const state = {
    running: false,
    starting: false,
    stopRequested: false,
    sent: 0,
    skipped: 0,
    target: 0,
    failureStreak: 0,
    detailSwitchFails: 0,
    detailRootWarned: false,
    startPath: '',
    startHost: '',
    lastPresetIndex: -1,
    processed: new Set(),
    // v1.10.6：区间模式下的有效下标范围（含端点）；null 表示未启用区间模式。
    scanRange: null,
    // v1.10.12：区间目标的职位 key 快照。BOSS 返回列表后已沟通职位会被移除，
    // 下标会整体前移；按 key 定位可保持区间语义不变。
    scanRangeKeys: null,
    // v1.10.9：上一次职位卡片点击结束时间 / 下一次卡片点击的目标绝对时间。
    lastCardClickAt: 0,
    nextCardClickAt: 0,
    handedOff: false
  };

  // =========================================================================
  // 平滑速率控制（v1.10.8，防风控）
  // 独立于业务逻辑：只在“操作间隔”这一处叠加三类平滑策略。
  // 1) 不规则随机间隔：多数接近基准，少量偏长/偏短，避免固定节奏。
  // 2) 动态降速：连续异常时拉长间隔，恢复后逐步回到原速。
  // 3) 周期休息：每处理若干职位插入一次较长停顿，模拟人工节奏。
  // 三项均由面板开关控制，关闭后完全回到旧版行为。
  // =========================================================================
  const rateState = {
    intervalCount: 0,
    nextRestAt: 0,
    multiplier: 1
  };

  function resetRateControl() {
    rateState.intervalCount = 0;
    rateState.nextRestAt = randInt(6, 12);
    rateState.multiplier = 1;
  }

  function getRateMultiplier(config) {
    if (!config || config.rateControl === false || config.adaptiveRate === false) return 1;
    const fails = state.failureStreak || 0;
    const target = Math.min(3, 1 + fails * 0.6);
    if (target > rateState.multiplier + 0.01) {
      rateState.multiplier = target;
      log('速率控制：连续异常 ' + fails + ' 次，操作间隔自动放慢到 ' +
        target.toFixed(1) + ' 倍', 'warn');
    } else if (fails === 0) {
      // 连续异常清零后每次间隔回收 0.25 倍，避免速度突然跳变。
      rateState.multiplier = Math.max(1, rateState.multiplier - 0.25);
    }
    return rateState.multiplier;
  }

  let ui = null;
  let uiPresets = [];
  let uiSelectedPreset = 0;
  let watcherStarted = false;
  // 热路径短缓存：登录检测结果、当前聊天面板、卡片稳定 key。
  let loginCheckCache = { time: 0, result: null };
  let cachedChatPanel = null;
  const cardKeyCache = new WeakMap();
  const reactKeyCache = new WeakMap();
  let gmStorageAvailable = null;

  // GM 存储可用时只写 GM，不再同步镜像到 localStorage：
  // 配置/流程状态写入频率最高可到每个职位一次，双写属于纯冗余 IO。
  // localStorage 仍只在 GM 不可用或 GM 写入抛错时兜底，读取时保留迁移回退。
  function canUseGMStorage() {
    if (gmStorageAvailable !== null) return gmStorageAvailable;
    try {
      gmStorageAvailable = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    } catch (err) {
      gmStorageAvailable = false;
    }
    return gmStorageAvailable;
  }

  // 统一存储读写：GM 优先，失败或为空时回退旧版 localStorage。
  // 读取返回已解析的 JSON 值；配置在 GM 中是对象，流程/标记是 JSON 字符串，
  // 两种形式都兼容。会修改 gmStorageAvailable 的失败降级逻辑保持原样。
  function readStoredJSON(key) {
    let raw = null;
    try {
      if (canUseGMStorage()) raw = GM_getValue(key, null);
    } catch (err) {
      gmStorageAvailable = false;
      raw = null;
    }
    if (!raw) {
      try {
        raw = localStorage.getItem(key);
      } catch (err) {
        raw = null;
      }
    }
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (err) {
        raw = null;
      }
    }
    return raw;
  }

  // localValue 用于 GM 与 localStorage 需要不同序列化形式的场景（如配置对象）。
  function writeStoredValue(key, value, localValue) {
    if (canUseGMStorage()) {
      try {
        GM_setValue(key, value);
        return;
      } catch (err) {
        // GM 写入异常：后续读写统一切到 localStorage，避免读到旧的 GM 值。
        gmStorageAvailable = false;
      }
    }
    try {
      const serialized = localValue === undefined ? value : localValue;
      if (serialized === null) localStorage.removeItem(key);
      else localStorage.setItem(key, serialized);
    } catch (err) {
      // 忽略 localStorage 异常。
    }
  }

  // =========================================================================
  // BOSS 跨页流程状态（列表页 -> 聊天页 -> 返回列表页）
  // 状态存入存储，页面跳转后由新页面实例接管继续执行。
  // =========================================================================
  const FLOW_KEY = 'jd_auto_greet_boss_flow_v1';
  const FLOW_RESUME_WINDOW = 15 * 60 * 1000; // 超过 15 分钟的未完成流程不再自动续跑

  function isBossChatPage() {
    return platform.key === 'boss' && location.pathname === platform.chatPagePath;
  }

  function readFlow() {
    const raw = readStoredJSON(FLOW_KEY);
    return raw && typeof raw === 'object' ? raw : null;
  }

  function writeFlow(flow) {
    writeStoredValue(FLOW_KEY, flow === null ? null : JSON.stringify(flow));
  }

  function updateFlow(patch) {
    const flow = readFlow() || {};
    Object.assign(flow, patch);
    writeFlow(flow);
    return flow;
  }

  function stopBossFlow() {
    const flow = readFlow();
    if (flow && flow.active) {
      flow.active = false;
      flow.stopReason = '用户停止';
      writeFlow(flow);
    }
  }

  function syncStateFromFlow(flow) {
    if (!flow) return;
    state.sent = flow.sent || 0;
    state.skipped = flow.skipped || 0;
    state.target = flow.target || 0;
    state.failureStreak = flow.failStreak || 0;
    if (typeof flow.lastPresetIndex === 'number') {
      state.lastPresetIndex = flow.lastPresetIndex;
    }
    // v1.10.9：BOSS 跨页时延续卡片点击间隔的目标时间。
    state.lastCardClickAt = Number(flow.lastCardClickAt) || 0;
    state.nextCardClickAt = Number(flow.nextCardClickAt) || 0;
    (flow.processedKeys || []).forEach(function (k) {
      state.processed.add(k);
    });
    mergeBossMarks();
  }

  // =========================================================================
  // BOSS 已操作标记（v1.10.6）
  // 点击「立即沟通」前把职位稳定 key 写入本地存储；从独立聊天页返回列表页
  // 或下次重新开始时，识别到标记即跳过，避免对同一职位重复操作。
  // 与跨页流程状态分离：流程状态只负责单次任务交接，标记长期有效。
  // =========================================================================
  const BOSS_MARK_KEY = 'jd_auto_greet_boss_marks_v1';
  const BOSS_MARK_LIMIT = 800;
  let bossMarkCache = null;

  function readBossMarks() {
    if (bossMarkCache) return bossMarkCache;
    const raw = readStoredJSON(BOSS_MARK_KEY);
    bossMarkCache = Array.isArray(raw) ? raw.filter(function (item) {
      return typeof item === 'string' && item;
    }) : [];
    return bossMarkCache;
  }

  function writeBossMarks(list) {
    bossMarkCache = list.slice(-BOSS_MARK_LIMIT);
    writeStoredValue(BOSS_MARK_KEY, JSON.stringify(bossMarkCache));
  }

  function markBossJob(key) {
    if (platform.key !== 'boss' || !key) return;
    // BOSS 职位链接常带 lid/securityId 等易变参数，持久化标记只保留 pathname，
    // 保证同一职位在不同会话/不同链接参数下仍能命中。
    const mark = toPathname(key) || key;
    const list = readBossMarks();
    if (list.indexOf(mark) !== -1) return;
    list.push(mark);
    writeBossMarks(list);
  }

  // v1.10.11：会话校验失败时回滚标记，避免把“未实际发送”的职位永久跳过。
  function unmarkBossJob(key) {
    if (platform.key !== 'boss' || !key) return;
    const mark = toPathname(key) || key;
    const list = readBossMarks();
    const index = list.indexOf(mark);
    if (index === -1) return;
    list.splice(index, 1);
    writeBossMarks(list);
  }

  // 把本地标记并入已处理集合，复用现有循环的跳过机制，不改动核心遍历逻辑。
  // 标记是归一化 pathname，这里按当前卡片重新计算 key 后再并入，
  // 确保 processed 中的 key 与 findNextCardEntry 使用的 key 完全一致。
  function mergeBossMarks() {
    if (platform.key !== 'boss') return;
    const marks = readBossMarks();
    if (!marks.length) return;
    const marked = new Set(marks);
    collectCards().forEach(function (card) {
      const key = getJobKey(card);
      if (key && marked.has(toPathname(key) || key)) state.processed.add(key);
    });
  }

  // =========================================================================
  // 通用工具
  // =========================================================================
  function norm(value) {
    return String(value == null ? '' : value).replace(/\s+/g, '').trim();
  }

  function truncate(text, length) {
    const value = String(text || '');
    return value.length > length ? value.slice(0, length) + '…' : value;
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function elementDepth(el) {
    let depth = 0;
    let node = el;
    while (node && node.parentElement) {
      depth++;
      node = node.parentElement;
    }
    return depth;
  }

  // -------------------------------------------------------------------------
  // XPath 定位（三平台主定位方式，CSS/文字匹配仅作兜底）
  // -------------------------------------------------------------------------
  function xpathAll(expression, root) {
    const nodes = [];
    const doc = document;
    const original = String(expression == null ? '' : expression).trim();
    if (!original) return nodes;
    const scope = root && root !== doc ? root : doc;
    let expr = original;
    let context = doc;
    let needsContainsFilter = false;
    let scopedRewrite = false;
    try {
      if (scope !== doc) {
        if (expr.indexOf('//') === 0) {
          // 作用域查询：// 改为 .//，让 XPath 只在当前面板/卡片子树内查找。
          expr = '.' + expr;
          context = scope;
          scopedRewrite = true;
        } else if (expr.indexOf('.//') === 0) {
          context = scope;
        } else {
          // 绝对/相对路径无法安全改写：保持文档级查询并按作用域过滤。
          needsContainsFilter = true;
        }
      }
      const result = doc.evaluate(
        expr,
        context,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      for (let i = 0; i < result.snapshotLength; i++) {
        const node = result.snapshotItem(i);
        if (!node || node.nodeType !== 1) continue;
        if (needsContainsFilter && !scope.contains(node)) continue;
        nodes.push(node);
      }
      // 某些表达式把 root 自身写在路径里（如 //div[@id="mainR"]//button）。
      // .// 改写后找不到自身，此时回退到旧的文档级查询 + 作用域过滤，
      // 保证主 XPath 的优先级不被作用域优化破坏。
      if (scopedRewrite && nodes.length === 0) {
        const fallback = doc.evaluate(
          original,
          doc,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
        for (let i = 0; i < fallback.snapshotLength; i++) {
          const node = fallback.snapshotItem(i);
          if (!node || node.nodeType !== 1) continue;
          if (scope.contains(node)) nodes.push(node);
        }
      }
    } catch (err) {
      // 无效 XPath 或浏览器限制时返回空数组，由后续兜底逻辑处理。
    }
    return nodes;
  }

  function findXPathNodes(paths, root, predicate) {
    const result = [];
    const seen = new Set();
    (paths || []).forEach(function (expression) {
      xpathAll(expression, root).forEach(function (node) {
        if (seen.has(node)) return;
        if (predicate && !predicate(node)) return;
        seen.add(node);
        result.push(node);
      });
    });
    return result;
  }

  // 只需要第一个命中时不再收集全部结果（沟通按钮/输入框/关闭按钮等高频查询）。
  function findXPathNode(paths, root, predicate) {
    const list = paths || [];
    for (let p = 0; p < list.length; p++) {
      const nodes = xpathAll(list[p], root);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!predicate || predicate(node)) return node;
      }
    }
    return null;
  }

  // 卡片 XPath 按配置顺序命中：第一条有结果的路径即为本次卡片来源，
  // 避免每次循环都执行全部兜底 XPath。
  function findFirstXPathPath(paths, root, predicate) {
    const list = paths || [];
    for (let p = 0; p < list.length; p++) {
      const nodes = xpathAll(list[p], root);
      const picked = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (predicate && !predicate(node)) continue;
        picked.push(node);
      }
      if (picked.length) return picked;
    }
    return [];
  }

  function delay(ms) {
    const total = Math.max(0, ms);
    return new Promise(function (resolve) {
      const started = Date.now();
      function tick() {
        if (state.stopRequested || Date.now() - started >= total) {
          resolve();
          return;
        }
        setTimeout(tick, Math.min(250, Math.max(50, total - (Date.now() - started))));
      }
      tick();
    });
  }

  async function waitFor(fn, timeoutMs, intervalMs) {
    const started = Date.now();
    const step = intervalMs || 200;
    while (Date.now() - started < timeoutMs) {
      if (state.stopRequested) throw makeError('STOPPED', '任务已停止');
      let value = null;
      try {
        value = fn();
      } catch (err) {
        value = null;
      }
      if (value) return value;
      await delay(step);
    }
    return null;
  }

  function makeError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function isInPanel(el) {
    try {
      return !!(el && el.closest && el.closest('#' + HOST_ID));
    } catch (err) {
      return false;
    }
  }

  function isRendered(el) {
    if (!el || !el.isConnected) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    } catch (err) {
      return false;
    }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (isInPanel(el)) return false;
    try {
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
      }
    } catch (err) {
      // 部分浏览器不支持 checkVisibility 参数，继续使用下面的兼容判断。
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    } catch (err) {
      return false;
    }
    return true;
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.readOnly) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    if (el.isContentEditable && el.getAttribute('contenteditable') === 'false') return true;
    const className = typeof el.className === 'string' ? el.className : '';
    if (/(^|\s)disabled(\s|$)/.test(className)) return true;
    return false;
  }

  function humanHover(el) {
    if (!el) return;
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (err) {
      rect = { left: 0, top: 0, width: 0, height: 0 };
    }
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };
    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'].forEach(function (type) {
      try {
        if (typeof PointerEvent === 'function' && type.indexOf('pointer') === 0) {
          el.dispatchEvent(new PointerEvent(type, options));
        } else {
          el.dispatchEvent(new MouseEvent(type, options));
        }
      } catch (err) {
        // 忽略个别事件构造函数差异。
      }
    });
  }

  function humanClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (err) {
      try {
        el.scrollIntoView();
      } catch (ignore) {}
    }
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (err) {
      rect = { left: 0, top: 0, width: 0, height: 0 };
    }
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
      button: 0,
      buttons: 0
    };
    const sequence = [
      ['pointerover', true],
      ['pointerenter', true],
      ['mouseover', false],
      ['mouseenter', false],
      ['pointerdown', true],
      ['mousedown', false],
      ['pointerup', true],
      ['mouseup', false],
      ['click', false]
    ];
    sequence.forEach(function (item) {
      const type = item[0];
      const pointer = item[1] && typeof PointerEvent === 'function';
      try {
        el.dispatchEvent(pointer ? new PointerEvent(type, options) : new MouseEvent(type, options));
      } catch (err) {
        // 回退到 MouseEvent，保证点击事件至少能触发。
        if (type === 'click' || type === 'mousedown' || type === 'mouseup') {
          try {
            el.dispatchEvent(new MouseEvent(type, options));
          } catch (ignore) {}
        }
      }
    });
  }

  // v1.10.8：人工行为模拟（防风控）。在关键点击前加入：
  // 轻微滚动定位 → 悬停 → 阅读/瞄准停顿 → 元素内鼠标微移动 → 短停顿。
  // 仅在 humanize 开启时执行；不改变任何点击目标与业务判断。
  async function performHumanBehavior(config, el) {
    if (!config || config.humanize === false) return;
    if (el && el.isConnected) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch (err) {
        try {
          el.scrollIntoView();
        } catch (ignore) {}
      }
      humanHover(el);
    }
    await delay(randInt(180, 620));
    if (!el || !el.isConnected) return;
    try {
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width * (0.3 + Math.random() * 0.4));
      const y = Math.round(rect.top + rect.height * (0.3 + Math.random() * 0.4));
      el.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y
      }));
    } catch (err) {
      // 忽略个别浏览器的事件构造差异。
    }
    await delay(randInt(60, 200));
  }

  // =========================================================================
  // React 直调兜底（reactInvokeFallback 平台：鱼泡）
  // 鱼泡对合成事件设了门禁：dispatchEvent 派发的 pointer/mouse/click 会被
  // 静默丢弃（现象：按钮找到了、点了、页面毫无反应）。但 React 组件的事件
  // 处理函数本体挂在 DOM 节点的 __reactProps$ 属性上，直接调用它不经过
  // 事件系统，门禁拦不到；伪造事件的 isTrusted=true 也能骗过组件内检查。
  // =========================================================================
  let lastInvokedHandlers = null;
  let lastInvokedNode = null;

  // 框架绑定键（__reactProps$xxx / __reactFiber$xxx）每个元素只枚举一次；
  // 属性键名在同一次页面生命周期内稳定，props 对象本身仍然每次实时读取。
  function findReactKeys(el) {
    if (!el) return { propsKey: null, fiberKey: null };
    const cached = reactKeyCache.get(el);
    if (cached) return cached;
    const keys = Object.keys(el);
    let propsKey = null;
    let fiberKey = null;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!propsKey && key.indexOf('__reactProps$') === 0) propsKey = key;
      if (!fiberKey && (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0)) fiberKey = key;
    }
    const result = { propsKey: propsKey, fiberKey: fiberKey };
    if (propsKey || fiberKey) reactKeyCache.set(el, result);
    return result;
  }

  function reactFindProps(el) {
    if (!el) return null;
    const keys = findReactKeys(el);
    if (keys.propsKey) {
      const props = el[keys.propsKey];
      if (props && typeof props === 'object') return props;
    }
    // React 16 及更早版本没有 __reactProps$，从 fiber 节点取 memoizedProps。
    if (keys.fiberKey) {
      const fiber = el[keys.fiberKey];
      const props = fiber && (fiber.memoizedProps || (fiber.return && fiber.return.memoizedProps));
      if (props && typeof props === 'object') return props;
    }
    return null;
  }

  function makeFakeEvent(el, type, overrides) {
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (err) {
      rect = { left: 0, top: 0, width: 0, height: 0 };
    }
    const x = Math.round((rect.left || 0) + (rect.width || 0) / 2);
    const y = Math.round((rect.top || 0) + (rect.height || 0) / 2);
    const ov = overrides || {};
    // 用真实事件对象充当 nativeEvent：部分处理函数会读取 e.nativeEvent 的
    // 属性（坐标、构造器、isTrusted），纯对象会让他们中途抛错、被吞掉。
    let native = null;
    try {
      if (type.indexOf('key') === 0) {
        native = new KeyboardEvent(type, {
          key: ov.key || '', code: ov.code || '',
          bubbles: true, cancelable: true, composed: true, view: window
        });
      } else if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function') {
        native = new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true, view: window,
          clientX: x, clientY: y, button: 0, buttons: 1,
          pointerId: 1, pointerType: 'mouse', isPrimary: true
        });
      } else {
        native = new MouseEvent(type, {
          bubbles: true, cancelable: true, composed: true, view: window,
          clientX: x, clientY: y, button: 0, buttons: 1, detail: 1
        });
      }
    } catch (err) {
      native = null;
    }
    if (native) {
      // 实例自身属性遮蔽原型上的只读 getter。
      try { Object.defineProperty(native, 'isTrusted', { value: true }); } catch (err) {}
      if (type.indexOf('key') === 0) {
        try {
          Object.defineProperty(native, 'keyCode', { value: ov.keyCode || 0 });
          Object.defineProperty(native, 'which', { value: ov.which || 0 });
          Object.defineProperty(native, 'charCode', { value: ov.charCode || 0 });
        } catch (err) {}
      }
    }
    const event = {
      type: type,
      isTrusted: true,
      bubbles: true,
      cancelable: true,
      composed: true,
      target: el,
      currentTarget: el,
      srcElement: el,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      pageX: x,
      pageY: y,
      offsetX: Math.round((rect.width || 0) / 2),
      offsetY: Math.round((rect.height || 0) / 2),
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      detail: type === 'click' ? 1 : 0,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      pressure: type === 'pointerdown' || type === 'mousedown' ? 0.5 : 0,
      view: window,
      which: 1,
      timeStamp: Date.now(),
      preventDefault: function () {},
      stopPropagation: function () {},
      stopImmediatePropagation: function () {},
      nativeEvent: native,
      getModifierState: function () { return false; },
      composedPath: function () { return [el]; }
    };
    if (overrides) {
      for (const key in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) event[key] = overrides[key];
      }
    }
    return event;
  }

  function invokePropsHandlers(node, props, handlerNames, overrides) {
    if (!props) return false;
    let invoked = [];
    for (let i = 0; i < handlerNames.length; i++) {
      const handler = props[handlerNames[i]];
      if (typeof handler === 'function') {
        try {
          handler.call(node, makeFakeEvent(node, handlerNames[i].slice(2).toLowerCase(), overrides));
          invoked.push(handlerNames[i]);
        } catch (err) {}
      }
    }
    if (invoked.length) {
      lastInvokedHandlers = invoked;
      lastInvokedNode = node;
    }
    return invoked.length > 0;
  }

  function reactInvoke(el, handlerNames, overrides, maxLevels, scanInside) {
    if (!el) return false;
    let invoked = false;
    let sawReactProps = false;
    let sawVueProps = false;
    let node = el;
    const levels = maxLevels || 3;
    // 处理函数可能声明在父级容器上：沿祖先向上查找。
    // React 挂 __reactProps$，Vue 3（ant-design-vue 类名体系相同）挂
    // __vueParentComponent.vnode.props——两者都试，站点用哪套走哪套。
    for (let level = 0; level < levels && node && node !== document.body && !invoked; level++) {
      const rprops = reactFindProps(node);
      if (rprops) {
        sawReactProps = true;
        if (invokePropsHandlers(node, rprops, handlerNames, overrides)) invoked = true;
      }
      if (!invoked && node.__vueParentComponent) {
        const vprops = node.__vueParentComponent.vnode && node.__vueParentComponent.vnode.props;
        if (vprops) {
          sawVueProps = true;
          if (invokePropsHandlers(node, vprops, handlerNames, overrides)) invoked = true;
        }
      }
      if (!invoked) node = node.parentElement;
    }
    if (!invoked && scanInside && el) {
      // 处理函数可能声明在卡片内层元素上（鱼泡实测：div.accci）：向下扫描子级。
      let inside = [];
      try {
        inside = el.querySelectorAll('div, a, span, li');
      } catch (err) {
        inside = [];
      }
      for (let i = 0; i < inside.length && i < 40 && !invoked; i++) {
        const n = inside[i];
        if (!isRendered(n) || isInPanel(n)) continue;
        const rprops = reactFindProps(n);
        if (rprops && invokePropsHandlers(n, rprops, handlerNames, overrides)) invoked = true;
      }
    }
    if (!invoked && (sawReactProps || sawVueProps)) {
      const where = lastInvokedNode ? (lastInvokedNode.tagName + (lastInvokedNode.className ? '.' + String(lastInvokedNode.className).split(' ')[0] : '')) : '?';
      log('组件处理函数已调用但无效果（' + (sawReactProps ? 'React' : 'Vue') + ' @ ' + where + '：' + (lastInvokedHandlers || []).join('/') + '）', 'warn');
      // 直调诊断完成后释放节点引用，避免模块级变量长期持有已卸载的卡片子树。
      lastInvokedNode = null;
      lastInvokedHandlers = null;
    }
    return invoked;
  }

  function reactInvokeClick(el, maxLevels, scanInside) {
    return reactInvoke(el, ['onPointerDown', 'onMouseDown', 'onMouseUp', 'onClick'], null, maxLevels, scanInside);
  }

  // 组件树兜底：处理函数可能声明在无 DOM 的包装组件或更上层容器上
  // （列表事件委托写法），DOM 祖先链（reactInvoke）够不着时，
  // 沿 fiber.return 在 React 组件树里继续向上找并调用。
  let lastFiberHandlerScan = [];

  function reactInvokeClickFiber(el, maxLevels) {
    if (!el) return false;
    lastFiberHandlerScan = [];
    const fiberKey = findReactKeys(el).fiberKey;
    const fiber = fiberKey ? el[fiberKey] : null;
    if (!fiber) return false;
    const names = ['onPointerDown', 'onMouseDown', 'onMouseUp', 'onClick'];
    const levels = maxLevels || 16;
    let node = fiber;
    for (let i = 0; i < levels && node; i++) {
      const props = node.memoizedProps;
      if (props && typeof props === 'object') {
        const found = [];
        for (let n = 0; n < names.length; n++) {
          if (typeof props[names[n]] === 'function') found.push(names[n]);
        }
        if (found.length) lastFiberHandlerScan.push(found.join('/') + '@fiber' + i);
        if (invokePropsHandlers(el, props, names, null)) return true;
      }
      node = node.return;
    }
    return false;
  }

  // 判断元素周边是否存在可直调的框架绑定。纯原生事件页面没有这些键，
  // ensureDetailSwitched 据此跳过 6 次注定空转的组件直调重试。
  function hasFrameworkBinding(el, maxLevels, scanInside) {
    if (!el) return false;
    let node = el;
    const levels = maxLevels || 6;
    for (let i = 0; i < levels && node && node !== document.body; i++) {
      try {
        if (reactFindProps(node)) return true;
        if (findReactKeys(node).fiberKey) return true;
        if (node.__vueParentComponent || node.__vue__ || node._vei) return true;
      } catch (err) {}
      node = node.parentElement;
    }
    if (!scanInside) return false;
    let inside = [];
    try {
      inside = el.querySelectorAll('div, a, span, li, button');
    } catch (err) {
      inside = [];
    }
    const count = Math.min(inside.length, 40);
    for (let i = 0; i < count; i++) {
      const n = inside[i];
      if (!isRendered(n) || isInPanel(n)) continue;
      try {
        if (n._vei || n.__vueParentComponent || n.__vue__ || reactFindProps(n) || findReactKeys(n).fiberKey) {
          return true;
        }
      } catch (err) {}
    }
    return false;
  }

  // 启动时探测一次站点框架：卡片/标题元素及其祖先上能否找到 React/Vue 组件。
  // 都找不到 = 站点用原生 JS 绑定事件，直调兜底注定无效，日志直接挑明。
  function logUiFramework(seedCard) {
    if (!platform.reactInvokeFallback) return;
    let found = '未知（原生 JS 绑定事件，直调兜底可能无效）';
    // startBatch 已拿到本页卡片，直接复用第一张，避免再全量扫描一次。
    let node = seedCard || collectCards()[0] || document.querySelector('a[href]') || document.body;
    for (let i = 0; i < 6 && node; i++) {
      if (reactFindProps(node)) {
        found = 'React';
        break;
      }
      if (node.__vueParentComponent) {
        found = 'Vue';
        break;
      }
      // v1.10.2：Vue 3 _vei 调用器表 / Vue 2 __vue__ 实例（智联实测命中不了组件键）。
      if (node._vei) {
        found = 'Vue(_vei)';
        break;
      }
      if (node.__vue__) {
        found = 'Vue2';
        break;
      }
      node = node.parentElement;
    }
    log('UI 框架检测：' + found, found === 'React' || found === 'Vue' ? undefined : 'warn');
  }

  // =========================================================================
  // Vue 侧直调（v1.10.2）：智联实测合成点击被门禁丢弃，且卡片祖先链上
  // 找不到任何 __reactProps$ / __vueParentComponent（框架探测=未知），
  // 旧直调链全数空转。Vue 系的事件绑定还有三条 DOM 可见通道，此前未探测：
  //   1) Vue 3 模板事件以调用器表挂在元素属性 `_vei` 上（@click → _vei.onClick），
  //      直接调用调用器不经过事件系统，伪造事件 isTrusted=true 可过组件内门禁；
  //   2) Vue 3 组件实例 __vueParentComponent：沿 subTree vnode 树找 props.onXxx；
  //   3) Vue 2 组件实例 __vue__：沿 _vnode 树找 data.on。
  // =========================================================================
  const VUE_CLICK_HANDLER_NAMES = ['onClick', 'onPointerdown', 'onPointerDown', 'onMousedown', 'onMouseDown', 'onMouseup', 'onMouseUp', 'onPointerup', 'onPointerUp'];
  const VUE_HANDLER_TYPE = {
    onClick: 'click', onPointerdown: 'pointerdown', onPointerDown: 'pointerdown',
    onMousedown: 'mousedown', onMouseDown: 'mousedown',
    onMouseup: 'mouseup', onMouseUp: 'mouseup', onPointerup: 'pointerup', onPointerUp: 'pointerup'
  };
  let lastVueHandlerScan = [];

  function vueCallHandler(boundEl, seedEl, name, fn) {
    try {
      const fake = makeFakeEvent(seedEl, VUE_HANDLER_TYPE[name] || 'click', { currentTarget: boundEl || seedEl });
      fn.call(boundEl || seedEl, fake);
      const cls = boundEl && typeof boundEl.className === 'string' && boundEl.className
        ? '.' + String(boundEl.className).split(' ')[0] : '';
      lastVueHandlerScan.push(name + '@' + (boundEl ? boundEl.tagName : '?') + cls);
      return true;
    } catch (err) {
      return false;
    }
  }

  // 通道 1：元素上的 _vei 调用器表（Vue 3 patchEvent 写入）。
  function vueTryVei(node, seedEl) {
    let vei = null;
    try { vei = node._vei; } catch (err) { vei = null; }
    if (!vei || typeof vei !== 'object') return false;
    let invoked = false;
    for (let i = 0; i < VUE_CLICK_HANDLER_NAMES.length; i++) {
      const name = VUE_CLICK_HANDLER_NAMES[i];
      const fn = vei[name];
      if (typeof fn === 'function' && vueCallHandler(node, seedEl, name, fn)) invoked = true;
    }
    return invoked;
  }

  // 通道 2/3：沿组件 vnode 树找事件绑定并直调。
  // Vue 3：vnode.props.onXxx（subTree 树）；Vue 2：vnode.data.on（_vnode 树，事件名为小写）。
  function vueWalkVnode(vnode, seedEl, depth) {
    if (!vnode || depth > 8) return false;
    let invoked = false;
    try {
      const boundEl = vnode.el || vnode.elm || seedEl;
      const props = vnode.props || null;
      if (props) {
        for (let i = 0; i < VUE_CLICK_HANDLER_NAMES.length; i++) {
          const name = VUE_CLICK_HANDLER_NAMES[i];
          if (typeof props[name] === 'function' && vueCallHandler(boundEl, seedEl, name, props[name])) invoked = true;
        }
      }
      const on2 = vnode.data && vnode.data.on;
      if (on2 && typeof on2 === 'object') {
        const keys = Object.keys(on2);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const type = key === 'click' ? 'click' : (key === 'mousedown' ? 'mousedown' : (key === 'pointerdown' ? 'pointerdown' : null));
          if (!type) continue;
          const fn = on2[key];
          const fn2 = fn && typeof fn === 'object' && typeof fn.handler === 'function' ? fn.handler : fn;
          if (typeof fn2 === 'function' && vueCallHandler(boundEl, seedEl, type === 'click' ? 'onClick' : (type === 'mousedown' ? 'onMousedown' : 'onPointerdown'), fn2)) invoked = true;
        }
      }
      if (!invoked) {
        const children = vnode.children;
        if (Array.isArray(children)) {
          for (let i = 0; i < children.length && i < 30 && !invoked; i++) {
            const child = children[i];
            if (child && typeof child === 'object' && (child.el || child.elm || child.component || child.componentInstance || child.props || (child.data && child.data.on))) {
              if (vueWalkVnode(child, seedEl, depth + 1)) invoked = true;
            }
          }
        }
      }
      if (!invoked) {
        // Vue 3：子组件实例的 subTree；Vue 2：vnode.componentInstance._vnode。
        const sub = (vnode.component && vnode.component.subTree) ||
          (vnode.componentInstance && (vnode.componentInstance._vnode || vnode.componentInstance.$vnode)) || null;
        if (sub && sub !== vnode && vueWalkVnode(sub, seedEl, depth + 1)) invoked = true;
      }
    } catch (err) {
      // 组件内部结构随版本变化：任何异常都按未找到处理，不中断兜底链。
    }
    return invoked;
  }

  // Vue 直调入口：节点 + 祖先链（maxLevels 层）逐节点探测三条通道；
  // scanInside=true 时再向下扫描最多 40 个子级（处理函数可能挂在卡片内层标题上）。
  function vueInvokeDirect(el, maxLevels, scanInside) {
    if (!el) return false;
    lastVueHandlerScan = [];
    let invoked = false;
    let node = el;
    for (let level = 0; level < (maxLevels || 4) && node && node !== document.body && !invoked; level++) {
      if (vueTryVei(node, el)) invoked = true;
      if (!invoked && node.__vueParentComponent && node.__vueParentComponent.subTree) {
        if (vueWalkVnode(node.__vueParentComponent.subTree, el, 0)) invoked = true;
      }
      if (!invoked && node.__vue__) {
        const inst = node.__vue__;
        const rootVnode = inst._vnode || (inst.$vnode || null);
        if (rootVnode && vueWalkVnode(rootVnode, el, 0)) invoked = true;
      }
      if (!invoked) node = node.parentElement;
    }
    if (!invoked && scanInside && el) {
      let inside = [];
      try { inside = el.querySelectorAll('div, a, span, li, button'); } catch (err) { inside = []; }
      for (let i = 0; i < inside.length && i < 40 && !invoked; i++) {
        const n = inside[i];
        if (!isRendered(n) || isInPanel(n)) continue;
        if (vueTryVei(n, el)) invoked = true;
      }
    }
    if (invoked && lastVueHandlerScan.length) {
      log('Vue 直调已执行（' + lastVueHandlerScan.slice(0, 4).join(' / ') + '）');
    }
    return invoked;
  }

  function reactInvokeEnter(el) {
    const overrides = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13 };
    // Enter 发送逻辑常挂在编辑器的上层容器（回车换行/发送切换），多走几层。
    return reactInvoke(el, ['onKeyDown', 'onKeyPress', 'onKeyUp'], overrides, 6);
  }

  // v1.10.3：原生 HTMLElement.click()。2026-11-06 智联实机试验实锤：
  // dispatchEvent 派发的完整指针序列被站点门禁静默丢弃（详情纹丝不动），
  // 而原生 .click() 可穿透并正常切换详情（active 高亮同步移动）。
  // 两者都是合成事件（isTrusted=false），但 .click() 走浏览器内部激活路径，
  // 与自造 Event 对象的派发路径不同，门禁未覆盖。所有平台的点击链路
  // 均以 .click() 优先，原 dispatchEvent 链路降级为兜底。
  function nativeClick(el) {
    if (!el) return false;
    try {
      if (typeof el.click === 'function') {
        el.click();
        return true;
      }
    } catch (err) {}
    return false;
  }

  function safeClick(el) {
    if (!el) return;
    const blocker = function (event) {
      try {
        const anchor = event.target && event.target.closest ? event.target.closest('a') : null;
        if (anchor && el.contains(anchor)) event.preventDefault();
      } catch (err) {
        // 忽略选择器异常。
      }
    };
    document.addEventListener('click', blocker, true);
    try {
      humanClick(el);
    } finally {
      setTimeout(function () {
        document.removeEventListener('click', blocker, true);
      }, 0);
    }
  }

  function pressEscape() {
    const targets = [];
    if (document.activeElement) targets.push(document.activeElement);
    if (document.body) targets.push(document.body);
    targets.forEach(function (target) {
      try {
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true
        }));
      } catch (err) {
        // 忽略键盘事件构造失败。
      }
    });
  }

  function pressEnter(el) {
    if (!el) return;
    // v1.10.5：回车发送前先原生点击输入框取得焦点（实机观察：未聚焦时
    // 平台忽略回车），focus() 保留为兜底。
    try {
      nativeClick(el);
    } catch (err) {}
    try {
      el.focus();
    } catch (err) {}
    ['keydown', 'keypress', 'keyup'].forEach(function (type) {
      try {
        el.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        }));
      } catch (err) {
        // 忽略键盘事件构造失败。
      }
    });
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function dispatchInput(el, text) {
    try {
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        inputType: 'insertText',
        data: text
      }));
    } catch (err) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getEditorText(el) {
    if (!el) return '';
    if (el.isContentEditable) return el.innerText || el.textContent || '';
    return el.value || '';
  }

  async function setEditorValue(el, text) {
    if (!el) return;
    try {
      el.focus();
    } catch (err) {}
    if (el.isContentEditable) {
      let inserted = false;
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection ? window.getSelection() : null;
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        inserted = document.execCommand('insertText', false, text);
      } catch (err) {
        inserted = false;
      }
      if (!inserted || norm(getEditorText(el)).indexOf(norm(text).slice(0, 8)) === -1) {
        el.innerHTML = String(text).split('\n').map(function (line) {
          return '<p>' + (escapeHtml(line) || '<br>') + '</p>';
        }).join('');
        dispatchInput(el, text);
      }
    } else {
      const prototype = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, text);
        else el.value = text;
      } catch (err) {
        el.value = text;
      }
      dispatchInput(el, text);
    }
    if (platform.reactInvokeFallback) {
      // React 受控编辑器：DOM 写入未必进组件状态（表现为计数器 0/300、
      // 发送按钮禁用）。直接调用 onChange 把文本同步进组件状态。
      const props = reactFindProps(el);
      if (props && typeof props.onChange === 'function') {
        const fake = makeFakeEvent(el, 'input');
        try {
          fake.target = Object.create(el, {
            value: { value: String(text), writable: true, configurable: true }
          });
        } catch (err) {}
        try {
          props.onChange.call(el, fake);
        } catch (err) {}
      }
    }
    await delay(150);
  }

  function isNoiseInput(el) {
    if (!el) return true;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['tel', 'email', 'password', 'search', 'number', 'hidden', 'checkbox'].indexOf(type) !== -1) return true;
      const hint = (el.getAttribute('placeholder') || '') + ' ' +
        (el.getAttribute('aria-label') || '') + ' ' +
        (el.getAttribute('name') || '');
      if (/搜索|职位|城市|关键词|手机号|验证码|邮箱|密码|账号/.test(hint)) return true;
    }
    try {
      if (el.closest('header, nav, [class*="search"], [class*="header"], [class*="login"]') && !el.closest('[class*="chat"]')) {
        return true;
      }
    } catch (err) {
      // 忽略选择器异常。
    }
    return false;
  }

  function collectEditors() {
    const nodes = document.querySelectorAll(
      'textarea, input[type="text"], [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]'
    );
    return Array.prototype.slice.call(nodes).filter(function (el) {
      return isVisible(el) && !isNoiseInput(el);
    });
  }

  function findClickableByText(root, texts, options) {
    if (!root) return null;
    const wanted = texts.map(norm);
    const excludes = ((options && options.exclude) || []).map(norm);
    const partial = !!(options && options.partial);
    let bestExact = null;
    let bestLoose = null;
    const nodes = root.querySelectorAll('a, button, [role="button"], span, div, li, p');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (isInPanel(el)) continue;
      const raw = (el.textContent || '').trim();
      if (!raw || raw.length > 40) continue;
      const text = norm(raw);
      if (!text) continue;
      if (excludes.some(function (item) { return text.indexOf(item) !== -1; })) continue;
      const exact = wanted.some(function (item) { return text === item; });
      const loose = partial && text.length <= 16 && wanted.some(function (item) { return text.indexOf(item) !== -1; });
      if (!exact && !loose) continue;
      const clickable = el.closest('a, button, [role="button"]') || el;
      if (!isRendered(clickable) || isInPanel(clickable)) continue;
      const candidate = { el: clickable, depth: elementDepth(clickable), length: text.length };
      const current = exact ? bestExact : bestLoose;
      // 同一段文字可能同时命中外层容器和真正的按钮，优先选择层级更深、文字更短的节点。
      if (!current || candidate.depth > current.depth ||
        (candidate.depth === current.depth && candidate.length < current.length)) {
        if (exact) bestExact = candidate;
        else bestLoose = candidate;
      }
    }
    return bestExact ? bestExact.el : (bestLoose ? bestLoose.el : null);
  }

  // =========================================================================
  // 页面与职位卡片
  // =========================================================================
  function shouldActivate() {
    const path = location.pathname;
    if (platform.key === 'boss') {
      return path === '/web/geek/jobs' || path === '/web/geek/job' ||
        path.indexOf('/web/geek/jobs/') === 0 || path === platform.chatPagePath;
    }
    if (platform.key === 'zhaopin') {
      // 智联“设置招呼语”页面不注入脚本，避免误触“添加招呼语/设为默认”导致自动发送。
      if (isZhaopinGreetingSettingsPage()) return false;
      return path === '/jobs' || path.indexOf('/jobs/') === 0 || location.hostname.indexOf('sou.zhaopin.com') !== -1;
    }
    if (platform.key === 'yupao') {
      return path.indexOf('/topic/') === 0 || path.indexOf('/zhaopin/') === 0 ||
        path.indexOf('/joblist') === 0 || path.indexOf('/search') === 0;
    }
    return false;
  }

  function isZhaopinGreetingSettingsPage() {
    if (platform.key !== 'zhaopin') return false;
    try {
      // 先做一次廉价卡片查询：正常列表页直接返回，避免 startWatcher 每 2.5 秒
      // 读取一次 body.innerText（长页面会触发整页布局计算）。
      if (document.querySelector('.job-card, .joblist-box__item')) return false;
      const text = norm((document.body && document.body.innerText) || '').slice(0, 2500);
      const hasGreetingSetting = text.indexOf('添加招呼语') !== -1 && text.indexOf('设为默认') !== -1;
      return hasGreetingSetting;
    } catch (err) {
      return false;
    }
  }

  function matchesActionText(el) {
    if (!el) return false;
    const text = norm(el.textContent);
    if (!text) return true;
    if (text.length > 30) return false;
    return platform.actionNorms.some(function (item) {
      return text.indexOf(item) !== -1;
    });
  }

  function collectActionCandidates(root) {
    if (!root) return [];
    const result = [];
    const seen = new Set();

    function add(el) {
      if (!el || seen.has(el) || isInPanel(el) || !isRendered(el) || isDisabled(el)) return;
      seen.add(el);
      result.push(el);
    }

    // XPath 主定位：按平台配置的顺序优先命中。
    const xpathNodes = findXPathNodes(platform.actionXPaths, root, function (node) {
      return isRendered(node) && !isInPanel(node) && !isDisabled(node);
    });
    xpathNodes.forEach(function (node) {
      add(node.closest('a, button, [role="button"]') || node);
    });

    platform.actionButtonSelectors.forEach(function (selector) {
      try {
        const nodes = root.querySelectorAll(selector);
        for (let i = 0; i < nodes.length; i++) {
          if (matchesActionText(nodes[i])) add(nodes[i]);
        }
      } catch (err) {
        // 忽略无效选择器。
      }
    });

    const textCandidates = [];
    const textSeen = new Set();
    const nodes = root.querySelectorAll('a, button, [role="button"], span, div');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (isInPanel(el)) continue;
      const raw = (el.textContent || '').trim();
      if (!raw || raw.length > 30) continue;
      const text = norm(raw);
      if (!text) continue;
      const hit = platform.actionNorms.some(function (target) {
        return text === target || (text.length <= target.length + 6 && text.indexOf(target) !== -1);
      });
      if (!hit) continue;
      const clickable = el.closest('a, button, [role="button"]') || el;
      if (!clickable || textSeen.has(clickable) || !isRendered(clickable)) continue;
      textSeen.add(clickable);
      textCandidates.push(clickable);
    }

    // 由内向外排序，避免点到只是“包含按钮文字”的外层容器。
    // 深度只计算一次：此前比较函数每次比较都完整向上遍历 DOM。
    const depthMap = new Map();
    textCandidates.forEach(function (el) {
      if (!depthMap.has(el)) depthMap.set(el, elementDepth(el));
    });
    textCandidates.sort(function (a, b) {
      return depthMap.get(b) - depthMap.get(a);
    });
    textCandidates.forEach(add);

    // 去掉包含其他候选按钮的外层容器，只保留真正的按钮节点。
    return result.filter(function (el) {
      return !result.some(function (other) {
        return other !== el && el.contains(other);
      });
    });
  }

  function compareDocumentOrder(a, b) {
    if (a === b) return 0;
    try {
      const position = a.compareDocumentPosition(b);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    } catch (err) {
      // 忽略节点比较异常。
    }
    return 0;
  }

  // v1.10.17：鱼泡列表补充收集。
  // 实测列表首条常是置顶/推荐卡片，位于 ant-spin-container 虚拟列表之外，
  // 且可能不是 div（例如 <a>），原有 `.../div[1]/div` 会漏掉它，导致循环
  // 看起来从第二条开始。这里以职位链接为锚点，向上找“只对应一个职位”的
  // 卡片根，再与主收集结果合并；仅鱼泡生效。
  function yupaoJobPaths(node) {
    const paths = new Set();
    if (!node) return paths;
    try {
      if (node.matches && node.matches('a[href*="/zhaogong/"]')) {
        const self = toPathname(node.getAttribute('href') || '');
        if (self) paths.add(self);
      }
      const links = node.querySelectorAll('a[href*="/zhaogong/"]');
      for (let i = 0; i < links.length && i < 20; i++) {
        const path = toPathname(links[i].getAttribute('href') || '');
        if (path) paths.add(path);
      }
    } catch (err) {
      // 忽略匹配异常。
    }
    return paths;
  }

  function findYupaoCardRoot(link) {
    let node = link;
    let parent = node && node.parentElement;
    let best = link;
    // 向上找到“父级仍只包含当前职位”的最高一层；父级含多个职位时停止，
    // 避免把整个列表容器当成一张卡片。
    for (let depth = 0; depth < 6 && parent && parent !== document.body; depth++) {
      if (yupaoJobPaths(parent).size > 1) break;
      let rect = null;
      try { rect = parent.getBoundingClientRect(); } catch (err) { rect = null; }
      if (rect && (rect.width > 760 || rect.height > 420)) break;
      best = parent;
      node = parent;
      parent = node.parentElement;
    }
    return best;
  }

  function collectYupaoExtraCards(cards) {
    if (platform.key !== 'yupao') return [];
    let root = null;
    try {
      root = document.querySelector('#jobListBox') ||
        document.querySelector('.ahjb') ||
        document.querySelector('.ant-spin-container');
    } catch (err) {
      root = null;
    }
    if (!root) return [];
    let links = [];
    try {
      links = Array.prototype.slice.call(root.querySelectorAll('a[href*="/zhaogong/"]'));
    } catch (err) {
      links = [];
    }
    const extras = [];
    const seen = new Set();
    const cardSet = new Set(cards);
    // 从链接向上找是否已被主收集的卡片覆盖，避免 O(链接数 × 卡片数) 的 contains 扫描。
    const coveredByPrimary = function (link) {
      let node = link;
      while (node && node !== root && node !== document.body) {
        if (cardSet.has(node)) return true;
        node = node.parentElement;
      }
      return false;
    };
    // 详情面板里的“查看职位”也是 zhaogong 链接，不能当成列表卡片。
    const detailSelector = '#mainR, .ahjh, .ahji, .job-detail, .detail-box, .job-detail-panel, .detail-con';
    // 常见情况：列表首条职位链接已被主收集覆盖，说明没有遗漏的置顶卡，
    // 直接返回，避免每次 collectCards 都扫描全部职位链接。
    let firstLink = null;
    try { firstLink = root.querySelector('a[href*="/zhaogong/"]'); } catch (err) { firstLink = null; }
    if (!firstLink || coveredByPrimary(firstLink)) return [];
    for (let i = 0; i < links.length && i < 120; i++) {
      const link = links[i];
      if (!isRendered(link) || isInPanel(link)) continue;
      try {
        if (link.closest && link.closest(detailSelector)) continue;
      } catch (err) {
        // 忽略选择器异常。
      }
      if (coveredByPrimary(link)) continue;
      const card = findYupaoCardRoot(link);
      if (!card || seen.has(card) || !isRendered(card) || isInPanel(card)) continue;
      // 只接受单职位卡片根；包含多个职位的列表/分组容器交给主收集逻辑。
      if (yupaoJobPaths(card).size !== 1) continue;
      let duplicate = false;
      for (let c = 0; c < cards.length; c++) {
        if (cards[c] === card || cards[c].contains(card) || card.contains(cards[c])) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) continue;
      seen.add(card);
      extras.push(card);
    }
    return extras;
  }

  // v1.10.18：首条职位可能是没有 zhaogong 链接的置顶广告卡，链接锚点方案
  // 无法命中。以主收集的第一张卡片为锚点，向上逐层检查它前面的兄弟节点，
  // 只接受“单职位、可见、卡片尺寸、带薪资和职位特征”的节点，避免把筛选栏
  // 或推荐分组当成职位。仅鱼泡生效。
  function collectYupaoLeadingCards(cards) {
    if (platform.key !== 'yupao' || !cards.length) return [];
    let root = null;
    try {
      root = document.querySelector('#jobListBox') || document.querySelector('.ahjb');
    } catch (err) {
      root = null;
    }
    if (!root) {
      // 没有稳定列表容器时，取第一张主卡片向上 6 层内的最高祖先作为根，
      // 这样虚拟列表包裹层的前置兄弟（置顶卡）也能被检查到。
      let up = cards[0];
      let candidate = null;
      for (let depth = 0; depth < 6 && up && up.parentElement && up !== document.body; depth++) {
        up = up.parentElement;
        candidate = up;
      }
      root = candidate || (cards[0] && cards[0].parentElement);
    }
    if (!root) return [];

    // 快速路径：第一张主卡片在所有祖先层级都是首个子元素，说明它前面
    // 没有置顶卡，无需再逐层做尺寸/文本扫描。正常列表（无置顶卡）走这里。
    let probe = cards[0];
    let hasLeadingSibling = false;
    for (let depth = 0; depth < 6 && probe && probe !== root && probe.parentElement; depth++) {
      if (probe.previousElementSibling) {
        hasLeadingSibling = true;
        break;
      }
      probe = probe.parentElement;
    }
    if (!hasLeadingSibling) return [];

    const result = [];
    const seen = new Set();
    const cardLike = function (node) {
      if (!node || node.nodeType !== 1 || seen.has(node)) return false;
      if (!isRendered(node) || isInPanel(node)) return false;
      let rect = null;
      try { rect = node.getBoundingClientRect(); } catch (err) { rect = null; }
      if (!rect || rect.width < 180 || rect.width > 760 ||
        rect.height < 60 || rect.height > 400) return false;
      const rawText = node.textContent || '';
      if (rawText.length < 10 || rawText.length > 2000) return false;
      const text = norm(rawText);
      if (text.length < 10 || text.length > 600) return false;
      const hasSalary = /\d{2,}\s*[-~至]\s*\d{2,}\s*\/?\s*(天|月|时)/.test(text) ||
        /\d+(\.\d+)?\s*(元|k|K|万)\s*\/?\s*(天|月|时)?/.test(text);
      // 至少两个不同职位特征词，避免把“长白班”筛选栏误认成职位卡。
      const jobWords = text.match(/日结|月结|包吃|包住|五险|长白班|免费培训|交通补助|招聘|普工/g) || [];
      return hasSalary && new Set(jobWords).size >= 2;
    };
    const consider = function (node) {
      if (!node || seen.has(node)) return;
      const paths = yupaoJobPaths(node);
      // 多职位容器（推荐分组/列表包裹层）不作为单张卡片，也不展开，
      // 避免把推荐位里的多张职位插到主列表最前面。
      if (paths.size > 1) return;
      let children = [];
      try { children = Array.prototype.slice.call(node.children); } catch (err) { children = []; }
      for (let i = 0; i < children.length && i < 3; i++) {
        const child = children[i];
        if (cardLike(child) && yupaoJobPaths(child).size <= 1) {
          seen.add(child);
          result.push(child);
          return;
        }
      }
      if (cardLike(node)) {
        seen.add(node);
        result.push(node);
      }
    };

    let node = cards[0];
    for (let depth = 0; depth < 6 && node && node !== root && node.parentElement; depth++) {
      let prev = node.previousElementSibling;
      for (let step = 0; prev && step < 2; step++, prev = prev.previousElementSibling) {
        consider(prev);
      }
      node = node.parentElement;
    }
    return result;
  }

  function collectCards() {
    const cards = [];
    const seen = new Set();

    function addCard(node) {
      if (!node || seen.has(node) || !isRendered(node) || isInPanel(node)) return;
      // 卡片型平台过滤掉包含多个沟通按钮的“列表容器”；
      // 详情型平台的沟通按钮在右侧详情中，卡片本身不会包含按钮。
      if (platform.actionScope === 'card' && collectActionCandidates(node).length > 1) return;
      seen.add(node);
      cards.push(node);
    }

    // 1. XPath 主定位：按配置顺序取第一条有命中的路径，减少无效 XPath 执行。
    // v1.10.30：鱼泡改为“全部 cardXPaths 取并集”。旧逻辑首条路径命中即定局，
    // 列表中间若有卡片落在其他列表容器/分组（首条 XPath 未覆盖）就整张漏收，
    // 表现为日志序号直接从第 1 条跳到第 2 条、总数却未减少。
    if (platform.key === 'yupao') {
      findXPathNodes(platform.cardXPaths, null, function (node) {
        return isRendered(node) && !isInPanel(node);
      }).forEach(function (node) {
        // 多职位容器（推荐分组/合并包裹层）不是职位卡片；其子职位由下方
        // 链接锚点补收，避免把整组当成一条职位造成错匹配。
        if (yupaoJobPaths(node).size > 1) return;
        // 嵌套命中的外层容器与内层卡片只保留一个，避免同一职位重复入列。
        for (let c = 0; c < cards.length; c++) {
          if (cards[c] === node || cards[c].contains(node) || node.contains(cards[c])) return;
        }
        addCard(node);
      });
    } else {
      findFirstXPathPath(platform.cardXPaths, null, function (node) {
        return isRendered(node) && !isInPanel(node);
      }).forEach(addCard);
    }

    // 2. CSS 兜底
    if (!cards.length) {
      for (let s = 0; s < platform.cardSelectors.length; s++) {
        let nodes = [];
        try {
          nodes = Array.prototype.slice.call(document.querySelectorAll(platform.cardSelectors[s]));
        } catch (err) {
          nodes = [];
        }
        nodes.forEach(addCard);
        if (cards.length) break;
      }
    }

    // 2.5 链接锚点兜底（鱼泡类名混淆）：类名选择器全部失效时，
    // 按职位链接锚点枚举卡片，每个可见且未重复的链接自身即一张卡片。
    // 点击卡片即点击标题链接（safeClick 会阻止跳转），正是切换详情所需。
    if (!cards.length && platform.hrefCardSelector) {
      let anchorNodes = [];
      try {
        anchorNodes = Array.prototype.slice.call(
          document.querySelectorAll(platform.hrefCardSelector));
      } catch (err) {
        anchorNodes = [];
      }
      const seenHref = new Set();
      anchorNodes.forEach(function (a) {
        if (!isRendered(a) || isInPanel(a)) return;
        const href = (a.getAttribute('href') || '').split('?')[0];
        if (!href || seenHref.has(href)) return;
        seenHref.add(href);
        addCard(a);
      });
    }

    // 2.6 鱼泡补充收集：把虚拟列表之外的首条/置顶职位卡片并入，
    // 保证循环模式从页面第一条职位开始，而不是从虚拟列表的第一条开始。
    if (platform.key === 'yupao') {
      collectYupaoExtraCards(cards).forEach(addCard);
      // 链接锚点找不到时，按主卡片的前置兄弟位置补收（兼容无链接置顶卡）。
      collectYupaoLeadingCards(cards).forEach(addCard);
      // v1.10.30：链接锚点全量补收（列表首/中/尾覆盖）。
      // collectYupaoExtraCards 在首条链接已被覆盖时直接返回，只能救回首条
      // 非标卡；列表中间位置的 <a> 卡、带额外包裹层、或位于其他列表分组的
      // 卡片仍然漏收。这里按职位链接逐条反查卡片根，以职位 pathname 去重
      // 后并入，保证不遗漏且不重复。
      let listRoot = null;
      try {
        listRoot = document.querySelector('#jobListBox') ||
          document.querySelector('.ahjb') ||
          document.querySelector('.ant-spin-container');
      } catch (err) {
        listRoot = null;
      }
      if (listRoot) {
        // 已覆盖的职位路径只统计“单职位卡片”；多职位容器不算覆盖，
        // 否则它包含的子职位路径会阻止这些职位被真正补收。
        const coveredPaths = new Set();
        cards.forEach(function (card) {
          const paths = yupaoJobPaths(card);
          if (paths.size !== 1) return;
          paths.forEach(function (path) { coveredPaths.add(path); });
        });
        let anchors = [];
        try {
          anchors = Array.prototype.slice.call(listRoot.querySelectorAll('a[href*="/zhaogong/"]'));
        } catch (err) {
          anchors = [];
        }
        for (let i = 0; i < anchors.length && i < 200; i++) {
          const link = anchors[i];
          if (!isRendered(link) || isInPanel(link)) continue;
          // 详情面板里的“查看职位”等链接不是列表卡片，不能当成职位。
          try {
            if (link.closest('#mainR, .ahjh, .ahji, .job-detail, .detail-box, .job-detail-panel, .detail-con')) continue;
          } catch (err) {
            // 忽略选择器异常。
          }
          const jobPath = toPathname(link.getAttribute('href') || '');
          if (!jobPath || coveredPaths.has(jobPath)) continue;
          const cardRoot = findYupaoCardRoot(link);
          if (!cardRoot || !isRendered(cardRoot) || isInPanel(cardRoot)) continue;
          // 只接受单职位卡片根；分组/列表容器交给主收集逻辑。
          if (yupaoJobPaths(cardRoot).size !== 1) continue;
          let nested = false;
          for (let c = 0; c < cards.length; c++) {
            if (cards[c] === cardRoot ||
              cards[c].contains(cardRoot) || cardRoot.contains(cards[c])) {
              nested = true;
              break;
            }
          }
          if (nested) continue;
          coveredPaths.add(jobPath);
          addCard(cardRoot);
        }
      }
    }

    // 严格按页面从上到下的顺序处理，避免多组 XPath 命中后顺序错乱。
    cards.sort(compareDocumentOrder);
    return cards;
  }

  function getJobTitle(card) {
    if (!card) return '';
    // 链接锚点兜底枚举出的卡片本身就是 <a>，取自身文字即职位标题。
    if (card.tagName === 'A') {
      const text = (card.getAttribute('title') || card.textContent || '').trim();
      if (text) return text.replace(/\s+/g, ' ').slice(0, 60);
    }
    for (let i = 0; i < platform.titleSelectors.length; i++) {
      const selector = platform.titleSelectors[i];
      let node = null;
      try {
        node = card.querySelector(selector);
      } catch (err) {
        node = null;
      }
      if (node && isRendered(node)) {
        const text = (node.textContent || '').trim();
        if (text) return text.replace(/\s+/g, ' ').slice(0, 60);
      }
    }
    let link = null;
    try {
      link = card.querySelector('a[href*="job"], a[href*="zhaogong"], a[href*="position"]');
    } catch (err) {
      link = null;
    }
    if (link) {
      const text = (link.getAttribute('title') || link.textContent || '').trim();
      if (text) return text.replace(/\s+/g, ' ').slice(0, 60);
    }
    // v1.10.19：置顶/品牌卡的标题可能不在标准 class 或职位链接里。
    // 此时整卡 textContent 会把薪资/公司/标签拼进标题，详情切换校验会
    // 误判为“未切换”（睿博这类置顶卡被跳过的根因）。
    // 先取可视文本第一行（标题通常独占一行），再扫描卡片顶部叶子文本。
    let visual = '';
    try { visual = card.innerText || ''; } catch (err) { visual = ''; }
    if (typeof visual === 'string' && visual) {
      const firstLine = visual.split(/\n+/).map(function (line) {
        return line.trim();
      }).filter(Boolean)[0] || '';
      if (firstLine.length >= 4) return norm(firstLine).slice(0, 60);
    }
    let candidates = [];
    try {
      candidates = card.querySelectorAll(
        'a, h1, h2, h3, h4, [class*="title"], [class*="name"], div, span'
      );
    } catch (err) {
      candidates = [];
    }
    let cardTop = 0;
    try { cardTop = card.getBoundingClientRect().top; } catch (err) { cardTop = 0; }
    for (let i = 0; i < candidates.length && i < 40; i++) {
      const node = candidates[i];
      if (!isRendered(node) || isInPanel(node)) continue;
      // 只取叶子文本，避免把“标题 + 薪资”的外层容器整段当成标题。
      const childNodes = node.children || [];
      let hasTextChild = false;
      for (let c = 0; c < childNodes.length; c++) {
        if (norm(childNodes[c].textContent).length >= 4) {
          hasTextChild = true;
          break;
        }
      }
      if (hasTextChild) continue;
      const text = norm(node.textContent);
      if (text.length < 4 || text.length > 80) continue;
      let nodeTop = 0;
      try { nodeTop = node.getBoundingClientRect().top; } catch (err) { nodeTop = cardTop; }
      if (nodeTop - cardTop > 80) continue;
      return text.slice(0, 60);
    }
    return norm(card.textContent).slice(0, 60);
  }

  // 去掉会随沟通状态变化的徽标文字，保证无链接卡片在沟通过后 key 不漂移。
  function stripStatusWords(value) {
    let result = String(value || '');
    const words = (platform.communicatedNorms || []).concat(platform.skipActionNorms || []);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word) result = result.split(word).join('');
    }
    return result;
  }

  function getJobKey(card) {
    if (!card) return '';
    let href = '';
    try {
      const link = card.querySelector('a[href*="job"], a[href*="zhaogong"], a[href*="position"]');
      if (link) href = (link.getAttribute('href') || '').trim();
    } catch (err) {
      href = '';
    }
    if (href && !/^javascript:|^#$/i.test(href)) {
      // 有职位链接时 href 本身就是最稳定的 key；缓存后每次只复核一次 href。
      const cached = cardKeyCache.get(card);
      if (cached && cached.href === href) return cached.key;
      cardKeyCache.set(card, { href: href, key: href });
      return href;
    }
    // 无职位链接（智联常见）：标题 + 稳定字段（薪资/公司/地区）生成 key，
    // 不再把整段卡片文本（含「继续沟通/已沟通」徽标）纳入 key。
    const parts = [stripStatusWords(norm(getJobTitle(card)))];
    const selectors = platform.keySelectors || [];
    for (let i = 0; i < selectors.length; i++) {
      let node = null;
      try {
        node = card.querySelector(selectors[i]);
      } catch (err) {
        node = null;
      }
      if (!node) continue;
      const text = norm(node.textContent || node.getAttribute('title') || '').slice(0, 40);
      if (text && parts.indexOf(text) === -1) parts.push(text);
    }
    if (parts.length > 1) return parts.join('|').slice(0, 160);
    return (parts[0] + '|' + stripStatusWords(norm(card.textContent)).slice(0, 80)).slice(0, 160);
  }

  // v1.10.12：按稳定 key 重新定位职位卡片。
  // BOSS 返回列表后会移除已沟通职位，原 DOM 节点与下标都会失效；
  // 这里每次按当前列表重新查询，避免索引错位后点到别的职位。
  function findCardByKey(key) {
    if (!key) return null;
    const cards = collectCards();
    const targetPath = platform.key === 'boss' ? toPathname(key) : '';
    for (let i = 0; i < cards.length; i++) {
      const cardKey = getJobKey(cards[i]);
      if (cardKey === key) return cards[i];
      // BOSS 链接参数可能已刷新，同 pathname 视为同一职位。
      if (targetPath && toPathname(cardKey) === targetPath) return cards[i];
    }
    return null;
  }

  async function waitForLiveCard(key, timeoutMs) {
    return waitFor(function () {
      const card = findCardByKey(key);
      return card && isRendered(card) ? card : null;
    }, timeoutMs || 1600, 120);
  }

  // BOSS 已操作标记也参与“是否处理过”判定：链接参数变化或跨页后
  // processed 集合丢失时，仍能凭 pathname 标记跳过已沟通职位。
  function isCardProcessed(key) {
    if (!key) return false;
    if (state.processed.has(key)) return true;
    if (platform.key !== 'boss') return false;
    const path = toPathname(key);
    if (!path) return false;
    if (state.processed.has(path)) return true;
    return readBossMarks().indexOf(path) !== -1;
  }

  function findNextCardEntry() {
    const cards = collectCards();
    const range = state.scanRange;
    // 循环模式：scanRange/scanRangeKeys 均为 null，i 从 0 开始。
    // 若首条职位未处理，先检查 collectCards 是否漏收（如鱼泡置顶卡在
    // 虚拟列表之外），不要通过偏移索引来“修正”，否则会重复/漏掉职位。
    // v1.10.12：区间模式优先按启动时快照的职位 key 过滤，不再依赖实时下标；
    // BOSS 返回列表后已沟通职位被移除、下标整体前移，也不会处理到区间外职位。
    const rangeKeys = state.scanRangeKeys;
    for (let i = 0; i < cards.length; i++) {
      const key = getJobKey(cards[i]);
      if (rangeKeys && rangeKeys.size) {
        let inRange = rangeKeys.has(key);
        // BOSS 链接常带易变的 lid/securityId 参数；快照按 pathname 保存，
        // 这里同时按 pathname 命中，跨页后参数变化也不会丢失目标。
        if (!inRange && platform.key === 'boss') {
          const path = toPathname(key);
          if (path && rangeKeys.has(path)) inRange = true;
        }
        if (!inRange) continue;
      } else if (range && (i < range.start || i > range.end)) continue;
      if (!isCardProcessed(key)) {
        return { card: cards[i], key: key, index: i, total: cards.length };
      }
    }
    return null;
  }

  function findNextCard() {
    const entry = findNextCardEntry();
    return entry ? entry.card : null;
  }

  function findDetailRoot() {
    if (!platform._detailPaths) {
      platform._detailPaths = (platform.detailXPaths || []).concat(EXTRA_DETAIL_PATHS);
    }
    const xpathDetail = findXPathNode(platform._detailPaths, null, isVisible);
    if (xpathDetail) return xpathDetail;

    for (let i = 0; i < (platform.detailSelectors || []).length; i++) {
      let nodes = [];
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll(platform.detailSelectors[i]));
      } catch (err) {
        nodes = [];
      }
      const visible = nodes.filter(isVisible);
      if (visible.length) return visible[0];
    }

    // 类名混淆兜底（鱼泡类名每次刷新都会变）：详情面板头部的沟通按钮区
    // （免费聊/聊一聊/继续聊/拨打电话）位置稳定，以文字锚定按钮后向上爬，
    // 取第一个宽度不小于视口 35%、高度不小于 120px 的可见祖先作为详情根。
    // 爬升从内向外，先命中的是详情栏（约半屏宽），不会一路爬到整页容器。
    const anchorTexts = platform.detailAnchorTexts || [];
    for (let i = 0; i < anchorTexts.length; i++) {
      let node = null;
      try {
        node = findXPathNode(
          ['//*[normalize-space(text())="' + anchorTexts[i] + '"]'],
          null, isVisible);
      } catch (err) {
        node = null;
      }
      if (!node) continue;
      let cur = node.closest('a, button, [role="button"]') || node;
      while (cur && cur !== document.body) {
        let box = null;
        try {
          box = cur.getBoundingClientRect();
        } catch (err) {
          box = null;
        }
        if (box && box.width >= window.innerWidth * 0.35 && box.height >= 120) return cur;
        cur = cur.parentElement;
      }
    }
    return null;
  }

  // v1.10：详情切换校验专用容器：优先“大盘”详情（含职位标题），
  // 找不到再退回操作区/锚点爬升结果。旧版智联把操作按钮条当成详情根，
  // 校验时找不到标题，永远保守放行，卡片没切换也发现不了。
  function findDetailPanelRoot() {
    const paths = platform.detailPanelXPaths || [];
    if (paths.length) {
      const node = findXPathNode(paths, null, isVisible);
      if (node) return node;
    }
    const selectors = platform.detailPanelSelectors || [];
    for (let i = 0; i < selectors.length; i++) {
      let nodes = [];
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll(selectors[i]));
      } catch (err) {
        nodes = [];
      }
      const visible = nodes.filter(isVisible);
      if (visible.length) return visible[0];
    }
    return findDetailRoot();
  }

  function actionPreference(el) {
    const text = norm(el && el.textContent);
    const preferred = platform.preferredActionNorms;
    for (let i = 0; i < preferred.length; i++) {
      if (text.indexOf(preferred[i]) !== -1) return i;
    }
    return 100;
  }

  function isForbiddenActionText(el) {
    const text = norm(el && el.textContent);
    if (!text) return false;
    return FORBIDDEN_ACTION_NORMS.some(function (word) {
      return text.indexOf(word) !== -1;
    });
  }

  // 已沟通状态文字：只认短文本（徽标/按钮），避免把职位描述里的“沟通”当状态。
  function isCommunicatedText(text) {
    const value = norm(text);
    if (!value || value.length > 12) return false;
    return platform.communicatedNorms.some(function (item) {
      return value.indexOf(item) !== -1;
    });
  }

  // 卡片上的“已沟通/继续沟通”状态：点击卡片前就能判定，避免多余点击。
  function hasCommunicatedMarker(card) {
    if (!card) return false;
    let nodes = [];
    try {
      // 徽标通常是短文本叶子节点：只扫描标签/徽标类元素，
      // 不再遍历卡片里的全部 div/p/a（旧实现每张卡最多 80 个节点 + 逐个布局读取）。
      nodes = card.querySelectorAll(
        'span, em, i, b, label, [class*="tag"], [class*="badge"], [class*="status"], [class*="state"], [class*="tip"]'
      );
    } catch (err) {
      nodes = [];
    }
    const count = Math.min(nodes.length, 50);
    for (let i = 0; i < count; i++) {
      const node = nodes[i];
      if (!isRendered(node) || isInPanel(node)) continue;
      const text = norm(node.textContent);
      if (text && text.length <= 12 && isCommunicatedText(text)) return true;
    }
    return false;
  }

  // v1.10：文字 XPath 常命中内层 span/div，需向上找到真正挂了点击处理函数的节点。
  function resolveActionClickable(node) {
    if (!node) return null;
    let semantic = node.closest ? node.closest('a, button, [role="button"]') : null;
    let cur = node;
    for (let level = 0; level < 5 && cur && cur !== document.body; level++) {
      let hasHandler = false;
      try {
        const props = reactFindProps(cur);
        if (props) {
          hasHandler = ['onPointerDown', 'onMouseDown', 'onMouseUp', 'onClick'].some(function (name) {
            return typeof props[name] === 'function';
          });
        }
        if (!hasHandler && cur.__vueParentComponent) {
          const vprops = cur.__vueParentComponent.vnode && cur.__vueParentComponent.vnode.props;
          hasHandler = !!vprops && ['onPointerdown', 'onMousedown', 'onMouseup', 'onClick', 'onPointerDown'].some(function (name) {
            return typeof vprops[name] === 'function';
          });
        }
      } catch (err) {
        hasHandler = false;
      }
      if (hasHandler) return cur;
      if (!semantic && cur.matches && cur.matches('a, button, [role="button"]')) semantic = cur;
      cur = cur.parentElement;
    }
    return semantic || node;
  }

  function actionOpened() {
    if (platform.key === 'boss' && isBossChatPage()) return true;
    return !!(findChatPanel() || findSuccessModal());
  }

  // 沟通按钮点击无效时的组件直调兜底（BOSS 的 isTrusted 门禁 / 智联的 Vue 组件）。
  async function invokeActionFallback(target) {
    if (!platform.frameworkInvoke) return false;
    const resolved = resolveActionClickable(target) || target;
    log('合成点击未生效，尝试组件直调兜底', 'warn');
    try {
      reactInvokeClick(resolved, 6, true);
    } catch (err) {}
    if (await waitFor(function () { return actionOpened() ? true : null; }, 1600, 220)) return true;
    // v1.10.2：React/Vue 组件键探测不到时（智联实测），改走 _vei 调用器表与
    // Vue 2/3 组件 vnode 树直调，伪造事件同样绕过事件系统与门禁。
    try {
      vueInvokeDirect(resolved, 6, true);
    } catch (err) {}
    if (await waitFor(function () { return actionOpened() ? true : null; }, 1600, 220)) return true;
    try {
      reactInvokeClickFiber(resolved, 16);
    } catch (err) {}
    return !!(await waitFor(function () { return actionOpened() ? true : null; }, 1800, 220));
  }

  async function waitDetailSwitch(card, timeoutMs, detailPanel, identity) {
    const started = Date.now();
    let panel = detailPanel && detailPanel.isConnected ? detailPanel : null;
    // 卡片标题/链接只提取一次，轮询期间复用，避免每次 180ms 都重新查询 DOM。
    const cardIdentity = identity || buildCardIdentity(card);
    while (Date.now() - started < timeoutMs) {
      if (state.stopRequested) return false;
      if (detailMatchesJob(card, panel, cardIdentity)) return true;
      if (!panel || !panel.isConnected) panel = findDetailPanelRoot();
      await delay(180);
    }
    return detailMatchesJob(card, panel, cardIdentity);
  }

  function buildCardClickTargets(card) {
    const targets = [];
    const seen = new Set();
    function add(el) {
      if (!el || seen.has(el) || !isRendered(el)) return;
      seen.add(el);
      targets.push(el);
    }
    const selectors = platform.cardClickTargets || [];
    for (let i = 0; i < selectors.length; i++) {
      let node = null;
      try {
        node = card.querySelector(selectors[i]);
      } catch (err) {
        node = null;
      }
      add(node);
    }
    // 标题链接兜底：标题文字本身也可能是点击目标。
    for (let i = 0; i < platform.titleSelectors.length; i++) {
      let node = null;
      try {
        node = card.querySelector(platform.titleSelectors[i]);
      } catch (err) {
        node = null;
      }
      if (node) add(node.tagName === 'A' ? node : (node.closest('a') || node));
    }
    add(card);
    return targets;
  }

  function findActionButton(card) {
    const roots = [card];
    if (platform.actionScope === 'detail' || platform.actionScope === 'cardThenDetail') {
      const detail = findDetailRoot();
      if (detail && !card.contains(detail) && !detail.contains(card)) roots.push(detail);
      // 智联详情面板是全局区域，始终允许文档级查找；其他平台（鱼泡）
      // 仅在详情根节点可识别时才文档级查找，避免详情未识别时把页面
      // 其他位置残留的「继续聊」当成当前职位的沟通按钮。
      if (platform.actionScope === 'detail' && (platform.key === 'zhaopin' || detail)) {
        roots.push(document);
      }
    }

    // XPath 优先：按平台配置的文字顺序命中，命中后上溯到真正可点击的节点。
    for (let r = 0; r < roots.length; r++) {
      const node = findXPathNode(platform.actionXPaths, roots[r], function (el) {
        return isRendered(el) && !isInPanel(el) && !isDisabled(el) &&
          !isForbiddenActionText(el) && matchesActionText(el);
      });
      if (node) return resolveActionClickable(node);
    }

    // CSS/文字兜底：按偏好排序。
    const candidates = [];
    const seen = new Set();
    for (let r = 0; r < roots.length; r++) {
      const list = collectActionCandidates(roots[r]);
      for (let i = 0; i < list.length; i++) {
        if (!seen.has(list[i]) && isRendered(list[i]) && !isDisabled(list[i])) {
          seen.add(list[i]);
          candidates.push(list[i]);
        }
      }
    }

    // 偏好值只算一次：旧版比较函数会在 O(n log n) 次比较中反复归一化文本。
    const ranked = candidates.map(function (el) {
      return { el: el, pref: actionPreference(el) };
    });
    ranked.sort(function (a, b) {
      return a.pref - b.pref;
    });
    // v1.10：过滤投递/申请类候选，避免偏好排序把「立即投递」当成沟通按钮。
    for (let i = 0; i < ranked.length; i++) {
      if (!isForbiddenActionText(ranked[i].el)) return ranked[i].el;
    }
    return null;
  }

  async function activateCard(card) {
    try {
      card.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (err) {
      try {
        card.scrollIntoView();
      } catch (ignore) {}
    }
    // 鱼泡类名单片加载较慢，先短暂停留；其他平台保持原节奏。
    await delay(platform.key === 'yupao' ? randInt(80, 160) : randInt(200, 380));
    humanHover(card);
    if (!platform.clickCardFirst) return true;

    const detailPanel = findDetailPanelRoot();
    const canVerify = !!detailPanel;
    // 标题/链接特征只提取一次，供本轮所有点击目标与轮询复用。
    const identity = canVerify ? buildCardIdentity(card) : null;
    const targets = buildCardClickTargets(card);
    const verifyTimeout = platform.key === 'yupao' ? 900 : 1400;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      humanHover(target);
      await delay(randInt(60, 130));
      // v1.10.3：原生 .click() 优先（智联实测可穿透门禁），未中再走 dispatchEvent。
      nativeClick(target);
      if (!canVerify) return true;
      if (await waitDetailSwitch(card, verifyTimeout, detailPanel, identity)) return true;
      safeClick(target);
      if (!canVerify) return true;
      // 轮询等待详情切换：一旦切换立即返回，避免固定等待 1.1~1.8 秒。
      // 未切换则继续尝试下一个点击目标（内层节点 → 标题 → 卡片根）。
      if (await waitDetailSwitch(card, verifyTimeout, detailPanel, identity)) return true;
    }
    // 全部目标都点过仍未切换，交给 ensureDetailSwitched 的重试梯子。
    return false;
  }

  // =========================================================================
  // 详情面板切换校验（clickCardFirst 平台：鱼泡 / 智联 / BOSS）
  // 点击卡片后，右侧详情面板必须已切到当前职位，否则读到的是上一个职位
  // 残留的按钮，会把新职位误判为「已沟通过」（典型现象：整个列表全部被跳过）。
  // 判定特征提取不到时保守放行，保持原有行为不受影响。
  // =========================================================================
  function getCardHref(root) {
    if (!root) return '';
    if (root.tagName === 'A') {
      const self = (root.getAttribute('href') || '').trim();
      if (self && self !== '#' && !/^javascript:/i.test(self)) return self;
    }
    for (let i = 0; i < platform.titleSelectors.length; i++) {
      let node = null;
      try {
        node = root.querySelector(platform.titleSelectors[i]);
      } catch (err) {
        node = null;
      }
      if (node && node.tagName === 'A') {
        const href = (node.getAttribute('href') || '').trim();
        if (href && href !== '#' && !/^javascript:/i.test(href)) return href;
      }
    }
    return '';
  }

  function toPathname(href) {
    if (!href) return '';
    const trimmed = String(href).trim();
    if (!trimmed || trimmed === '#' || /^javascript:/i.test(trimmed)) return '';
    try {
      return new URL(trimmed, location.href).pathname;
    } catch (err) {
      return trimmed.split('?')[0];
    }
  }

  function buildCardIdentity(card) {
    return {
      path: toPathname(getCardHref(card)),
      title: norm(getJobTitle(card))
    };
  }

  function detailMatchesJob(card, detailPanel, identity) {
    // v1.10：校验用“大盘”详情容器，而不是操作按钮条。
    // detailPanel / identity 由调用方在本次职位处理中复用，避免每次轮询重复查询。
    let detail = detailPanel;
    if (detail && (!detail.isConnected || !isVisible(detail))) detail = null;
    if (!detail) detail = findDetailPanelRoot();
    // 详情本就在卡片内部：不存在「切换」概念，视为已切换。
    if (detail && detail.contains(card)) return true;
    // 找不到详情面板：从严按「未切换」处理，走重试与如实跳过。
    // v1.4.0 及之前此处直接放行，导致非标准列表页（如鱼泡专题页）
    // 校验形同虚设，拿残留按钮把整列表误判成「已沟通过」。
    if (!detail) return false;

    // 链接比对：只认详情头部区域（顶部 320px 内）的职位链接。
    // v1.4.0 及之前扫描整个详情容器，底部「相似职位」推荐位里
    // 常有同批搜索结果的链接，未切换详情也会被误判为「已切换」。
    let detailTop = 0;
    try {
      detailTop = detail.getBoundingClientRect().top;
    } catch (err) {
      detailTop = 0;
    }
    function inHeaderRegion(node) {
      try {
        const box = node.getBoundingClientRect();
        return box && box.top - detailTop <= 320;
      } catch (err) {
        return false;
      }
    }
    const cardPath = identity ? identity.path : toPathname(getCardHref(card));
    if (cardPath) {
      let anchors = [];
      try {
        anchors = detail.querySelectorAll('a[href]');
      } catch (err) {
        anchors = [];
      }
      // 详情底部推荐位可能带大量链接；只检查前 80 个，避免异常页面长循环。
      const anchorCount = Math.min(anchors.length, 80);
      for (let i = 0; i < anchorCount; i++) {
        if (inHeaderRegion(anchors[i]) &&
          toPathname(anchors[i].getAttribute('href') || '') === cardPath) return true;
      }
    }

    // 标题全文比对已删除：详情底部推荐位的标题文本会顶替真切换。

    // 标题候选比对：只认详情顶部区域（头部职位名），排除底部推荐位；
    // 提取不到任何头部标题时保守放行，保持原行为。
    // v1.5.0 重构时误删了 cardTitle 声明，v1.8.0 加入 h1 后头部比对首次执行即
    // ReferenceError（node --check 只查语法、不查未声明引用），v1.8.2 恢复声明。
    const cardTitle = identity ? identity.title : norm(getJobTitle(card));
    let sawHeaderTitle = false;
    for (let s = 0; s < platform.titleSelectors.length; s++) {
      let nodes = [];
      try {
        nodes = detail.querySelectorAll(platform.titleSelectors[s]);
      } catch (err) {
        nodes = [];
      }
      for (let i = 0; i < nodes.length && i < 5; i++) {
        let box = null;
        try {
          box = nodes[i].getBoundingClientRect();
        } catch (err) {
          box = null;
        }
        if (!box || box.top - detailTop > 320) continue; // 只看头部区域
        const t = norm(nodes[i].textContent);
        if (!t || t.length < 6) continue;
        sawHeaderTitle = true;
        if (cardTitle && cardTitle.length >= 6 &&
          (t.indexOf(cardTitle) !== -1 || cardTitle.indexOf(t) !== -1)) {
          return true;
        }
      }
    }
    if (sawHeaderTitle && cardTitle && cardTitle.length >= 6) return false;
    // 特征不足，无法判断：放行，保持原行为。
    return true;
  }

  async function ensureDetailSwitched(card) {
    if (!platform.clickCardFirst) return true;
    // v1.10：三平台都做详情切换校验（原先只有带直调兜底的平台才校验，
    // 智联被整段跳过，卡片点击失效时会拿上一个职位的按钮做判断）。
    if (!platform.verifyDetailSwitch) return true;
    let detailPanel = findDetailPanelRoot();
    if (!detailPanel && !state.detailRootWarned) {
      state.detailRootWarned = true;
      log('未识别到右侧详情面板（当前页面可能不是标准职位列表页），切换校验从严执行', 'warn');
    }
    const identity = buildCardIdentity(card);
    if (detailMatchesJob(card, detailPanel, identity)) return true;

    // activateCard 已点过一轮但可能仍在渲染：先轮询等待一小段时间再重试。
    if (await waitDetailSwitch(card, 600, detailPanel, identity)) return true;

    // 点击未生效：换目标重试——先重复点击卡片标题链接，再点卡片根节点。
    let titleLink = null;
    for (let s = 0; s < platform.titleSelectors.length && !titleLink; s++) {
      try {
        const node = card.querySelector(platform.titleSelectors[s]);
        if (node && node.tagName === 'A' && isRendered(node)) titleLink = node;
      } catch (err) {}
    }
    const retries = [
      function () {
        // v1.10.3：原生 .click() 优先（智联通路实测有效）。
        humanHover(card);
        nativeClick(titleLink || card);
      },
      function () {
        humanHover(card);
        safeClick(titleLink || card);
      },
      function () {
        humanHover(card);
        nativeClick(card);
      },
      function () {
        humanHover(card);
        safeClick(card);
      }
    ];
    // 只有确实存在组件绑定键时才追加 6 次直调重试；纯原生事件页面
    // 直调必然空转，跳过可省下 6 × (1~2.2 秒) 的无效等待。
    const frameworkBindings = platform.frameworkInvoke &&
      hasFrameworkBinding(titleLink || card, 8, true);
    if (frameworkBindings) {
      retries.push(
        function () {
          // v1.10.2：先走 Vue _vei 调用器表直调（智联通路，组件键探测不到时唯一可用）。
          return vueInvokeDirect(titleLink || card, 3, false);
        },
        function () {
          // 合成事件被站点丢弃时，直接调用 React/Vue 处理函数。
          return reactInvokeClick(titleLink || card, 4);
        },
        function () {
          return reactInvokeClick(card, 8, true);
        },
        function () {
          // v1.10.2：Vue 三通道深扫（含子级 40 个内层节点）。
          return vueInvokeDirect(card, 6, true);
        },
        function () {
          // 组件树兜底：沿 fiber.return 找声明在包装组件/上层容器上的处理函数。
          return reactInvokeClickFiber(titleLink || card, 16);
        },
        function () {
          return reactInvokeClickFiber(card, 16);
        }
      );
    }
    let frameworkInvoked = false;
    const stepDelay = platform.key === 'yupao' ? 650 : 1000;
    for (let i = 0; i < retries.length; i++) {
      await delay(randInt(stepDelay, stepDelay + 350));
      try {
        if (retries[i]() === true) frameworkInvoked = true;
      } catch (err) {}
      // 轮询确认，命中即返回；不再固定叠加 1.4~2 秒等待（鱼泡切换慢的主因之一）。
      if (await waitDetailSwitch(card, platform.key === 'yupao' ? 1200 : 1800, detailPanel, identity)) return true;
    }
    if (!frameworkInvoked) {
      if (!frameworkBindings && platform.frameworkInvoke) {
        log('未发现可直调的组件绑定，已跳过 6 次组件直调重试（页面可能使用原生事件绑定）', 'warn');
      } else if (lastFiberHandlerScan.length) {
        log('直调兜底无效：组件树上发现处理函数（' + lastFiberHandlerScan.join('、') +
          '）但调用后详情仍未切换', 'warn');
      } else {
        log('直调兜底无效：卡片 DOM 链与组件树上均未发现 React 处理函数，站点可能改用原生事件绑定', 'warn');
      }
    }
    return false;
  }

  async function tryLoadMore() {
    const cards = collectCards();
    if (cards.length) {
      try {
        cards[cards.length - 1].scrollIntoView({ block: 'end' });
      } catch (err) {}
    }
    try {
      window.scrollTo(0, document.documentElement.scrollHeight);
    } catch (err) {}
    await delay(1400);
    const moreButton = findClickableByText(document, ['加载更多', '加载更多职位', '查看更多职位', '查看更多'], { partial: false });
    if (moreButton && isRendered(moreButton)) {
      safeClick(moreButton);
      await delay(1400);
    }
    return !!findNextCard();
  }

  // =========================================================================
  // 聊天窗口定位
  // =========================================================================
  // 输入框 + 发送按钮同时存在计 2 分；只命中一类计 1 分。
  function chatPanelScore(node) {
    if (!node) return 0;
    try {
      const hasEditor = !!node.querySelector(
        'textarea, [contenteditable="true"], [contenteditable="plaintext-only"], input[type="text"]'
      );
      let hasSend = false;
      for (let i = 0; i < platform.sendButtonSelectors.length; i++) {
        try {
          if (node.querySelector(platform.sendButtonSelectors[i])) {
            hasSend = true;
            break;
          }
        } catch (err) {}
      }
      if (!hasSend) {
        hasSend = !!findXPathNode(platform.sendXPaths, node, isRendered);
      }
      return (hasEditor ? 1 : 0) + (hasSend ? 1 : 0);
    } catch (err) {
      return 0;
    }
  }

  function findChatPanel() {
    // 聊天抽屉打开后 waitForChat 每 250ms 轮询一次；缓存命中时只做一次
    // 连通性/可见性/结构复核，避免重复执行全部 XPath + CSS 选择器。
    if (cachedChatPanel &&
      cachedChatPanel.isConnected &&
      isVisible(cachedChatPanel) &&
      chatPanelScore(cachedChatPanel) >= 2) {
      return cachedChatPanel;
    }
    cachedChatPanel = null;

    // 快速路径：按平台配置顺序找第一个同时包含输入框和发送按钮的可见容器。
    // 命中即返回，不再收集全部候选并逐个打分（成功路径通常都走这里）。
    for (let i = 0; i < platform.panelSelectors.length; i++) {
      let list = [];
      try {
        list = document.querySelectorAll(platform.panelSelectors[i]);
      } catch (err) {
        list = [];
      }
      for (let n = 0; n < list.length; n++) {
        const node = list[n];
        if (!isVisible(node) || isInPanel(node)) continue;
        if (chatPanelScore(node) >= 2) {
          cachedChatPanel = node;
          return node;
        }
      }
    }

    const nodes = [];
    const seen = new Set();

    function addNode(node) {
      if (!node || seen.has(node) || !isVisible(node) || isInPanel(node)) return;
      seen.add(node);
      nodes.push(node);
    }

    // XPath 主定位
    findXPathNodes(platform.panelXPaths, null, isVisible).forEach(addNode);

    // CSS 兜底
    for (let i = 0; i < platform.panelSelectors.length; i++) {
      let list = [];
      try {
        list = Array.prototype.slice.call(document.querySelectorAll(platform.panelSelectors[i]));
      } catch (err) {
        list = [];
      }
      list.forEach(addNode);
    }

    // 通用兜底：从“发送”按钮向上找包含输入框的可见容器，
    // 适配鱼泡“免费聊”侧边栏等没有稳定 class 的聊天界面。
    const sendNodes = findXPathNodes(platform.sendXPaths, null, isRendered);
    sendNodes.forEach(function (send) {
      let node = send.parentElement;
      for (let depth = 0; depth < 8 && node && node !== document.body; depth++) {
        try {
          const rect = node.getBoundingClientRect();
          const hasEditor = !!node.querySelector(
            'textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'
          );
          if (rect.width >= 260 && rect.height >= 100 && hasEditor) {
            addNode(node);
            break;
          }
        } catch (err) {}
        node = node.parentElement;
      }
    });

    if (!nodes.length) return null;

    let best = null;
    let bestScore = -1;
    nodes.forEach(function (node) {
      const score = chatPanelScore(node);
      if (!score) return;
      if (!best || score > bestScore || (score === bestScore && best.contains(node))) {
        best = node;
        bestScore = score;
      }
    });
    if (best) cachedChatPanel = best;
    return best || nodes[0];
  }

  function findChatInput(panel, beforeEditors) {
    const scopes = [];
    if (panel) scopes.push(panel);

    for (let s = 0; s < scopes.length; s++) {
      const scope = scopes[s];
      const xpathInput = findXPathNode(platform.inputXPaths, scope, function (el) {
        return isVisible(el) && !isDisabled(el) && !isNoiseInput(el);
      });
      if (xpathInput) return xpathInput;

      for (let i = 0; i < platform.inputSelectors.length; i++) {
        let nodes = [];
        try {
          nodes = Array.prototype.slice.call(scope.querySelectorAll(platform.inputSelectors[i]));
        } catch (err) {
          nodes = [];
        }
        for (let n = 0; n < nodes.length; n++) {
          const el = nodes[n];
          if (isVisible(el) && !isDisabled(el) && !isNoiseInput(el)) return el;
        }
      }
      let generic = [];
      try {
        generic = Array.prototype.slice.call(scope.querySelectorAll(
          'textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], input[type="text"]'
        ));
      } catch (err) {
        generic = [];
      }
      for (let n = 0; n < generic.length; n++) {
        const el = generic[n];
        if (isVisible(el) && !isDisabled(el) && !isNoiseInput(el)) return el;
      }
    }

    // 点击之后新出现的输入框，适用于平台改版或弹窗 class 变化。
    // 必须过滤噪声输入：鱼泡消息面板顶部的「搜索联系人」也是新出现的输入框，
    // 不加过滤会把话术写进搜索框，聊天编辑器反而没人管。
    const editors = collectEditors();
    for (let i = 0; i < editors.length; i++) {
      const el = editors[i];
      if (!beforeEditors.has(el) && !isDisabled(el) && !isNoiseInput(el)) return el;
    }

    // 最后再尝试平台配置中的全局 XPath / CSS 输入框。
    const globalXPathInput = findXPathNode(platform.inputXPaths, null, function (el) {
      return isVisible(el) && !isDisabled(el) && !isNoiseInput(el);
    });
    if (globalXPathInput) return globalXPathInput;

    for (let i = 0; i < platform.inputSelectors.length; i++) {
      let nodes = [];
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll(platform.inputSelectors[i]));
      } catch (err) {
        nodes = [];
      }
      for (let n = 0; n < nodes.length; n++) {
        const el = nodes[n];
        if (isVisible(el) && !isDisabled(el) && !isNoiseInput(el)) return el;
      }
    }
    return null;
  }

  function findSuccessModal() {
    const xpathNodes = findXPathNodes(platform.successXPaths, null, isVisible);
    for (let i = 0; i < xpathNodes.length; i++) {
      const text = norm(xpathNodes[i].textContent);
      if (platform.successTextNorms.some(function (item) {
        return text.indexOf(item) !== -1;
      })) {
        return xpathNodes[i];
      }
    }

    for (let i = 0; i < (platform.successSelectors || []).length; i++) {
      let nodes = [];
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll(platform.successSelectors[i]));
      } catch (err) {
        nodes = [];
      }
      for (let n = 0; n < nodes.length; n++) {
        const node = nodes[n];
        if (!isVisible(node)) continue;
        const text = norm(node.textContent);
        if (platform.successTextNorms.some(function (item) {
          return text.indexOf(item) !== -1;
        })) {
          return node;
        }
      }
    }
    // v1.10.12：智联新版结果弹窗 class 不稳定（实测已不再出现
    // .deliver-greeting-modal），按「留在此页」按钮 + 结果文案做文字级兜底。
    if (platform.key === 'zhaopin') {
      const popup = findZhaopinGreetingPopup();
      if (popup) return popup;
    }
    return null;
  }

  function detectLoginUncached() {
    // 验证码登录经常放在 iframe 中，若 iframe 跨域则无法读取内部输入框。
    let iframes = [];
    try {
      iframes = Array.prototype.slice.call(document.querySelectorAll('iframe'));
    } catch (err) {
      iframes = [];
    }
    for (let i = 0; i < iframes.length; i++) {
      const frame = iframes[i];
      if (!isVisible(frame) || isInPanel(frame)) continue;
      const source = (frame.getAttribute('src') || '') + ' ' + (frame.getAttribute('title') || '');
      if (/login|passport|verify|captcha|登录|验证/i.test(source)) return frame;
    }

    for (let i = 0; i < platform.loginSelectors.length; i++) {
      let nodes = [];
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll(platform.loginSelectors[i]));
      } catch (err) {
        nodes = [];
      }
      for (let n = 0; n < nodes.length; n++) {
        const node = nodes[n];
        if (!isVisible(node) || isInPanel(node)) continue;
        const text = norm(node.textContent);
        const hasCredentialInput = !!node.querySelector(
          'input[type="tel"], input[placeholder*="手机"], input[placeholder*="验证码"], input[placeholder*="账号"], input[placeholder*="密码"]'
        );
        if (hasCredentialInput && (text.indexOf('登录') !== -1 || text.indexOf('注册') !== -1 || text.indexOf('验证') !== -1)) {
          return node;
        }
        if (text.indexOf('登录') !== -1 &&
          (text.indexOf('注册') !== -1 || text.indexOf('验证码') !== -1 || hasCredentialInput) &&
          text.length <= 80) {
          return node;
        }
      }
    }

    const modalSelectors = '[role="dialog"], .modal, [class*="dialog"], [class*="modal"], [class*="popup"], [class*="layer"], .a-modal, .el-dialog, .ant-modal, .layui-layer, .dialog-wrap, .boss-login-dialog';
    let modals = [];
    try {
      modals = Array.prototype.slice.call(document.querySelectorAll(modalSelectors));
    } catch (err) {
      modals = [];
    }
    for (let i = 0; i < modals.length; i++) {
      const node = modals[i];
      if (!isVisible(node) || isInPanel(node)) continue;
      const text = norm(node.textContent);
      const hasCredentialInput = !!node.querySelector(
        'input[type="tel"], input[placeholder*="手机"], input[placeholder*="验证码"], input[placeholder*="密码"]'
      );
      if (hasCredentialInput && (text.indexOf('登录') !== -1 || text.indexOf('注册') !== -1 || text.indexOf('验证') !== -1)) {
        return node;
      }
      if (text.indexOf('登录') !== -1 && text.indexOf('注册') !== -1 && text.length <= 80) {
        return node;
      }
    }

    // 部分平台使用无固定 class 的验证码悬浮层，通过“手机/验证码输入框 + 登录文案”反推。
    let credentialInputs = [];
    try {
      credentialInputs = Array.prototype.slice.call(document.querySelectorAll(
        'input[type="tel"], input[placeholder*="手机"], input[placeholder*="验证码"], input[placeholder*="密码"]'
      ));
    } catch (err) {
      credentialInputs = [];
    }
    for (let i = 0; i < credentialInputs.length; i++) {
      const input = credentialInputs[i];
      if (!isVisible(input) || isInPanel(input)) continue;
      let node = input.parentElement;
      for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
        const text = norm(node.textContent);
        if (text.length <= 200 && (text.indexOf('登录') !== -1 || text.indexOf('注册') !== -1 || text.indexOf('验证') !== -1)) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  // waitForChat 每 250ms 轮询：未检测到登录时缓存 600ms，把每轮 10+ 次 DOM 扫描降频；
  // 检测到登录节点时不缓存，确保登录完成/浮层关闭后下一轮能立即恢复。
  function detectLogin() {
    const now = Date.now();
    if (now - loginCheckCache.time < 600) return loginCheckCache.result;
    const result = detectLoginUncached();
    // 只缓存“未检测到登录”的结果：登录浮层出现后必须能被下一轮立即发现，
    // 不能把登录节点缓存 600ms，否则用户刚登录完成时可能误判为仍需登录。
    loginCheckCache = result
      ? { time: 0, result: null }
      : { time: Date.now(), result: null };
    return result;
  }

  function detectRateLimit() {
    let nodes = [];
    try {
      nodes = Array.prototype.slice.call(document.querySelectorAll(
        '[class*="toast"], [class*="tip"], [class*="alert"], [class*="notice"]'
      ));
    } catch (err) {
      nodes = [];
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!isVisible(node) || isInPanel(node)) continue;
      const text = norm(node.textContent);
      if (!text || text.length > 60) continue;
      if (/操作.{0,4}频繁|请求.{0,4}频繁|沟通人数.{0,8}上限|今日.{0,8}上限|请稍后再试/.test(text)) return node;
    }
    return null;
  }

  async function waitForChat(beforeEditors, timeoutMs) {
    const started = Date.now();
    let lastPanel = null;
    while (Date.now() - started < timeoutMs) {
      if (state.stopRequested) throw makeError('STOPPED', '任务已停止');

      const login = detectLogin();
      if (login) return { type: 'login', panel: login };

      const success = findSuccessModal();
      if (success) return { type: 'success', panel: success };

      const panel = findChatPanel();
      if (panel) lastPanel = panel;
      const input = findChatInput(panel, beforeEditors);
      if (input) {
        return { type: 'chat', input: input, panel: panel || closestEditorContainer(input) };
      }
      await delay(250);
    }

    const login = detectLogin();
    if (login) return { type: 'login', panel: login };
    const success = findSuccessModal();
    if (success) return { type: 'success', panel: success };
    return { type: 'none', panel: lastPanel };
  }

  function closestEditorContainer(input) {
    try {
      return input.closest('form, [class*="chat"], [class*="editor"], [class*="dialog"], [class*="modal"], [class*="panel"]');
    } catch (err) {
      return null;
    }
  }

  function findSendButton(panel, input, allowDisabled) {
    const scopes = [];
    if (panel) scopes.push(panel);
    const nearInput = input ? closestEditorContainer(input) : null;
    if (nearInput && scopes.indexOf(nearInput) === -1) scopes.push(nearInput);

    for (let s = 0; s < scopes.length; s++) {
      const scope = scopes[s];
      const xpathSend = findXPathNode(platform.sendXPaths, scope, function (el) {
        return isRendered(el) && !isInPanel(el) && (allowDisabled || !isDisabled(el));
      });
      if (xpathSend) return xpathSend.closest('a, button, [role="button"]') || xpathSend;

      for (let i = 0; i < platform.sendButtonSelectors.length; i++) {
        let nodes = [];
        try {
          nodes = Array.prototype.slice.call(scope.querySelectorAll(platform.sendButtonSelectors[i]));
        } catch (err) {
          nodes = [];
        }
        for (let n = 0; n < nodes.length; n++) {
          const el = nodes[n];
          if (!isRendered(el) || isInPanel(el)) continue;
          if (!allowDisabled && isDisabled(el)) continue;
          // 类名匹配可能误中「发简历」等同前缀按钮：文字不符且非纯图标时排除。
          const text = norm(el.textContent);
          if (text && !platform.sendTextNorms.some(function (item) {
            return text.indexOf(item) !== -1;
          })) continue;
          return el.closest('a, button, [role="button"]') || el;
        }
      }
      const byText = findClickableByText(scope, platform.sendTexts, {
        partial: true,
        exclude: ['发送验证码']
      });
      if (byText) return byText;
    }

    if (panel) {
      return findClickableByText(panel, platform.sendTexts, {
        partial: true,
        exclude: ['发送验证码']
      });
    }
    return null;
  }

  function countOccurrences(haystack, needle) {
    if (!haystack || !needle) return 0;
    let count = 0;
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
      count++;
      index += needle.length;
    }
    return count;
  }

  function isSent(panel, input, greeting) {
    // v1.10.5 修正：发送确认只认「输入框已断连/不可见/已清空」。
    // 旧判据「面板文本计数 panelCount > inputCount」在固定话术下必然误判：
    // 首次发送成功后，联系人列表预览与历史气泡里全是同款话术，下一个职位
    // 刚填入输入框就会被判成已发送，clickSend 提前返回、React 直调兜底
    // 永不触发——v1.10.4 鱼泡「填入后发不出去」的根因。三平台发送成功后
    // 都会清空输入框，这才是唯一可靠的信号。
    if (!input || !input.isConnected || !isVisible(input)) return true;
    return norm(getEditorText(input)).length === 0;
  }

  // v1.10.5：平台代发检测——会话面板里是否已有同款话术（鱼泡点「免费聊」
  // 后平台可能自动发出招呼语）。配合编排层「输入框为空 + 已有同款话术 =
  // 平台已代发」的显式防护使用。
  function panelContainsGreeting(panel, greeting) {
    const snippet = norm(greeting).slice(0, 10);
    if (!snippet || !panel) return false;
    return countOccurrences(norm(panel.textContent), snippet) > 0;
  }

  // 轮询确认发送结果：成功即返回，避免固定等待 1.3~1.9 秒；
  // 也避免「点击已生效但按钮仍在 DOM」被误判为失败后重复直调发送。
  async function waitSent(panel, input, greeting, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (isSent(panel, input, greeting)) return true;
      await delay(180);
    }
    return isSent(panel, input, greeting);
  }

  // =========================================================================
  // 鱼泡聊天窗适配（v1.10.6）
  // 现象：点击「免费聊」弹出右侧聊天抽屉后，脚本已把预设文本写入编辑器，
  // 但发送按钮仍保持灰色不可用（站点未收到能驱动按钮状态的输入事件）。
  // 处理：先补发输入事件并同步组件 onChange；仍为灰色时直接解除禁用标记，
  // 让原有点击发送链路继续工作。整段逻辑仅对鱼泡生效。
  // =========================================================================
  function nudgeYupaoEditor(input) {
    if (!input) return;
    const text = getEditorText(input);
    dispatchInput(input, text);
    // 编辑器可能是受控组件：事件与状态同步函数可能挂在自身或祖先节点上。
    let node = input;
    for (let level = 0; level < 4 && node && node !== document.body; level++) {
      const props = reactFindProps(node);
      if (props && typeof props.onChange === 'function') {
        const fake = makeFakeEvent(node, 'input');
        try {
          fake.target = Object.create(input, {
            value: { value: text, writable: true, configurable: true }
          });
        } catch (err) {}
        try {
          props.onChange.call(node, fake);
        } catch (err) {}
      }
      node = node.parentElement;
    }
  }

  function releaseYupaoSendButton(button) {
    if (!button) return;
    try { button.disabled = false; } catch (err) {}
    try { button.removeAttribute('disabled'); } catch (err) {}
    try { button.setAttribute('aria-disabled', 'false'); } catch (err) {}
    try {
      button.classList.remove('disabled', 'is-disabled', 'btn-disabled', 'ant-btn-disabled');
    } catch (err) {}
    // 部分按钮用 pointer-events:none 实现灰色不可点，恢复可点击。
    try { button.style.pointerEvents = 'auto'; } catch (err) {}
  }

  // =========================================================================
  // 鱼泡输入同步增强（v1.10.13）
  // 现象：文字已出现在编辑器里，但右下角计数器仍是 0/300，发送按钮灰色/点击
  // 无反应。根因是文本只写进了 DOM，没有进入平台组件状态：
  //   1) .fb-editor 可能只是外层容器，直接 innerHTML 会覆盖内部真实编辑器；
  //   2) 平台只监听自身输入事件，普通合成 input 被忽略；
  //   3) 字数统计/按钮可用态由 keyup 等事件驱动，旧版没有补发。
  // 处理：先解析真正的可编辑节点，用 execCommand 走浏览器编辑管线，再补发
  // beforeinput/input/change/keydown/keypress/keyup，并直调 Vue/React 输入处理器。
  // 全部逻辑独立于主流程，仅鱼泡启用，可由面板开关关闭。
  // =========================================================================
  function resolveYupaoEditable(input) {
    if (!input) return input;
    // textarea/input 本身就是真实编辑器，直接使用。
    if (isYupaoField(input)) return input;
    // 外层容器即使因继承而可编辑，也不如内部显式声明 contenteditable 的
    // 真实编辑节点可靠；优先用内部节点，避免 innerHTML 覆盖内部监听。
    // v1.10.22：鱼泡 .fb-editor 内可能同时存在隐藏 textarea（表单镜像）
    // 和可见 contenteditable。旧顺序 textarea 在前，会把话术写进隐藏节点，
    // 表现为可见编辑器仍是占位文案、计数器 0/300、发送按钮灰色。
    // 这里改为：先选可见的 contenteditable，再回退到 textarea。
    let editables = [];
    try {
      editables = input.querySelectorAll(
        '[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]'
      );
    } catch (err) {
      editables = [];
    }
    for (let i = 0; i < editables.length; i++) {
      if (isVisible(editables[i]) && !isNoiseInput(editables[i])) return editables[i];
    }
    let area = null;
    try {
      area = input.querySelector('textarea');
    } catch (err) {
      area = null;
    }
    if (area && isVisible(area) && !isNoiseInput(area)) return area;
    return input;
  }

  function yupaoInputLimit(input) {
    let limit = 300;
    try {
      const max = Number(input && input.maxLength);
      if (isFinite(max) && max > 0 && max < 1000) limit = max;
    } catch (err) {}
    return limit;
  }

  function yupaoGreetingText(greeting, input) {
    const text = String(greeting == null ? '' : greeting);
    const limit = yupaoInputLimit(input);
    return text.length > limit ? text.slice(0, limit) : text;
  }

  function isYupaoField(input) {
    return !!input && (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT');
  }

  // 清空编辑器：必须在写入前执行。部分编辑器里 execCommand 不接受选区替换，
  // 会变成“在光标处追加”，这是预设重复堆叠的直接原因。
  function clearYupaoEditor(input) {
    if (!input) return;
    if (isYupaoField(input)) {
      const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(input, '');
        else input.value = '';
      } catch (err) {
        try { input.value = ''; } catch (ignore) {}
      }
      return;
    }
    try {
      input.textContent = '';
    } catch (err) {
      try { input.innerHTML = ''; } catch (ignore) {}
    }
  }

  // v1.10.25：鱼泡编辑器按 <p data-fish-node="element" id="fb-e-element-*">
  // 维护内部节点。直接清空容器（textContent=''）或整体替换 innerHTML 会删除
  // 这些节点，组件 model 从此认不出内容，表现为“输入框有字、计数器 0/300”。
  // 写入必须复用已有段落节点，并清掉块节点之外的散落文本，避免出现两份内容。
  function yupaoFishBlock(input) {
    if (!input) return null;
    let block = null;
    try {
      block = input.querySelector('p[data-fish-node="element"]');
    } catch (err) {
      block = null;
    }
    if (!block) {
      try {
        block = document.createElement('p');
        block.setAttribute('data-fish-node', 'element');
        block.id = 'fb-e-element-' + Math.random().toString(36).slice(2, 8);
        block.appendChild(document.createElement('br'));
        input.textContent = '';
        input.appendChild(block);
      } catch (err) {
        return null;
      }
    }
    try {
      Array.prototype.slice.call(input.childNodes).forEach(function (node) {
        if (node !== block) input.removeChild(node);
      });
    } catch (err) {}
    return block;
  }

  // 精确写入目标文本（不追加）：textarea 用原生 value setter，
  // contenteditable 写入编辑器自己的段落节点，保证节点标记不丢。
  function writeYupaoExact(input, text) {
    if (!input) return;
    if (isYupaoField(input)) {
      const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(input, text);
        else input.value = text;
      } catch (err) {
        try { input.value = text; } catch (ignore) {}
      }
      return;
    }
    const block = yupaoFishBlock(input);
    if (block) {
      try {
        block.innerHTML = String(text).split('\n').map(function (line) {
          return escapeHtml(line) || '<br>';
        }).join('<br>');
        return;
      } catch (err) {}
    }
    try {
      input.innerHTML = String(text).split('\n').map(function (line) {
        return '<p>' + (escapeHtml(line) || '<br>') + '</p>';
      }).join('');
    } catch (err) {
      try { input.textContent = text; } catch (ignore) {}
    }
  }

  // 优先走浏览器自身的编辑管线：真实站点的受控组件对 execCommand 产生的
  // input 事件接受度更高。v1.10.25 起不再清空容器：先点击/聚焦编辑器，
  // 只选中段落节点内部的内容再替换，保留 data-fish-node 与节点 id。
  function insertYupaoText(input, text) {
    if (!input) return false;
    try {
      if (typeof input.click === 'function') input.click();
    } catch (err) {}
    try { input.focus(); } catch (err) {}
    if (isYupaoField(input)) {
      clearYupaoEditor(input);
      try {
        input.select();
        if (document.execCommand && document.execCommand('insertText', false, text)) {
          return norm(getEditorText(input)) === norm(text);
        }
      } catch (err) {}
      return false;
    }
    const block = yupaoFishBlock(input);
    try {
      const range = document.createRange();
      range.selectNodeContents(block || input);
      const selection = window.getSelection ? window.getSelection() : null;
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (document.execCommand && document.execCommand('insertText', false, text)) {
        return norm(getEditorText(input)) === norm(text);
      }
    } catch (err) {}
    return false;
  }

  function yupaoInputEvent(input, type, data) {
    const value = data == null ? null : String(data);
    // 部分处理器读 e.value，而不是 e.data；正常同步时也给当前完整文本。
    const currentText = value != null ? value : getEditorText(input);
    const event = makeFakeEvent(input, type, {
      target: input,
      currentTarget: input,
      // 默认 data 为空：站点若把 event.data 追加进 model，正常同步阶段传整段
      // 文本会重复堆叠；只有按钮仍禁用、确认 model 为空时才补发带 data 的事件。
      data: value,
      value: currentText,
      inputType: 'insertText'
    });
    if (value != null && event.nativeEvent) {
      // 部分 React 处理器读 e.nativeEvent.data / inputType，而不是 e.data。
      try {
        Object.defineProperty(event.nativeEvent, 'data', { value: value });
        Object.defineProperty(event.nativeEvent, 'inputType', { value: 'insertText' });
      } catch (err) {}
    }
    return event;
  }

  // 补发完整输入事件序列；keyup 用于驱动“字数统计 / 发送按钮可用态”这类
  // 只在按键结束时刷新的前端逻辑。
  function dispatchYupaoKeyEvents(input) {
    if (!input) return;
    const text = getEditorText(input);
    const last = text ? text.charAt(text.length - 1) : 'a';
    const code = last.charCodeAt(0) || 65;
    ['keydown', 'keypress', 'keyup'].forEach(function (type) {
      try {
        input.dispatchEvent(new KeyboardEvent(type, {
          key: last, code: 'KeyA', keyCode: code, which: code,
          bubbles: true, cancelable: true
        }));
      } catch (err) {}
    });
  }

  function dispatchYupaoInputEvents(input) {
    if (!input) return;
    try {
      input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: null
      }));
    } catch (err) {
      try { input.dispatchEvent(new Event('beforeinput', { bubbles: true })); } catch (ignore) {}
    }
    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: false, inputType: 'insertText', data: null
      }));
    } catch (err) {
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (ignore) {}
    }
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (err) {}
    dispatchYupaoKeyEvents(input);
  }

  // 直调组件输入处理器：Vue 3 的 _vei、嵌套组件 vnode.props、React props。
  // 找不到任何处理器时返回 false，不影响原有事件链。
  function invokeYupaoInputHandlers(input, data) {
    if (!input) return false;
    const handlerNames = ['onInput', 'onChange'];
    const handlerData = data == null ? null : String(data);
    let invoked = false;
    let modelInvoked = false;
    let node = input;
    for (let level = 0; level < 6 && node && node !== document.body; level++) {
      let vei = null;
      try { vei = node._vei; } catch (err) { vei = null; }
      if (vei && typeof vei === 'object') {
        for (let i = 0; i < handlerNames.length; i++) {
          const fn = vei[handlerNames[i]];
          if (typeof fn !== 'function') continue;
          try {
            fn.call(node, yupaoInputEvent(input, handlerNames[i].slice(2).toLowerCase(), handlerData));
            invoked = true;
          } catch (err) {}
        }
      }
      const props = reactFindProps(node);
      if (props) {
        for (let i = 0; i < handlerNames.length; i++) {
          const fn = props[handlerNames[i]];
          if (typeof fn !== 'function') continue;
          try {
            fn.call(node, yupaoInputEvent(input, handlerNames[i].slice(2).toLowerCase(), handlerData));
            invoked = true;
          } catch (err) {}
        }
      }
      const vprops = node.__vueParentComponent &&
        node.__vueParentComponent.vnode && node.__vueParentComponent.vnode.props;
      if (vprops) {
        for (let i = 0; i < handlerNames.length; i++) {
          const fn = vprops[handlerNames[i]];
          if (typeof fn !== 'function') continue;
          try {
            fn.call(node, yupaoInputEvent(input, handlerNames[i].slice(2).toLowerCase(), handlerData));
            invoked = true;
          } catch (err) {}
        }
        // v1.10.21：Vue v-model 组件只挂 onUpdate:modelValue，不挂 onInput。
        // 只补 DOM 事件不会更新组件模型，表现为“字已写入、计数器仍 0/300、
        // 发送按钮灰色”。这里把当前文本直接回写给 v-model。
        // 只调用最近一个带 model 监听的组件，避免向上误改无关父组件的 model。
        if (!modelInvoked) {
          const modelText = handlerData != null ? handlerData : getEditorText(input);
          const modelNames = ['onUpdate:modelValue', 'onUpdate:value', 'onUpdate:text'];
          for (let i = 0; i < modelNames.length; i++) {
            const fn = vprops[modelNames[i]];
            if (typeof fn !== 'function') continue;
            try {
              fn.call(node, modelText);
              invoked = true;
              modelInvoked = true;
            } catch (err) {}
          }
        }
      }
      node = node.parentElement;
    }
    return invoked;
  }

  async function syncYupaoEditorText(input, greeting) {
    if (!input) return false;
    const raw = String(greeting == null ? '' : greeting);
    const text = yupaoGreetingText(raw, input);
    if (raw.length > text.length) {
      log('鱼泡输入上限 ' + yupaoInputLimit(input) + ' 字，话术已截断后填入', 'warn');
    }
    // v1.10.14：只在内容与目标不完全一致时写入，且写入前先清空。
    // 旧版用“包含目标文本”判定成功，execCommand 变成追加时也会通过，
    // 后续每次同步继续追加，最终出现 2~3 份重复内容（0/300 → 180/300）。
    if (norm(getEditorText(input)) !== norm(text)) {
      const inserted = insertYupaoText(input, text);
      if (!inserted) writeYupaoExact(input, text);
    }
    // 写后必须精确相等；execCommand 异常或组件回写都可能留下重复内容。
    if (norm(getEditorText(input)) !== norm(text)) {
      writeYupaoExact(input, text);
    }
    dispatchYupaoInputEvents(input);
    invokeYupaoInputHandlers(input);
    // 组件状态同步后再补一次按键事件：部分站点在 keyup 时读取组件状态
    // 刷新字数与发送按钮，顺序反了会仍然停在 0/300。
    dispatchYupaoKeyEvents(input);
    await delay(120);
    // 平台把内容回滚或再次写入其他内容时，强制恢复为目标文本一次。
    if (norm(getEditorText(input)) !== norm(text)) {
      writeYupaoExact(input, text);
      dispatchYupaoInputEvents(input);
      invokeYupaoInputHandlers(input);
      dispatchYupaoKeyEvents(input);
      await delay(120);
    }
    return norm(getEditorText(input)) === norm(text);
  }

  // v1.10.23：读取聊天编辑器旁的“已输入字数/上限”计数器。
  // DOM 里有文字不代表 React/富文本组件的内部 model 有文字；计数器是
  // 判断 model 是否真正更新的直接反馈（截图中的 0/300 就是典型表现）。
  function yupaoCounterText(input) {
    if (!input) return -1;
    let scope = null;
    try {
      scope = input.closest('.fb-chat-editor, .fb-chat-editor-container, .ant-drawer-content-wrapper');
    } catch (err) {
      scope = null;
    }
    if (!scope) scope = input.parentElement;
    if (!scope) return -1;
    let nodes = [];
    try {
      nodes = scope.querySelectorAll('p, span');
    } catch (err) {
      nodes = [];
    }
    for (let i = 0; i < nodes.length && i < 120; i++) {
      const text = norm(nodes[i].textContent);
      const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (match) return Number(match[1]);
    }
    return -1;
  }

  // v1.10.23：React/FishEditor 可能只在 event.data 非空时更新 model。
  // 正常同步仍发 data:null，避免重复追加；只有计数器为 0（model 为空）时，
  // 才补发一次带完整文本的 input，再直调带 data 的 React/Vue 处理器。
  // v1.10.24：优先走浏览器真实编辑管线。execCommand('insertText') 会派发
  // trusted 的 beforeinput/input（data 为整段文本），比纯合成事件更容易被
  // 自定义编辑器接受；失败时恢复 DOM 文本并回退到合成事件链路。
  async function forceYupaoInputData(input, text) {
    if (!input || !text) return false;
    const target = String(text);
    if (insertYupaoText(input, target)) {
      await delay(200);
      if (yupaoCounterText(input) === target.length) return true;
    }
    // execCommand 不可用或组件未接收时，清空后的 DOM 需要恢复目标文本，
    // 否则后续 isSent 会把“输入框为空”误判为发送成功。
    if (norm(getEditorText(input)) !== norm(target)) {
      writeYupaoExact(input, target);
    }
    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: false, inputType: 'insertText', data: target
      }));
    } catch (err) {
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (ignore) {}
    }
    await delay(200);
    if (yupaoCounterText(input) === target.length) return true;
    invokeYupaoInputHandlers(input, target);
    dispatchYupaoKeyEvents(input);
    await delay(200);
    return yupaoCounterText(input) === target.length;
  }

  async function prepareYupaoSend(panel, input, config) {
    if (platform.key !== 'yupao' || !input) return;
    const scope = panel || findChatPanel() || closestEditorContainer(input);
    // v1.10.13：发送前再同步一次组件状态，覆盖站点在填写后重置输入的情况。
    // 若输入已被清空，按本次话术重新填入，避免“空输入也算发送成功”。
    if (!config || config.yupaoInputFix !== false) {
      const current = getEditorText(input);
      const wanted = norm(current).length === 0 && config && config.greeting
        ? config.greeting
        : current;
      await syncYupaoEditorText(input, wanted);
    }
    let button = findSendButton(scope, input, true);
    if (!button) return;

    // v1.10.24：鱼泡的灰色发送按钮可能不带 disabled 属性（仅 CSS 置灰，
    // 由点击处理器按 model 拦截）。旧版在 isDisabled() 为 false 时直接返回，
    // v1.10.23 的 model 回写永远执行不到。这里改以“计数器为 0”为准：
    // DOM 有文字但计数器为 0，就说明编辑器内部 model 为空，必须先回写。
    const modelEmpty = config && config.yupaoInputFix !== false &&
      yupaoCounterText(input) === 0;
    if (!modelEmpty && !isDisabled(button)) return;

    // v1.10.23：DOM 已有文字但计数器仍为 0，说明编辑器内部 model 为空。
    // 补发带完整 data 的 input，并直调带 data 的处理器；只有计数器确认
    // 更新到目标字数才认为模型同步成功。
    if (modelEmpty) {
      const text = getEditorText(input);
      if (text) {
        const forced = await forceYupaoInputData(input, text);
        if (forced) {
          const enabled = await waitFor(function () {
            const candidate = findSendButton(scope, input, true);
            return candidate && !isDisabled(candidate) ? candidate : null;
          }, 1200, 150);
          if (enabled) {
            log('鱼泡输入已回写编辑器模型，发送按钮恢复可用', 'ok');
            return;
          }
        } else {
          log('鱼泡输入模型同步失败：计数器仍为 ' + yupaoCounterText(input) +
            '，请把聊天输入区 DOM 发给助手分析', 'warn');
        }
      }
    }

    // 按钮本来可用、只是模型回写未成功时，不再走“解除禁用”分支，
    // 交给后续发送链路处理，避免误报“按钮已恢复可用”。
    if (!isDisabled(button)) return;

    if (config && config.yupaoInputFix !== false) {
      // 已在上方完成同步；这里只再等站点刷新按钮状态。
    } else {
      nudgeYupaoEditor(input);
    }
    button = await waitFor(function () {
      const candidate = findSendButton(scope, input, true);
      return candidate && !isDisabled(candidate) ? candidate : null;
    }, 1200, 150);
    if (button) {
      log('鱼泡发送按钮已由站点状态刷新为可用', 'ok');
      return;
    }

    button = findSendButton(scope, input, true);
    if (!button) return;
    releaseYupaoSendButton(button);
    log('鱼泡发送按钮为灰色不可用，已解除禁用状态后继续发送', 'warn');
  }

  async function clickSend(panel, input, greeting) {
    let button = findSendButton(panel, input, true);
    if (button && isDisabled(button)) {
      button = await waitFor(function () {
        const candidate = findSendButton(panel, input, true);
        return candidate && !isDisabled(candidate) ? candidate : null;
      }, 2500, 150);
    }
    if (!button) {
      log('未找到发送按钮，尝试回车发送', 'warn');
      pressEnter(input);
      if (platform.reactInvokeFallback) {
        reactInvokeEnter(input);
      }
      await delay(600);
      return;
    }
    if (isDisabled(button)) throw makeError('SEND_DISABLED', '发送按钮不可用');
    log('点击发送');
    // v1.10.5：发送按钮与沟通按钮同链路——原生 .click() 优先（v1.10.3 实锤
    // dispatchEvent 派发路径会被站点门禁整段丢弃，el.click() 可穿透），
    // 未生效再降级 safeClick 全序列与 React 直调。
    nativeClick(button);
    if (!(await waitSent(panel, input, greeting, 2200))) {
      safeClick(button);
    }
    if (platform.reactInvokeFallback) {
      // 关键修复：发送成功后按钮通常仍留在 DOM。旧版只判断「按钮还在」就直调
      // React onClick，可能把已经发出的消息再发一次。这里先轮询确认发送结果，
      // 确认已发送立即返回；只有仍未发送时才进入直调兜底。
      if (await waitSent(panel, input, greeting, 1600)) return;
      const stillThere = findSendButton(panel, input, true);
      if (stillThere && !isSent(panel, input, greeting)) {
        log('合成点击发送未生效，尝试 React 直调兜底', 'warn');
        reactInvokeClick(stillThere, 8);
        if (greeting) {
          // 直调后发送+气泡渲染+输入框清空是异步的，留足时间再确认。
          if (await waitSent(panel, input, greeting, 1800)) return;
          if (!isSent(panel, input, greeting) && findSendButton(panel, input, true)) {
            log('DOM 直调未确认生效，尝试组件树直调兜底', 'warn');
            reactInvokeClickFiber(stillThere, 16);
          }
        }
      }
      await waitSent(panel, input, greeting, 800);
    } else {
      await delay(700);
    }
  }

  async function retrySend(panel, input, greeting) {
    // 先给上一轮发送的异步渲染留出时间；一旦确认已发送立即返回，
    // 不再固定等待 1.4~2 秒，也不会对已发出的消息重复点击。
    if (await waitSent(panel, input, greeting, 1600)) return;
    log('未确认发送成功，重试一次', 'warn');
    const button = findSendButton(panel, input);
    if (button && !isDisabled(button)) {
      nativeClick(button);
      if (!(await waitSent(panel, input, greeting, 1500))) {
        safeClick(button);
      }
      if (platform.reactInvokeFallback) {
        if (await waitSent(panel, input, greeting, 1600)) return;
        const still = findSendButton(panel, input);
        if (still && !isSent(panel, input, greeting)) {
          reactInvokeClick(still, 8);
          if (await waitSent(panel, input, greeting, 1800)) return;
          if (!isSent(panel, input, greeting) && findSendButton(panel, input)) {
            reactInvokeClickFiber(still, 16);
          }
        }
      }
    } else {
      pressEnter(input);
      if (platform.reactInvokeFallback) {
        reactInvokeEnter(input);
      }
    }
    await waitSent(panel, input, greeting, 800);
  }

  async function closeChat() {
    const panel = findSuccessModal() || findChatPanel();
    if (!panel) {
      cachedChatPanel = null;
      pressEscape();
      await delay(250);
      return;
    }

    let button = findXPathNode(platform.closeXPaths, panel, function (el) {
      return isRendered(el) && !isInPanel(el);
    });
    if (button) button = button.closest('a, button, [role="button"]') || button;

    for (let i = 0; i < platform.closeSelectors.length && !button; i++) {
      let nodes = [];
      try {
        nodes = Array.prototype.slice.call(panel.querySelectorAll(platform.closeSelectors[i]));
      } catch (err) {
        nodes = [];
      }
      for (let n = 0; n < nodes.length; n++) {
        const el = nodes[n];
        if (isRendered(el) && !isInPanel(el)) {
          button = el.closest('a, button, [role="button"]') || el;
          break;
        }
      }
    }
    if (!button) {
      button = findClickableByText(panel, platform.closeTexts, { partial: false });
    }
    // 抽屉类弹层没有明显关闭按钮时，点击遮罩关闭。
    if (!button && platform.maskCloseSelectors) {
      for (let i = 0; i < platform.maskCloseSelectors.length; i++) {
        let mask = null;
        try {
          mask = document.querySelector(platform.maskCloseSelectors[i]);
        } catch (err) {
          mask = null;
        }
        if (mask && isVisible(mask)) {
          button = mask;
          break;
        }
      }
    }
    if (button) {
      safeClick(button);
      await delay(400);
    } else {
      pressEscape();
      await delay(350);
    }

    // 鱼泡侧边栏没有明显关闭按钮时，点击聊天面板左上角的返回箭头。
    if (platform.closeByPanelCorner && (findChatPanel() || findSuccessModal())) {
      const current = findChatPanel() || findSuccessModal();
      if (current) {
        try {
          const rect = current.getBoundingClientRect();
          const back = document.elementFromPoint(rect.left + 28, rect.top + 28);
          if (back) safeClick(back);
          await delay(400);
        } catch (err) {}
      }
    }

    if (findChatPanel() || findSuccessModal()) {
      pressEscape();
      await delay(250);
    }
    // 面板已关闭或即将关闭：清空缓存，避免下一次动作把旧面板误判为“已打开”。
    cachedChatPanel = null;
  }

  // =========================================================================
  // 智联打招呼结果弹窗自动关闭（v1.10.12）
  // 点击「先聊聊」后智联会弹出「已向对方发送打招呼」结果层（留在此页 /
  // 继续沟通）。该弹层带全屏遮罩，不关闭会拦截后续卡片点击与详情按钮定位，
  // 表现为流程卡死或连续跳过。这里完全按可见文字定位，不依赖易变 class，
  // 与原有 closeChat 互为兜底，并由面板开关单独控制。
  // v1.10.26：实机 DOM 为 .deliver-greeting-modal（遮罩）> __box（结果框）>
  // __close（「×」按钮，aria-label=关闭），且「留在此页」已变为「留在+城市名」
  // 动态文案。定位改为「稳定结构优先、文案匹配兜底」：先按 __box/__close
  // 结构命中弹窗，再用原生 .click() 点击关闭按钮，最后才退回旧文字链路。
  // v1.10.27：实机复核「留在此页」按钮有稳定 class（__footer 内
  // deliver-greeting-modal__btn--secondary）。关闭改为「两种方式交替重试」：
  // 偶数轮点「留在此页」、奇数轮点「×」，点击异常自动换另一种方式兜底；
  // 点击前显式等待弹窗完全加载且目标可交互；closeChat 后弹窗仍存在时
  // 也改走本链路（closeChat 的合成点击会被智联门禁丢弃，原生 .click() 才有效）。
  // =========================================================================
  const ZHAOPIN_POPUP_TITLES = [
    '已向对方发送打招呼',
    '已向对方发送简历',
    '已发送打招呼',
    '已发送简历'
  ];
  const ZHAOPIN_POPUP_CLOSE_TEXTS = ['留在此页'];
  const ZHAOPIN_POPUP_ICON_SELECTORS = [
    '.deliver-greeting-modal__close',
    '.a-modal-close',
    '.dialog-close',
    '.modal-close',
    '[class*="modal"] [class*="close"]',
    '[class*="dialog"] [class*="close"]',
    '[class*="popup"] [class*="close"]'
  ];

  function zhaopinPopupTextMatched(root) {
    if (!root) return false;
    const text = norm(root.textContent);
    return ZHAOPIN_POPUP_TITLES.some(function (item) {
      return text.indexOf(item) !== -1;
    });
  }

  // v1.10.26：按实时 DOM 结构定位结果弹窗——deliver-greeting-modal__box 是
  // 结果框内容容器（「×」关闭按钮就挂在它内部），比结果文案更稳定。命中后
  // 向上归一到遮罩根节点，供 findSuccessModal / closeChat 复用。
  function findZhaopinGreetingModalBox() {
    if (platform.key !== 'zhaopin') return null;
    let boxes = [];
    try {
      boxes = Array.prototype.slice.call(document.querySelectorAll(
        '.deliver-greeting-modal__box, [class*="deliver-greeting-modal__box"]'
      ));
    } catch (err) {
      return null;
    }
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!isVisible(box) || isInPanel(box)) continue;
      // 结构 + 特征双确认：结果文案命中（已向对方发送打招呼…）、框内存在
      // __close 关闭按钮或 __btn 操作按钮（v1.10.27：footer/按钮区变体），
      // 三者其一即可，避免误认其他 deliver 弹层。
      if (zhaopinPopupTextMatched(box) ||
        box.querySelector('[class*="deliver-greeting-modal__close"], [class*="deliver-greeting-modal__btn"]')) {
        return box.closest('[class*="deliver-greeting-modal"]') || box;
      }
    }
    return null;
  }

  // 先按结构定位（v1.10.26），未命中再找「留在此页」按钮（智联招呼结果层
  // 独有），向上确认弹窗容器。返回容器而不是按钮，供 findSuccessModal / closeChat 复用。
  function findZhaopinGreetingPopup() {
    if (platform.key !== 'zhaopin') return null;
    const byStructure = findZhaopinGreetingModalBox();
    if (byStructure) return byStructure;
    let button = null;
    try {
      button = findXPathNode([
        '//button[contains(normalize-space(.),"留在此页")]',
        '//a[contains(normalize-space(.),"留在此页")]',
        '//*[@role="button" and contains(normalize-space(.),"留在此页")]'
      ], null, function (el) {
        return isVisible(el) && !isInPanel(el);
      });
    } catch (err) {
      button = null;
    }

    // 兼容没有「留在此页」的变体：在可见弹窗容器内找「继续沟通」或关闭图标。
    // 只扫描 class 含 modal/dialog/popup/layer 的容器，避免在整页范围内
    // 反复查询已沟通卡片上的「继续沟通」，也不会误伤列表按钮。
    if (!button) {
      let layers = [];
      try {
        layers = Array.prototype.slice.call(document.querySelectorAll(
          '[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="layer"]'
        ));
      } catch (err) {
        layers = [];
      }
      for (let i = 0; i < layers.length && i < 40; i++) {
        const layer = layers[i];
        if (!isVisible(layer) || isInPanel(layer)) continue;
        if (!zhaopinPopupTextMatched(layer)) continue;
        const action = findClickableByText(layer, ['继续沟通', '留在此页'], { partial: false });
        let closeIcon = null;
        try {
          closeIcon = layer.querySelector('[class*="close"], .a-modal-close');
        } catch (err) {
          closeIcon = null;
        }
        if (action || (closeIcon && isRendered(closeIcon))) return layer;
      }
      return null;
    }

    let popup = null;
    try {
      popup = button.closest('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="layer"]');
    } catch (err) {
      popup = null;
    }
    if (!popup) {
      // 类名全部变化时，向上找同时包含结果标题和按钮的最外层容器。
      let cur = button.parentElement;
      for (let depth = 0; depth < 8 && cur && cur !== document.body; depth++) {
        if (zhaopinPopupTextMatched(cur)) {
          popup = cur;
          break;
        }
        cur = cur.parentElement;
      }
    }
    if (!popup) popup = button.parentElement;
    return popup && zhaopinPopupTextMatched(popup) ? popup : null;
  }

  // v1.10.26：结果框内的「×」关闭按钮（deliver-greeting-modal__close，
  // aria-label=关闭）。新版弹窗「留在此页」已改为「留在+城市名」动态文案，
  // 图标按钮的 class 与 aria-label 更稳定，作为首选点击目标。
  function findZhaopinPopupCloseIcon(popup) {
    if (!popup) return null;
    let nodes = [];
    try {
      nodes = Array.prototype.slice.call(popup.querySelectorAll(
        'button.deliver-greeting-modal__close, [class*="deliver-greeting-modal__close"], ' +
        'button[aria-label="关闭"], [aria-label="关闭"]'
      ));
    } catch (err) {
      return null;
    }
    for (let i = 0; i < nodes.length; i++) {
      if (isRendered(nodes[i]) && !isInPanel(nodes[i])) {
        return nodes[i].closest('button, a, [role="button"]') || nodes[i];
      }
    }
    return null;
  }

  // v1.10.27：「留在此页」按钮定位（与「×」并列为两种关闭方式之一）。
  // 实机结构：deliver-greeting-modal__footer 内的 __btn--secondary 按钮，
  // 文案「留在此页 / 留在+城市名」；class 改版时按「留在」前缀文字兜底。
  // 只匹配「留在」开头文案，绝不误点「继续沟通」（那会跳转聊天页）。
  function findZhaopinPopupStayButton(popup) {
    if (!popup) return null;
    let nodes = [];
    try {
      nodes = Array.prototype.slice.call(popup.querySelectorAll(
        '.deliver-greeting-modal__btn--secondary, [class*="deliver-greeting-modal__btn"]'
      ));
    } catch (err) {
      nodes = [];
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!isRendered(node) || isInPanel(node)) continue;
      const text = norm(node.textContent);
      if (text.indexOf('留在') === 0) {
        return node.closest('button, a, [role="button"]') || node;
      }
    }
    let target = findXPathNode([
      '//button[starts-with(normalize-space(.),"留在")]',
      '//a[starts-with(normalize-space(.),"留在")]',
      '//*[@role="button" and starts-with(normalize-space(.),"留在")]'
    ], popup, function (el) {
      return isVisible(el) && !isInPanel(el);
    });
    if (target) return target.closest('button, a, [role="button"]') || target;
    return findClickableByText(popup, ZHAOPIN_POPUP_CLOSE_TEXTS, { partial: false });
  }

  function findZhaopinPopupCloseTarget(popup) {
    // 首选：「×」关闭图标按钮（图二元素），原生 .click() 点击链路的落点。
    let target = findZhaopinPopupCloseIcon(popup);
    if (target) return target;
    // 次选：「留在+城市名 / 留在此页」按钮，starts-with 兼容动态文案。
    target = findXPathNode([
      '//button[starts-with(normalize-space(.),"留在")]',
      '//a[starts-with(normalize-space(.),"留在")]',
      '//*[@role="button" and starts-with(normalize-space(.),"留在")]'
    ], popup, function (el) {
      return isVisible(el) && !isInPanel(el);
    });
    if (target) return target.closest('button, a, [role="button"]') || target;
    target = findClickableByText(popup, ZHAOPIN_POPUP_CLOSE_TEXTS, { partial: false });
    if (target) return target;
    for (let i = 0; i < ZHAOPIN_POPUP_ICON_SELECTORS.length && !target; i++) {
      let nodes = [];
      try {
        nodes = Array.prototype.slice.call(popup.querySelectorAll(ZHAOPIN_POPUP_ICON_SELECTORS[i]));
      } catch (err) {
        nodes = [];
      }
      for (let n = 0; n < nodes.length; n++) {
        if (isRendered(nodes[n]) && !isInPanel(nodes[n])) {
          target = nodes[n].closest('button, a, [role="button"]') || nodes[n];
          break;
        }
      }
    }
    if (!target) target = findClickableByText(popup, ['关闭', '知道了'], { partial: false });
    return target;
  }

  async function closeZhaopinGreetingPopup() {
    if (platform.key !== 'zhaopin') return false;
    // 快路径：无弹窗立即返回，不拖慢每轮循环。
    if (!findZhaopinGreetingPopup()) return false;
    // v1.10.27 显式等待：弹窗可能正处于淡入动画或慢加载（已挂载但按钮
    // 尚未渲染），等它完全加载且至少一种关闭方式可交互后再点击（最多 2 秒），
    // 彻底避免元素未找到的异常。
    const ready = await waitFor(function () {
      const layer = findZhaopinGreetingPopup();
      return layer && (findZhaopinPopupStayButton(layer) || findZhaopinPopupCloseIcon(layer)) ? layer : null;
    }, 2000, 150);
    if (!ready) {
      // 两种方式都拿不到可交互目标：Esc 兜底并确认结果。
      pressEscape();
      const escGone = await waitFor(function () {
        return findZhaopinGreetingPopup() ? null : true;
      }, 800, 150);
      return !!escGone;
    }

    // v1.10.27：两种关闭方式交替重试——偶数轮点「留在此页」，奇数轮点「×」。
    // 每次点击都有异常捕获（原生 .click() 失败/抛错自动降级完整点击序列）；
    // 本轮首选方式未生效时下一轮自动换另一种方式，共 4 轮 + Esc 终局兜底。
    for (let round = 0; round < 4; round++) {
      const popup = findZhaopinGreetingPopup();
      if (!popup) {
        // 遮罩淡出需要时间，确认消失后再留少量余量，
        // 避免残留遮罩拦截下一张职位卡片的点击。
        await delay(320);
        return true;
      }
      const stayFirst = round % 2 === 0;
      let target = stayFirst ? findZhaopinPopupStayButton(popup) : findZhaopinPopupCloseIcon(popup);
      // 本轮首选方式没定位到目标：同轮直接换另一种方式，两种都失效才 Esc。
      if (!target) target = stayFirst ? findZhaopinPopupCloseIcon(popup) : findZhaopinPopupStayButton(popup);
      if (!target) target = findZhaopinPopupCloseTarget(popup);
      if (target) {
        try {
          // 原生 .click() 优先（实测可穿透智联点击门禁），不可用时降级完整序列。
          if (!nativeClick(target)) safeClick(target);
        } catch (err) {
          try { safeClick(target); } catch (ignored) {}
        }
      } else {
        pressEscape();
      }
      const gone = await waitFor(function () {
        return findZhaopinGreetingPopup() ? null : true;
      }, 1200, 120);
      if (gone) {
        await delay(320);
        return true;
      }
    }
    pressEscape();
    const finalGone = await waitFor(function () {
      return findZhaopinGreetingPopup() ? null : true;
    }, 800, 150);
    return !!finalGone;
  }

  // 每轮循环开始前调用：结果弹窗或残留聊天窗都先清掉，避免遮罩拦截下一次操作。
  async function guardZhaopinPopup(config) {
    if (platform.key !== 'zhaopin') return false;
    if (config && config.zhaopinAutoClose === false) return false;
    if (findZhaopinGreetingPopup()) {
      log('检测到智联打招呼结果弹窗，正在自动关闭', 'warn');
    } else if (findChatPanel()) {
      // panelSelectors 含 .deliver-greeting-modal，结果弹窗可能被当成残留
      // 聊天窗；且 closeChat 走合成点击（safeClick），会被智联门禁丢弃。
      // v1.10.27：closeChat 后必须复核——弹窗仍在就改走「留在此页 / ×」
      // 两方式原生点击链路，不再假定已关闭。
      await closeChat();
      log('已关闭残留的智联聊天窗口', 'warn');
      if (!findZhaopinGreetingPopup()) return true;
      log('智联结果弹窗仍残留，改用「留在此页 / ×」两方式关闭', 'warn');
    } else {
      return false;
    }
    const closed = await closeZhaopinGreetingPopup();
    log(closed
      ? '智联弹窗已关闭，继续处理下一个职位'
      : '智联弹窗关闭超时，已执行 Esc 兜底，下一轮继续尝试', closed ? 'ok' : 'warn');
    return closed;
  }

  // =========================================================================
  // 单个职位处理
  // =========================================================================
  async function processJob(card, config) {
    // 上一次的“已发送”结果弹窗若未关闭，会干扰当前职位的成功判断。
    const staleSuccess = findSuccessModal();
    if (staleSuccess) {
      await closeChat();
      // v1.10.12：智联新版结果弹窗按文字识别，closeChat 未命中时由守卫兜底。
      await guardZhaopinPopup(config);
      await delay(350);
      if (findSuccessModal()) throw makeError('STALE_MODAL', '上一个打招呼结果弹窗未关闭');
    }
    // 上一个职位的聊天抽屉若未完全关闭，先关闭，避免影响当前职位的输入与发送判断。
    if (findChatPanel()) {
      await closeChat();
      await delay(300);
    }

    // v1.10：已沟通职位无需点卡片/找按钮，卡片徽标即可判定，提前跳过。
    // v1.10.1：检查真正提前到点击卡片之前——旧版放在 activateCard 与详情
    // 切换校验之后，已沟通卡片仍要经历整轮点击 + 详情切换等待（已沟通
    // 密集时是列表响应慢的主场景），详情未切换时还会被误计入 detailSwitchFails。
    // 徽标只读卡片自身 DOM，与详情面板无关，提前判定是安全的。
    if (hasCommunicatedMarker(card)) throw makeError('SKIP', '该职位已沟通过（卡片已标记）');

    // v1.10.8：点击卡片前模拟人工查看节奏（悬停 / 微滚动 / 停顿）。
    if (config.humanize !== false) await performHumanBehavior(config, card);
    // v1.10.9：人工停顿结束后，按上一张卡片点击结束时间补齐剩余间隔。
    await waitForCardClickSlot();
    // v1.10.12：等待间隔期间卡片可能被列表重渲染移除，点击前再确认一次。
    if (!card.isConnected || !isRendered(card)) {
      throw makeError('SKIP', '职位卡片已从列表移除');
    }
    await activateCard(card);
    // v1.10.9：本次卡片点击动作结束，记录下一次卡片点击的绝对目标时间。
    scheduleNextCardClick(config);

    // 校验详情面板已切到当前职位；未切到时重试，仍失败则如实跳过。
    // 绝不能拿上一个职位残留的「继续聊/已沟通」按钮判定当前职位。
    if (!(await ensureDetailSwitched(card))) {
      state.detailSwitchFails++;
      // v1.10.19：把提取到的卡片标题写进日志，便于定位标题/详情不匹配。
      log('详情未切换：卡片标题「' + truncate(getJobTitle(card), 18) + '」', 'warn');
      if (state.detailSwitchFails >= 5) {
        throw makeError('DETAIL_STUCK', '连续 ' + state.detailSwitchFails + ' 个职位详情面板未切换或无法识别，无法安全读取沟通按钮。多为页面结构不匹配或页面久置失活：请刷新页面，并确认在标准职位搜索页（如鱼泡 /web/zhaogong）运行后重试');
      }
      throw makeError('SKIP', '点击卡片后详情未切换到该职位');
    }
    state.detailSwitchFails = 0;

    // v1.10.28：移除「右侧详情与当前职位不一致」跳过（原 v1.10.11 严格校验）。
    // 实机确认 BOSS 行为：点击「立即沟通」后返回列表，已点击职位会自动从列表
    // 消失，不存在「用残留详情发给上一个 HR」的场景；而列表项与详情头部
    // 存在正常差异（标题省略、改版文案、懒渲染）时该严格比对会把大量未沟通
    // 职位误判为不一致并跳过。详情切换本身仍由上方 ensureDetailSwitched
    // 校验，发送前的会话一致性校验（聊天页）也保持不变。

    const action = await waitFor(function () {
      return findActionButton(card);
    }, platform.reactInvokeFallback ? 8000 : 5000, 200);
    if (!action) {
      // 详情里没有可用沟通按钮时，若卡片/详情显示已沟通，按正常跳过处理。
      if (hasCommunicatedMarker(card)) throw makeError('SKIP', '该职位已沟通过');
      throw makeError('NO_ACTION', '未找到沟通按钮');
    }

    const actionText = norm(action.textContent);
    if (isCommunicatedText(actionText) || platform.skipActionNorms.some(function (item) {
      return actionText.indexOf(item) !== -1;
    })) {
      throw makeError('SKIP', '该职位已沟通过');
    }

    // v1.10：关闭自动打招呼时只保留卡片切换与已沟通跳过，
    // 不点击沟通按钮，避免打开聊天窗或触发平台自带招呼语/投递。
    if (config.enableGreeting === false) {
      log('自动打招呼已关闭，跳过发送：' + truncate(actionText || '沟通按钮', 12), 'warn');
      throw makeError('SKIP', '自动打招呼已关闭（仅切换职位）');
    }

    log('点击沟通按钮' + (actionText ? '：' + actionText : ''));
    // v1.10.6：BOSS 在真正点击「立即沟通」前落本地标记，跳转聊天页后
    // 即使流程状态丢失，返回列表页也能凭标记跳过该职位。
    // v1.10.7：同时记录当前列表完整地址与滚动位置（此时卡片已滚动到可视区），
    // 聊天页发送完成后据此显式导航返回。
    if (platform.key === 'boss') {
      markBossJob(getJobKey(card));
      updateFlow({
        listUrl: location.href,
        scrollY: Math.round(window.scrollY || 0),
        autoReturn: config.bossAutoReturn !== false,
        bossInputStrict: config.bossInputStrict !== false,
        // v1.10.29：跨页接力时同样传递会话一致性校验开关。
        bossSessionVerify: config.bossSessionVerify !== false,
        // v1.10.9：跨页后继续沿用同一张卡片点击的间隔目标时间。
        lastCardClickAt: state.lastCardClickAt,
        nextCardClickAt: state.nextCardClickAt
      });
    }
    const beforeEditors = new Set(collectEditors());
    const clickTarget = resolveActionClickable(action);
    // v1.10.8：点击沟通按钮前同样加入人工行为模拟，避免“定位后瞬间点击”。
    if (config.humanize !== false) await performHumanBehavior(config, clickTarget);
    // v1.10.3：原生 .click() 优先——智联实测可穿透门禁；未生效再走
    // 原 safeClick 全序列与组件直调兜底（BOSS 慢跳转接力逻辑不受影响）。
    nativeClick(clickTarget);
    if (!(await waitFor(function () { return actionOpened() ? true : null; }, 2200, 250))) {
      safeClick(clickTarget);
    }

    if (platform.key === 'boss') {
      // 点击「立即沟通」后同标签页跳转到 /web/geek/chat，本实例随页面卸载结束，
      // 由聊天页实例从流程状态接管发送。改为轮询：跳转成功立即返回，
      // 慢网/高峰仍保留 6 秒，兜底后再留 3 秒给跳转。
      if (await waitFor(function () { return isBossChatPage() ? true : null; }, 6000, 250)) {
        return { handedOff: true };
      }
      if (!actionOpened()) {
        log('未跳转聊天页，尝试组件直调兜底（流程保留）', 'warn');
        await invokeActionFallback(clickTarget);
      }
      if (await waitFor(function () { return isBossChatPage() ? true : null; }, 3000, 250)) {
        return { handedOff: true };
      }
    } else {
      // BOSS 的 isTrusted 门禁 / 智联的 Vue 组件：合成点击可能被丢弃。
      // 先短轮询确认，仍未打开聊天或结果弹窗再走组件直调兜底。
      if (!(await waitFor(function () { return actionOpened() ? true : null; }, 1800, 220))) {
        await invokeActionFallback(clickTarget);
      }
    }

    // 上一步 click-confirm 已确认聊天/结果弹窗出现，这里只留极短动画余量。
    await delay(randInt(120, 260));

    const result = await waitForChat(beforeEditors, 10000);
    if (result.type === 'login') {
      throw makeError('LOGIN_REQUIRED', '检测到登录弹窗，请先登录后再执行');
    }
    if (result.type === 'success') {
      if (platform.key === 'zhaopin') {
        log('智联已自动发送平台自带招呼语（本地面板预设仅在出现输入框时使用）', 'ok');
      } else {
        log('平台已自动发送简历和打招呼语（未出现可编辑输入框）', 'ok');
      }
      await closeChat();
      // v1.10.12：closeChat 未命中时由智联弹窗守卫再兜底关闭一次。
      await guardZhaopinPopup(config);
      return;
    }
    if (result.type !== 'chat' || !result.input) {
      throw makeError('NO_CHAT', '未找到聊天输入框或发送按钮');
    }

    let input = result.input;
    const panel = result.panel || findChatPanel() || closestEditorContainer(input);
    // v1.10.13：鱼泡 .fb-editor 可能只是外层容器，改写到内部真实编辑器，
    // 避免覆盖内部节点及其事件监听（表现为字可见、计数器仍 0/300）。
    if (platform.key === 'yupao' && config.yupaoInputFix !== false) {
      input = resolveYupaoEditable(input);
    }

    // v1.10.5：平台代发防护。旧版靠 isSent 文本计数误判歪打正着地防了
    // 重复发送；isSent 修正为输入框判据后必须显式检测：输入框为空且
    // 会话中已有同款话术 = 平台已自动发出，不再填写发送第二遍。
    if (norm(getEditorText(input)).length === 0 && panelContainsGreeting(panel, config.greeting)) {
      log('平台已自动发送同款招呼语，跳过本地填写发送', 'ok');
      await closeChat();
      return;
    }

    log('聊天框已打开，正在填写话术');

    // v1.10.13：鱼泡走独立输入同步（execCommand + 完整事件 + 组件直调）。
    if (platform.key === 'yupao' && config.yupaoInputFix !== false) {
      await syncYupaoEditorText(input, config.greeting);
    } else {
      await setEditorValue(input, config.greeting);
    }
    const written = norm(getEditorText(input));
    const expected = norm(config.greeting);
    if (!written || (written.indexOf(expected.slice(0, 8)) === -1 && written !== expected)) {
      throw makeError('FILL_FAILED', '话术写入失败');
    }
    // v1.10.14：鱼泡必须与目标文本完全一致；出现重复堆叠时绝不继续发送。
    if (platform.key === 'yupao' && config.yupaoInputFix !== false &&
      written !== norm(yupaoGreetingText(config.greeting, input))) {
      throw makeError('FILL_FAILED', '鱼泡输入内容与预设不一致（疑似重复填充），已停止发送');
    }

    await delay(randInt(200, 400));
    // v1.10.6：鱼泡聊天窗适配——填入话术后发送按钮可能仍为灰色，
    // 发送前先由独立适配函数尝试恢复按钮可用态。
    if (platform.key === 'yupao') await prepareYupaoSend(panel, input, config);
    // v1.10.14：发送前再精确校验一次；重复/丢失内容都明确失败，避免发错。
    if (platform.key === 'yupao' && config.yupaoInputFix !== false &&
      norm(getEditorText(input)) !== norm(yupaoGreetingText(config.greeting, input))) {
      throw makeError('FILL_FAILED', '鱼泡输入内容与预设不一致（疑似重复填充），已停止发送');
    }
    await clickSend(panel, input, config.greeting);

    const rateLimited = detectRateLimit();
    if (rateLimited) {
      throw makeError('RATE_LIMIT', '平台提示操作频繁或已达到沟通上限，任务已停止');
    }

    if (!isSent(panel, input, config.greeting)) {
      await retrySend(panel, input, config.greeting);
    }
    if (!isSent(panel, input, config.greeting)) {
      throw makeError('SEND_FAILED', '未能确认打招呼语发送成功');
    }

    await closeChat();
    // v1.10.12：手动输入发送后同样清一次智联结果弹窗，保证无弹窗残留。
    await guardZhaopinPopup(config);
    // closeChat 已等待关闭动画完成，额外只留很短余量供下一张卡片渲染。
    await delay(randInt(120, 260));
  }

  // =========================================================================
  // 批量执行
  // =========================================================================
  async function waitForCards(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (state.stopRequested) return [];
      const cards = collectCards();
      if (cards.length) return cards;
      await delay(400);
    }
    return [];
  }

  function getIntervalMs(minSeconds, maxSeconds, config) {
    const min = Math.max(1, Math.round(Number(minSeconds) || 1));
    const max = Math.max(min, Math.round(Number(maxSeconds) || min));
    let total = randInt(min * 1000, max * 1000);
    // 未传配置（旧调用）或手动关闭平滑速率控制：保持旧版基础随机区间。
    if (!config || config.rateControl === false) return total;

    // 1) 不规则波动：多数接近基准，少量偏长/偏短，避免机械式固定节奏。
    const roll = Math.random();
    if (roll < 0.12) total = Math.round(total * (1.5 + Math.random() * 0.6));
    else if (roll < 0.22) total = Math.round(total * (0.7 + Math.random() * 0.2));

    // 2) 动态降速：连续异常时自动拉长，恢复正常后逐步回到原速。
    total = Math.round(total * getRateMultiplier(config));

    // 3) 周期休息：每处理若干职位插入一次较长停顿。
    if (!rateState.nextRestAt) rateState.nextRestAt = randInt(6, 12);
    rateState.intervalCount++;
    if (rateState.intervalCount >= rateState.nextRestAt) {
      rateState.intervalCount = 0;
      rateState.nextRestAt = randInt(6, 12);
      const rest = randInt(4000, 9000);
      total += rest;
      log('速率控制：已连续处理多个职位，本轮额外休息 ' +
        Math.round(rest / 1000) + ' 秒', 'warn');
    }

    // 防御性上限：避免极端配置叠加出超长等待。
    return Math.min(total, 180000);
  }

  // v1.10.9：严格卡片点击间隔调度。
  // 旧版在“整个职位处理完成（含发送、关窗）”之后才 sleep 间隔，跳过路径还会
  // 直接绕过，导致真实点击到点击的间隔 = 间隔 + 后续处理耗时 + 下一张卡片的
  // 查找与人工停顿。现在点击结束即记录下一次点击的绝对目标时间，
  // 下一张卡片点击前只补齐剩余时间，保证间隔不被额外叠加。
  function scheduleNextCardClick(config) {
    state.lastCardClickAt = Date.now();
    state.nextCardClickAt = state.lastCardClickAt +
      getIntervalMs(config.minInterval, config.maxInterval, config);
  }

  async function waitForCardClickSlot() {
    const target = state.nextCardClickAt || 0;
    if (!target) return;
    const remaining = target - Date.now();
    if (remaining > 0) await delay(remaining);
    state.nextCardClickAt = 0;
  }

  async function runLoop(config) {
    let attempts = 0;
    let emptyLoads = 0;

    while (!state.stopRequested && state.sent < config.maxJobs) {
      const currentPath = location.origin + location.pathname;
      if (currentPath !== state.startPath) {
        // 只有鱼泡的原地详情路由允许在同站点、仍属于支持页面时重新锚定。
        // 智联设置招呼语页、登录页、跨站跳转一律停止，避免在错误页面继续操作。
        const canReanchor = platform.key === 'yupao' &&
          location.hostname === state.startHost &&
          shouldActivate();
        if (!canReanchor) {
          throw makeError('PAGE_CHANGED', '页面已跳转，任务自动停止');
        }
        state.startPath = currentPath;
        log('页面路径已变化，重新锚定后继续执行');
      }

      // v1.10.12：智联结果弹窗/残留聊天窗守卫。每轮开始先清掉遮罩，
      // 避免弹窗拦截卡片点击导致流程卡死或连续跳过。
      await guardZhaopinPopup(config);

      const entry = findNextCardEntry();
      if (!entry) {
        const loaded = await tryLoadMore();
        if (loaded) {
          emptyLoads = 0;
          continue;
        }
        emptyLoads++;
        if (emptyLoads >= 2) {
          log('没有更多可处理的职位卡片，任务结束', 'warn');
          break;
        }
        continue;
      }
      let card = entry.card;
      let lastWasSkip = false;

      emptyLoads = 0;
      attempts++;
      // v1.10：关闭自动打招呼后发送数不会增长，用“已处理职位数”做上限，
      // 避免一直翻页扫完整个列表。
      // v1.10.1：改用实际已处理数（成功 + 跳过）。旧写法用 attempts 做上限，
      // 但下方 SKIP 分支的 attempts-- 会把它抵消——关闭态每个职位都抛 SKIP，
      // attempts 恒为同一值，上限判断永远不触发，实际仍会翻页扫完整个列表。
      const processedJobs = state.sent + state.skipped;
      if (config.enableGreeting === false && processedJobs >= config.maxJobs) {
        log('自动打招呼已关闭：已处理 ' + processedJobs + ' 个职位，停止', 'warn');
        break;
      }
      if (attempts > config.maxJobs * 4 + 20) {
        log('尝试次数过多，已停止', 'warn');
        break;
      }

      const key = entry.key;
      // v1.10.12：等待/渲染期间卡片可能被列表移除或重建，按 key 重新定位；
      // 定位不到时直接跳过，绝不复用旧下标去点别的职位。
      if (!card || !card.isConnected || !isRendered(card)) {
        card = await waitForLiveCard(key, 1600);
        if (!card) {
          log('职位卡片已从列表移除，跳过：' + truncate(key, 30), 'warn');
          continue;
        }
      }
      state.processed.add(key);
      if (platform.key === 'boss') {
        const normalizedKey = toPathname(key);
        if (normalizedKey) state.processed.add(normalizedKey);
      }
      const title = getJobTitle(card);
      log('定位职位（第 ' + (entry.index + 1) + '/' + entry.total + ' 条）：' +
        truncate(title || '未命名职位', 26));

      // 随机模式从预设列表随机选取；关闭随机时固定使用当前选中的预设。
      // v1.10：关闭自动打招呼时不再选取/打印预设，仅保留卡片切换与跳过流程。
      const greetingEnabled = config.enableGreeting !== false;
      let picked = null;
      const jobConfig = Object.assign({}, config, { enableGreeting: greetingEnabled });
      if (greetingEnabled) {
        picked = pickGreeting(config);
        jobConfig.greeting = picked.text;
        log('使用预设话术 ' + (picked.index + 1) + '/' + picked.total +
          (config.randomPreset ? '（随机）' : '（选中）') + '：' + truncate(picked.text, 16));
      }

      if (platform.key === 'boss') {
        // 点击后会跳转聊天页，必须先记录待处理职位与本次话术，聊天页实例据此接管。
        updateFlow({
          pendingKey: key,
          pendingTitle: title,
          greeting: picked ? picked.text : '',
          greetingEnabled: greetingEnabled,
          lastPresetIndex: picked ? picked.index : -1
        });
      }

      try {
        const outcome = await processJob(card, jobConfig);
        if (outcome && outcome.handedOff) {
          state.handedOff = true;
          log('已跳转聊天页，由聊天页实例继续发送');
          return;
        }
        state.sent++;
        state.failureStreak = 0;
        updateProgress();
        log('已发送打招呼语（' + state.sent + '/' + config.maxJobs + '）', 'ok');
      } catch (err) {
        if (err && (err.code === 'LOGIN_REQUIRED' || err.code === 'RATE_LIMIT' ||
          err.code === 'PAGE_CHANGED' || err.code === 'STOPPED' || err.code === 'DETAIL_STUCK')) {
          throw err;
        }
        const loginNow = detectLogin();
        if (loginNow) throw makeError('LOGIN_REQUIRED', '检测到登录弹窗，请先登录后再执行');
        const rateNow = detectRateLimit();
        if (rateNow) throw makeError('RATE_LIMIT', '平台提示操作频繁或已达到沟通上限，任务已停止');

        state.skipped++;
        const skipped = !!(err && err.code === 'SKIP');
        // 已沟通职位属于正常跳过，不应计入连续失败次数。
        if (skipped) {
          state.failureStreak = 0;
          attempts--; // 正常跳过不消耗重试预算，避免已沟通职位密集的列表提前触发上限。
          lastWasSkip = true;
        } else {
          state.failureStreak++;
        }
        updateProgress();
        log((skipped ? '跳过当前职位：' : '处理异常（不计为跳过）：') +
          (err && err.message ? err.message : String(err)), 'warn');
        if (!skipped) {
          try {
            await closeChat();
          } catch (ignore) {}
          if (state.failureStreak >= 5) {
            throw makeError('TOO_MANY_FAILURES', '连续 5 个职位处理失败，已停止，请检查页面结构或登录状态');
          }
          await delay(randInt(400, 900));
        }
      }

      // 关闭自动打招呼时，成功数不会增长；用“成功 + 跳过”的已处理数达标即停，
      // 并在本轮结束立即退出，不再多等一个操作间隔。
      const processedAfter = state.sent + state.skipped;
      if (config.enableGreeting === false && processedAfter >= config.maxJobs) {
        log('自动打招呼已关闭：已处理 ' + processedAfter + ' 个职位，停止', 'warn');
        break;
      }
      if (state.sent >= config.maxJobs) {
        log('已达到设定的处理数量 ' + config.maxJobs + '，自动停止循环', 'ok');
        break;
      }
      if (state.stopRequested) break;
      // v1.10.9：非跳过职位的操作间隔已改为“上次卡片点击结束 → 下次卡片点击开始”，
      // 由 processJob 在点击前按绝对目标时间补齐，这里不再重复等待。
      // 正常跳过路径仍用短延迟让出主线程。
      if (lastWasSkip) await delay(randInt(120, 260));
    }

    if (state.stopRequested) throw makeError('STOPPED', '任务已停止');
  }

  // =========================================================================
  // 区间扫描（v1.10.6）
  // 独立于原有循环：启动时只计算区间下标写入 state.scanRange，
  // 原有循环在取“下一条未处理职位”时按该范围过滤，核心流程不变。
  // 返回区间内的职位数量；未启用区间模式时返回 null。
  // =========================================================================
  function applyRangeScan(config) {
    if (!config || config.rangeEnabled !== true) {
      state.scanRange = null;
      state.scanRangeKeys = null;
      return null;
    }
    // v1.10.12：BOSS 跨页续跑时沿用启动时的职位 key 快照，
    // 不在返回后的新列表上重新按下标圈定区间。
    if (state.scanRangeKeys && state.scanRangeKeys.size) {
      const reused = state.scanRangeKeys.size;
      log('区间扫描：沿用已记录的 ' + reused + ' 个目标职位（按职位元素定位，不受列表移除影响）', 'ok');
      return reused;
    }
    const cards = collectCards();
    if (!cards.length) {
      state.scanRange = null;
      return null;
    }
    if (config.rangeStart > cards.length) {
      // 起始序号超出当前列表：置为空区间并结束本次任务。
      state.scanRange = { start: cards.length, end: cards.length - 1 };
      state.scanRangeKeys = null;
      log('区间扫描：起始序号 ' + config.rangeStart + ' 超出当前列表（共 ' +
        cards.length + ' 条），本次不处理职位', 'warn');
      return 0;
    }
    const startIndex = config.rangeStart - 1;
    const endIndex = Math.min(cards.length, config.rangeEnd) - 1;
    state.scanRange = { start: startIndex, end: endIndex };
    // 快照区间内每个职位的稳定 key：后续只按 key 命中目标职位，
    // 列表增删/重排不会改变“第 N~M 条”这一初始语义。
    const keys = [];
    for (let i = startIndex; i <= endIndex; i++) {
      let key = getJobKey(cards[i]);
      // BOSS 职位链接带易变参数，区间快照只保留 pathname，跨页续跑才能命中。
      if (platform.key === 'boss') key = toPathname(key) || key;
      if (key && keys.indexOf(key) === -1) keys.push(key);
    }
    state.scanRangeKeys = keys.length ? new Set(keys) : null;
    const count = keys.length || (endIndex - startIndex + 1);
    log('区间扫描：仅处理第 ' + (startIndex + 1) + '~' + (endIndex + 1) +
      ' 条，共 ' + count + ' 条（已按职位元素记录目标，区间外自动跳过）', 'ok');
    return count;
  }

  async function startBatch() {
    if (state.running || state.starting || !ui) return;
    if (isBossChatPage()) {
      setStatus('由列表页发起');
      log('聊天页由列表页流程自动接管，请在职位列表页点击开始', 'warn');
      return;
    }
    state.starting = true;
    state.stopRequested = false;

    const config = readAndValidateConfig();
    writeConfigToUI(config);
    persistConfig(config);

    const login = detectLogin();
    if (login) {
      state.starting = false;
      setStatus('请先登录');
      log('检测到登录弹窗，请先完成登录后再开始', 'warn');
      return;
    }

    const cards = await waitForCards(4000);
    if (!cards.length) {
      state.starting = false;
      setStatus('未找到职位');
      log('当前页面未找到职位卡片，请确认职位列表已加载', 'error');
      return;
    }

    state.running = true;
    state.starting = false;
    state.stopRequested = false;
    state.sent = 0;
    state.skipped = 0;
    state.detailSwitchFails = 0;
    state.target = config.maxJobs;
    state.failureStreak = 0;
    state.handedOff = false;
    state.lastPresetIndex = -1;
    state.startPath = location.origin + location.pathname;
    state.startHost = location.hostname;
    state.processed.clear();
    // v1.10.12：新任务不复用上一轮的区间 key 快照，启动时按当前列表重新记录。
    state.scanRangeKeys = null;
    // v1.10.9：新任务不继承上一轮的卡片点击时间。
    state.lastCardClickAt = 0;
    state.nextCardClickAt = 0;
    // v1.10.8：重置速率控制计数（随机休息点 / 动态降速倍数）。
    resetRateControl();

    // v1.10.6：先载入 BOSS 历史已操作标记，再应用区间扫描的区间外预跳过；
    // 两者都只是往 processed 集合里加 key，不改变原有循环逻辑。
    mergeBossMarks();
    const rangeCount = applyRangeScan(config);
    if (rangeCount !== null) {
      config.maxJobs = rangeCount;
      state.target = rangeCount;
    }

    if (platform.key === 'boss') {
      // 初始化跨页流程状态：聊天页实例将读取该状态继续发送。
      updateFlow({
        active: true,
        startedAt: Date.now(),
        target: config.maxJobs,
        sent: 0,
        skipped: 0,
        failStreak: 0,
        greeting: config.greeting,
        greetingEnabled: config.enableGreeting !== false,
        selectedPreset: config.selectedPreset,
        randomPreset: config.randomPreset,
        minInterval: config.minInterval,
        maxInterval: config.maxInterval,
        processedKeys: [],
        // v1.10.12：区间目标职位 key 快照随流程跨页保存，返回列表后按元素定位。
        rangeKeys: state.scanRangeKeys ? Array.from(state.scanRangeKeys) : null,
        pendingKey: null,
        pendingTitle: '',
        lastPresetIndex: -1,
        // v1.10.7：记录列表完整地址（含筛选参数）、滚动位置与自动返回开关，
        // 供聊天页发送完成后原路返回并续跑。
        listUrl: location.href,
        scrollY: Math.round(window.scrollY || 0),
        autoReturn: config.bossAutoReturn !== false,
        // v1.10.15：聊天页填入阶段沿用 BOSS 输入精确校验开关。
        bossInputStrict: config.bossInputStrict !== false,
        // v1.10.29：聊天页沿用 BOSS 会话一致性校验开关。
        bossSessionVerify: config.bossSessionVerify !== false,
        // v1.10.8：聊天页发送阶段沿用同一套速率控制开关。
        rateControl: config.rateControl !== false,
        humanize: config.humanize !== false,
        adaptiveRate: config.adaptiveRate !== false,
        // v1.10.9：卡片点击间隔目标时间随流程跨页传递。
        lastCardClickAt: 0,
        nextCardClickAt: 0
      });
    }

    syncRunningUI(true);
    setStatus('运行中');
    updateProgress();
    log('开始执行：目标 ' + config.maxJobs + ' 个职位，操作间隔 ' + config.minInterval + '~' + config.maxInterval + ' 秒', 'ok');
    if (config.rateControl !== false) {
      log('速率控制已开启：不规则随机间隔 + 周期休息' +
        (config.humanize !== false ? '；已启用人工行为模拟' : '') +
        (config.adaptiveRate !== false ? '；连续异常时自动降速' : ''), 'ok');
    } else {
      log('速率控制已关闭：仅使用基础操作间隔（防风控能力降低）', 'warn');
    }
    if (config.enableGreeting === false) {
      log('自动打招呼已关闭：仅切换职位并跳过已沟通职位，不点击沟通按钮、不填写也不发送话术', 'warn');
    }
    logUiFramework(cards[0]);

    try {
      await runLoop(config);
      if (state.sent >= config.maxJobs) {
        setStatus('已完成');
        log('任务完成：成功 ' + state.sent + '，跳过 ' + state.skipped, 'ok');
      } else {
        setStatus('已结束');
        log('任务结束：成功 ' + state.sent + '，跳过 ' + state.skipped, 'warn');
      }
    } catch (err) {
      if (err && err.code === 'LOGIN_REQUIRED') {
        setStatus('需要登录');
        log(err.message, 'error');
      } else if (err && err.code === 'RATE_LIMIT') {
        setStatus('已触发平台限制');
        log(err.message, 'error');
      } else if (err && err.code === 'PAGE_CHANGED') {
        setStatus('页面已跳转');
        log(err.message, 'warn');
      } else if (err && (err.code === 'STOPPED' || state.stopRequested)) {
        setStatus('已停止');
        log('任务已停止：成功 ' + state.sent + '，跳过 ' + state.skipped, 'warn');
      } else {
        setStatus('已停止');
        log('任务异常：' + (err && err.message ? err.message : String(err)), 'error');
      }
    } finally {
      state.running = false;
      state.starting = false;
      // 已交接到聊天页时不能清空 flow：聊天页新实例还要读取 pendingKey/话术。
      if (platform.key === 'boss' && !state.handedOff) writeFlow(null);
      syncRunningUI(false);
      updateProgress();
    }
  }

  // =========================================================================
  // BOSS 聊天页返回列表（v1.10.7）
  // 旧版仅调用 history.back()：聊天页若由 replace 或新标签页打开，标签页内
  // 没有可回退的列表历史项，页面会一直停在 /web/geek/chat。
  // 改为优先按流程记录的列表完整地址显式导航（地址自带筛选参数），
  // history.back() 只作为旧流程无地址记录时的兜底。
  // =========================================================================
  function buildBossListReturnUrl(flow) {
    const raw = flow && typeof flow.listUrl === 'string' ? flow.listUrl.trim() : '';
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      // 只允许回到同站点地址，避免流程数据异常时跳出当前平台。
      return url.origin === location.origin ? url.href : '';
    } catch (err) {
      return '';
    }
  }

  function returnToBossList(flow) {
    const target = buildBossListReturnUrl(flow);
    if (target) {
      if (target.split('#')[0] === location.href.split('#')[0]) return true;
      log('正在返回职位列表页（保留筛选条件）：' + truncate(target, 50));
      try {
        window.location.assign(target);
        return true;
      } catch (err) {
        try {
          window.location.href = target;
          return true;
        } catch (ignore) {}
      }
    }
    log('未记录列表地址，使用浏览器后退返回', 'warn');
    try {
      if (window.history && window.history.length > 1) {
        window.history.back();
        return true;
      }
    } catch (err) {}
    return false;
  }

  // 返回列表页后恢复保存的滚动位置；列表卡片尚未渲染时短暂重试，
  // 一旦新任务已经产生处理结果就停止恢复，避免抢走当前职位的位置。
  function restoreBossListScroll(flow) {
    const y = Math.round(Number(flow && flow.scrollY) || 0);
    if (!y) return;
    const baseSent = Number(flow && flow.sent) || 0;
    const baseSkipped = Number(flow && flow.skipped) || 0;
    let tries = 0;
    const tick = function () {
      if ((state.sent || 0) !== baseSent || (state.skipped || 0) !== baseSkipped) return;
      if (collectCards().length) {
        try { window.scrollTo(0, y); } catch (err) {}
        return;
      }
      if (++tries < 8) setTimeout(tick, 300);
    };
    setTimeout(tick, 150);
  }

  // v1.10.11：BOSS 聊天页目标绑定校验。
  // 旧版直接向当前打开的会话填入并发送，从未校验该会话是否属于
  // pendingKey/pendingTitle；当 BOSS 打开的是上一个职位的会话时，
  // 消息就会发给上一个职位的 HR。这里在填写/发送前强制校验：
  // 1) 聊天头部「查看职位」链接的 pathname 与目标职位一致（最精确）；
  // 2) 页面顶部出现与目标职位一致的标题短文本（兜底）。
  // 明确不匹配或无法确认时一律不发送，安全优先。
  function bossChatTargetMatches(flow) {
    if (!flow) return false;
    const pendingPath = toPathname(flow.pendingKey || '');
    const pendingTitle = norm(flow.pendingTitle || '');

    let sawHeaderLink = false;
    let links = [];
    try {
      links = document.querySelectorAll('a[href*="job_detail"]');
    } catch (err) {
      links = [];
    }
    for (let i = 0; i < links.length; i++) {
      const node = links[i];
      if (!node || !isVisible(node) || isInPanel(node)) continue;
      const text = norm(node.textContent);
      if (!text || (text.indexOf('查看职位') === -1 && text.indexOf('职位详情') === -1)) continue;
      sawHeaderLink = true;
      if (pendingPath && toPathname(node.getAttribute('href') || '') === pendingPath) return true;
    }
    if (sawHeaderLink && pendingPath) return false;

    if (pendingTitle.length >= 6) {
      // 去掉“（派遣职位）”这类括号后缀后再比对，兼容卡片标题与聊天头部
      // 标题详略不一致的情况；两侧都至少 6 字才允许包含匹配，避免“普工”
      // 这类短词误命中。
      const stripSuffix = function (value) {
        return norm(value).replace(/[（(【\[].*?[）)】\]]/g, '');
      };
      const core = stripSuffix(pendingTitle).slice(0, 14);
      let nodes = [];
      try {
        nodes = document.querySelectorAll('h1, h2, h3, span, div, a, p');
      } catch (err) {
        nodes = [];
      }
      for (let i = 0; i < nodes.length && i < 900; i++) {
        const node = nodes[i];
        if (!node || isInPanel(node) || !isVisible(node)) continue;
        let box = null;
        try {
          box = node.getBoundingClientRect();
        } catch (err) {
          box = null;
        }
        // 只认页面顶部（聊天头部），避免命中左侧列表预览或推荐位。
        if (!box || box.top > 280) continue;
        const text = stripSuffix(node.textContent);
        if (!text || text.length > 80) continue;
        if (core.length >= 6 && text.indexOf(core) !== -1) return true;
        if (text.length >= 6 && core.indexOf(text) !== -1) return true;
      }
      return false;
    }

    return false;
  }

  // v1.10.12：BOSS 聊天页输入框存在性轮询。新版聊天页可能延迟渲染，
  // 或把编辑器放在 .chat-editor 内；按候选选择器轮询，超时后返回 null，
  // 由调用方按原有的 NO_CHAT 分支处理，不改变发送逻辑。
  async function waitForBossChatInput(timeoutMs) {
    const selectors = [
      '#chat-input',
      '.chat-input',
      '.chat-editor [contenteditable="true"]',
      '.chat-input textarea',
      '.chat-editor textarea',
      '.chat-wrap [contenteditable="true"]',
      '.chat-wrap textarea'
    ];
    return waitFor(function () {
      for (let i = 0; i < selectors.length; i++) {
        let el = null;
        try {
          el = document.querySelector(selectors[i]);
        } catch (err) {
          el = null;
        }
        if (el && isVisible(el) && !isDisabled(el)) return el;
      }
      return null;
    }, timeoutMs || 9000, 250);
  }

  // =========================================================================
  // BOSS 聊天输入精确填充（v1.10.15）
  // 现象：聊天框里已有草稿/上次未发内容时，setEditorValue 的 execCommand
  // 若只追加不替换，会把预设接在旧内容后面发送。这里在写入前清空，
  // 写入后按“精确等值”校验并同步 React 状态；发送前再校验一次。
  // 全部逻辑独立实现，仅 BOSS 启用，可由面板开关关闭。
  // =========================================================================
  function clearBossChatEditor(input) {
    if (!input) return;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      try { input.value = ''; } catch (err) {}
      return;
    }
    try {
      input.innerHTML = '';
    } catch (err) {
      try { input.textContent = ''; } catch (ignore) {}
    }
  }

  function writeBossChatExact(input, text) {
    if (!input) return;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      try { input.value = text; } catch (err) {}
      return;
    }
    try {
      input.innerHTML = String(text).split('\n').map(function (line) {
        return '<p>' + (escapeHtml(line) || '<br>') + '</p>';
      }).join('');
    } catch (err) {
      try { input.textContent = text; } catch (ignore) {}
    }
  }

  function syncBossChatState(input, text) {
    if (!input) return;
    // data 置空：组件若把 event.data 追加进状态，传整段文本会重复；
    // React 受控组件统一从 target.value 读取完整值。
    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: false, inputType: 'insertText', data: null
      }));
    } catch (err) {
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (ignore) {}
    }
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (err) {}
    const props = reactFindProps(input);
    if (props && typeof props.onChange === 'function') {
      const fake = makeFakeEvent(input, 'input');
      try {
        fake.target = Object.create(input, {
          value: { value: String(text), writable: true, configurable: true }
        });
      } catch (err) {}
      try { props.onChange.call(input, fake); } catch (err) {}
    }
  }

  function bossChatContentMatches(input, text) {
    return !!input && norm(getEditorText(input)) === norm(text);
  }

  // v1.10.15：统计聊天页里“输入框之外”的目标话术出现次数（消息气泡数）。
  // 用于区分“发送失败”与“已发送但站点没有清空输入框”，避免回车重发造成重复消息。
  function bossPageGreetingCount(input, greeting) {
    const snippet = norm(greeting).slice(0, 10);
    if (!snippet) return 0;
    // contenteditable 的文本会进入 body.textContent，需要扣除输入框自身的份数；
    // textarea 的 value 不在 textContent 中，不能扣。
    const editorText = norm(getEditorText(input));
    const inputCount = input && input.isContentEditable
      ? countOccurrences(editorText, snippet)
      : 0;
    let bodyText = '';
    try {
      // textContent 不触发布局，比 innerText 更适合在发送后轮询中调用。
      bodyText = document.body ? (document.body.textContent || '') : '';
    } catch (err) {
      bodyText = '';
    }
    return Math.max(0, countOccurrences(norm(bodyText), snippet) - inputCount);
  }

  async function fillBossChatText(input, text) {
    if (!input) return false;
    const target = String(text == null ? '' : text);
    // 先清空：聊天框可能保留草稿/上次未发内容；execCommand 追加时不会叠加。
    clearBossChatEditor(input);
    await setEditorValue(input, target);
    if (bossChatContentMatches(input, target)) return true;
    // execCommand 异常或受控组件回写：精确重写并同步 React 状态。
    writeBossChatExact(input, target);
    syncBossChatState(input, target);
    await delay(120);
    if (!bossChatContentMatches(input, target)) {
      writeBossChatExact(input, target);
      syncBossChatState(input, target);
      await delay(120);
    }
    return bossChatContentMatches(input, target);
  }

  async function runBossChatPage() {
    const flow = readFlow();
    if (!flow || !flow.active || !flow.pendingKey) {
      log('聊天页待命中：自动发送需从职位列表页发起');
      return;
    }
    if (Date.now() - (flow.startedAt || 0) > FLOW_RESUME_WINDOW) {
      writeFlow(null);
      return;
    }

    syncStateFromFlow(flow);
    state.running = true;
    state.startPath = location.origin + location.pathname;
    state.startHost = location.hostname;
    syncRunningUI(true);
    setStatus('聊天页发送中');
    updateProgress();
    log('已进入聊天页：' + truncate(flow.pendingTitle || flow.pendingKey, 26));

    let flowNow = flow;
    try {
      const login = detectLogin();
      if (login) throw makeError('LOGIN_REQUIRED', '聊天页检测到登录弹窗，请先登录');

      if (flow.greetingEnabled === false) {
        // v1.10：关闭自动打招呼后，即使存在残留流程也不能在聊天页发送。
        log('自动打招呼已关闭，聊天页不发送；返回列表页继续下一个职位', 'warn');
        flowNow = updateFlow({
          skipped: (flow.skipped || 0) + 1,
          failStreak: 0,
          pendingKey: null,
          pendingTitle: '',
          processedKeys: (flow.processedKeys || []).concat([flow.pendingKey]).slice(-500)
        });
        syncStateFromFlow(flowNow);
        updateProgress();
      } else {

      // v1.10.11：填写话术前确认当前会话就是目标职位，避免发错 HR。
      // v1.10.29：校验改为可选开关（bossSessionVerify，默认开启保持原行为）；
      // 关闭后跳过一致性确认直接填入，避免详情页与列表项存在正常差异
      // （标题省略、改版文案）的职位被误跳过。
      if (flow.bossSessionVerify !== false) {
        const targetConfirmed = await waitFor(function () {
          return bossChatTargetMatches(flow) ? true : null;
        }, 3000, 250);
        if (!targetConfirmed) {
          throw makeError('TARGET_MISMATCH',
            '当前聊天会话与目标职位不一致（目标：' +
            truncate(flow.pendingTitle || flow.pendingKey || '', 24) +
            '），已停止发送以避免发错 HR');
        }
        log('已确认聊天会话为目标职位：' + truncate(flow.pendingTitle || '', 24), 'ok');
      } else {
        log('会话校验已关闭：跳过目标一致性确认，直接填入话术', 'warn');
      }

      const input = await waitForBossChatInput(9000);
      if (!input) throw makeError('NO_CHAT', '聊天页未找到输入框 #chat-input');

      log('聊天框就绪，正在填写话术');
      // v1.10.15：精确填充——先清空旧草稿/残留内容，再按精确等值校验。
      if (flow.bossInputStrict !== false) {
        const filled = await fillBossChatText(input, flow.greeting || '');
        if (!filled) {
          throw makeError('FILL_FAILED', 'BOSS 聊天输入内容与预设不一致（疑似重复填充），已停止发送');
        }
      } else {
        await setEditorValue(input, flow.greeting || '');
        const written = norm(getEditorText(input));
        if (!written) throw makeError('FILL_FAILED', '话术写入失败');
      }

      // 站点脚本可能晚于本脚本挂载 input 监听器，按钮仍禁用时补发 input 事件。
      let btn = null;
      for (let attempt = 0; attempt < 3 && !btn; attempt++) {
        btn = await waitFor(function () {
          const b = document.querySelector('.chat-op .btn-send') || document.querySelector('.btn-send');
          return b && isVisible(b) && !isDisabled(b) ? b : null;
        }, 2500, 200);
        if (!btn) {
          // 精确校验开启时用空 data 的同步事件，避免组件把整段文本再追加一次。
          if (flow.bossInputStrict !== false) syncBossChatState(input, flow.greeting || '');
          else dispatchInput(input, flow.greeting || '');
          await delay(400);
        }
      }
      if (!btn) throw makeError('SEND_DISABLED', '发送按钮不可用（话术可能未写入成功）');

      // v1.10.11：发送前再校验一次，防止填写期间会话被站点切换。
      // v1.10.29：同样受会话校验开关控制，关闭时不重复校验。
      if (flow.bossSessionVerify !== false && !bossChatTargetMatches(flow)) {
        throw makeError('TARGET_MISMATCH', '发送前会话发生切换，已取消发送以避免发错 HR');
      }
      // v1.10.15：发送前校验输入内容仍与预设完全一致，重复/追加一律不发送。
      if (flow.bossInputStrict !== false &&
        !bossChatContentMatches(input, flow.greeting || '')) {
        throw makeError('FILL_FAILED', 'BOSS 聊天输入内容与预设不一致（疑似重复填充），已停止发送');
      }

      log('点击发送');
      // v1.10.8：发送前短暂停顿并悬停按钮，模拟人工确认后点击。
      if (flow.humanize !== false) await performHumanBehavior(flow, btn);
      // v1.10.15：记录发送前的消息气泡数，用于识别“已发送但输入框未清空”。
      const bubbleBefore = flow.bossInputStrict !== false
        ? bossPageGreetingCount(input, flow.greeting || '')
        : 0;
      safeClick(btn);
      await delay(1600);

      let delivered = !input.isConnected || norm(getEditorText(input)).length === 0;
      if (!delivered && flow.bossInputStrict !== false) {
        // 输入框仍保留内容：先轮询是否出现新气泡，避免误判失败后回车重发。
        const newBubble = await waitFor(function () {
          return bossPageGreetingCount(input, flow.greeting || '') > bubbleBefore ? true : null;
        }, 1500, 200);
        if (newBubble) {
          delivered = true;
          log('输入框未清空但已出现新的消息气泡，按已发送处理，避免重复发送', 'ok');
        }
      }
      if (!delivered) {
        log('未确认发送成功，尝试回车重发', 'warn');
        pressEnter(input);
        await delay(1200);
        delivered = !input.isConnected || norm(getEditorText(input)).length === 0;
      }
      if (detectRateLimit()) {
        throw makeError('RATE_LIMIT', '平台提示操作频繁或已达到沟通上限，流程已停止');
      }
      if (!delivered) throw makeError('SEND_FAILED', '未能确认打招呼语发送成功');

      flowNow = updateFlow({
        sent: (flow.sent || 0) + 1,
        failStreak: 0,
        pendingKey: null,
        pendingTitle: '',
        processedKeys: (flow.processedKeys || []).concat([flow.pendingKey]).slice(-500)
      });
      syncStateFromFlow(flowNow);
      updateProgress();
      log('已发送打招呼语（' + flowNow.sent + '/' + flowNow.target + '）', 'ok');
      }
    } catch (err) {
      if (err && (err.code === 'LOGIN_REQUIRED' || err.code === 'RATE_LIMIT' || err.code === 'STOPPED')) {
        const cur = readFlow() || flow;
        cur.active = false;
        cur.stopReason = err.message;
        cur.lastError = (err.code || '') + ':' + (err.message || '');
        cur.pendingKey = null;
        writeFlow(cur);
        setStatus(err.code === 'LOGIN_REQUIRED' ? '需要登录' : '已触发平台限制');
        log(err.message, 'error');
        state.running = false;
        syncRunningUI(false);
        return;
      }

      const cur = readFlow() || flow;
      // v1.10.11：目标会话不一致导致的跳过并未实际发送，回滚已操作标记，
      // 让该职位下次仍可被正常处理。
      if (err && err.code === 'TARGET_MISMATCH') unmarkBossJob(flow.pendingKey);
      flowNow = updateFlow({
        skipped: (cur.skipped || 0) + 1,
        failStreak: (cur.failStreak || 0) + 1,
        pendingKey: null,
        pendingTitle: '',
        lastError: (err && (err.code || '') + ':' + (err.message || '')) || String(err),
        processedKeys: (cur.processedKeys || []).concat([flow.pendingKey]).slice(-500)
      });
      syncStateFromFlow(flowNow);
      updateProgress();
      log('聊天页处理失败，跳过：' + (err && err.message ? err.message : String(err)), 'warn');
      if ((flowNow.failStreak || 0) >= 5) {
        flowNow.active = false;
        flowNow.stopReason = '连续失败过多';
        writeFlow(flowNow);
        setStatus('已停止');
        log('连续 5 个职位处理失败，流程已停止，请检查登录状态', 'error');
        state.running = false;
        syncRunningUI(false);
        return;
      }
    }

    const latest = readFlow();
    if (!latest || !latest.active) {
      setStatus('已停止');
      state.running = false;
      syncRunningUI(false);
      updateProgress();
      return;
    }
    if ((latest.sent || 0) >= (latest.target || 0)) {
      latest.active = false;
      latest.finished = true;
      writeFlow(latest);
      setStatus('已完成');
      updateProgress();
      log('已达到设定的处理数量 ' + latest.target + '，自动停止循环', 'ok');
      log('任务完成：成功 ' + latest.sent + '，跳过 ' + latest.skipped, 'ok');
      state.running = false;
      syncRunningUI(false);
      return;
    }

    // v1.10.9：返回列表的等待时间改为“上次卡片点击结束 → 目标点击时间”的剩余值，
    // 不再在聊天页额外等待一个完整间隔，避免跨页后间隔被重复叠加。
    // 旧流程没有记录绝对时间时，退回按间隔等待。
    const clickTargetAt = Number(latest.nextCardClickAt) || 0;
    let waitMs = 0;
    if (clickTargetAt) {
      waitMs = Math.max(0, clickTargetAt - Date.now());
    } else {
      waitMs = getIntervalMs(latest.minInterval || 3, latest.maxInterval || 6, latest);
    }
    setStatus(waitMs > 0 ? '等待后返回列表' : '准备返回列表');
    if (waitMs > 0) await delay(waitMs);
    state.running = false;
    if (state.stopRequested || !(readFlow() || {}).active) {
      setStatus('已停止');
      syncRunningUI(false);
      updateProgress();
      return;
    }
    log('返回职位列表页继续下一个职位');
    syncRunningUI(false);
    if (latest.autoReturn === false) {
      setStatus('已发送，请手动返回');
      log('已关闭自动返回：请在聊天页手动返回职位列表', 'warn');
      return;
    }
    if (!returnToBossList(latest)) {
      setStatus('无法自动返回');
      log('未能自动返回职位列表，请手动返回列表页', 'error');
    }
  }

  function maybeResumeBossFlow() {
    if (platform.key !== 'boss' || isBossChatPage()) return false;
    const flow = readFlow();
    if (!flow || !flow.active || flow.pendingKey) return false;
    if (Date.now() - (flow.startedAt || 0) > FLOW_RESUME_WINDOW) {
      writeFlow(null);
      return false;
    }
    resumeBossLoop(flow);
    return true;
  }

  async function resumeBossLoop(flow) {
    if (state.running || state.starting) return;
    syncStateFromFlow(flow);
    restoreBossListScroll(flow);
    // v1.10.12：返回列表后卡片可能仍在动态渲染，先按存在性轮询等待，
    // 避免列表短暂为空时被 tryLoadMore 误判为“没有更多职位”。
    // 这里不用 waitFor（停止任务时它会抛异常），改为静默轮询。
    const listWaitStarted = Date.now();
    while (!state.stopRequested && !collectCards().length &&
      Date.now() - listWaitStarted < 6000) {
      await delay(300);
    }
    if (!collectCards().length) log('返回列表后暂未检测到职位卡片，将继续尝试加载', 'warn');
    // v1.10.8：跨页续跑时重新建立速率控制节奏（失败次数已从流程同步）。
    resetRateControl();
    state.running = true;
    state.stopRequested = false;
    state.startPath = location.origin + location.pathname;
    state.startHost = location.hostname;
    syncRunningUI(true);
    setStatus('运行中');
    updateProgress();
    log('续跑任务：已发送 ' + (flow.sent || 0) + '/' + flow.target, 'ok');

    const config = sanitizeConfig(Object.assign({}, loadConfig(), {
      maxJobs: flow.target,
      minInterval: flow.minInterval,
      maxInterval: flow.maxInterval
    }));

    // v1.10.6：返回列表页续跑时重新应用区间，保证跨页后仍只处理指定区间。
    // v1.10.12：优先恢复启动时的 key 快照；列表已移除部分职位也不会重新圈错区间。
    state.scanRangeKeys = Array.isArray(flow.rangeKeys) && flow.rangeKeys.length
      ? new Set(flow.rangeKeys)
      : null;
    const rangeCount = applyRangeScan(config);
    if (rangeCount !== null) {
      config.maxJobs = rangeCount;
      state.target = rangeCount;
      updateFlow({
        target: rangeCount,
        rangeKeys: state.scanRangeKeys ? Array.from(state.scanRangeKeys) : null
      });
    }

    try {
      await runLoop(config);
      // v1.10.12：本次是跳转聊天页交接，流程必须继续保持 active，
      // 聊天页新实例还要读取 pendingKey 才能发送。旧版在这里直接标记
      // finished，导致从第 2 个职位起聊天页只显示“待命中”而不发送。
      if (state.handedOff) {
        log('已跳转聊天页，由聊天页实例继续发送');
        return;
      }
      const f = readFlow();
      if (f && f.active) {
        f.active = false;
        f.finished = true;
        writeFlow(f);
      }
      setStatus('已结束');
      log('任务结束：成功 ' + state.sent + '，跳过 ' + state.skipped, 'warn');
    } catch (err) {
      if (err && err.code === 'LOGIN_REQUIRED') {
        setStatus('需要登录');
        log(err.message, 'error');
      } else if (err && err.code === 'RATE_LIMIT') {
        setStatus('已触发平台限制');
        log(err.message, 'error');
      } else if (err && (err.code === 'STOPPED' || state.stopRequested)) {
        setStatus('已停止');
        log('任务已停止：成功 ' + state.sent + '，跳过 ' + state.skipped, 'warn');
      } else {
        setStatus('已停止');
        log('任务异常：' + (err && err.message ? err.message : String(err)), 'error');
      }
      const f = readFlow();
      if (f && f.active && err && err.code !== 'STOPPED') {
        f.active = false;
        f.stopReason = err.message || '任务异常';
        writeFlow(f);
      }
    } finally {
      state.running = false;
      syncRunningUI(false);
      updateProgress();
    }
  }

  // =========================================================================
  // 配置读写
  // =========================================================================
  function sanitizeConfig(source) {
    const input = source && typeof source === 'object' ? source : {};
    const config = Object.assign({}, DEFAULT_CONFIG, input);

    let presets = null;
    if (Array.isArray(input.presets)) {
      presets = input.presets;
    } else if (input.greeting) {
      // 兼容旧版单条 greeting 配置，迁移为一条预设。
      presets = [input.greeting];
    }
    if (!Array.isArray(presets)) presets = config.presets;
    const seenPreset = new Set();
    presets = presets.map(function (item) {
      return String(item == null ? '' : item).trim().slice(0, 500);
    }).filter(function (item) {
      // 用 Set 去重（保留首次出现顺序）：旧配置/手工导入可能带重复话术。
      if (!item || seenPreset.has(item)) return false;
      seenPreset.add(item);
      return true;
    });
    if (!presets.length) {
      presets = [String(config.greeting || '').trim() || DEFAULT_GREETING];
    }
    config.presets = presets.slice(0, 50);
    const selected = parseInt(input.selectedPreset, 10);
    const maxPresetIndex = config.presets.length - 1;
    config.selectedPreset = isFinite(selected)
      ? Math.max(0, Math.min(maxPresetIndex, selected))
      : 0;
    config.greeting = config.presets[config.selectedPreset];
    config.randomPreset = input.randomPreset === false ? false : true;
    // v1.10：自动打招呼总开关，默认开启；只有显式 false 才关闭。
    config.enableGreeting = input.enableGreeting === false ? false : true;

    // v1.10.6：区间扫描配置。起始序号最小 1，结束序号不小于起始序号；
    // 非法值回退到默认区间，保证启动时不会出现负下标或空区间。
    config.rangeEnabled = input.rangeEnabled === true;
    const rangeStart = parseInt(input.rangeStart, 10);
    config.rangeStart = isFinite(rangeStart) ? Math.max(1, Math.min(500, rangeStart)) : DEFAULT_CONFIG.rangeStart;
    const rangeEnd = parseInt(input.rangeEnd, 10);
    config.rangeEnd = isFinite(rangeEnd)
      ? Math.max(config.rangeStart, Math.min(500, rangeEnd))
      : Math.max(config.rangeStart, DEFAULT_CONFIG.rangeEnd);

    // v1.10.7：BOSS 聊天页自动返回开关，默认开启；只有显式 false 才关闭。
    config.bossAutoReturn = input.bossAutoReturn === false ? false : true;

    // v1.10.12：智联弹窗自动关闭开关，默认开启；只有显式 false 才关闭。
    config.zhaopinAutoClose = input.zhaopinAutoClose === false ? false : true;

    // v1.10.13：鱼泡输入同步增强开关，默认开启；只有显式 false 才关闭。
    config.yupaoInputFix = input.yupaoInputFix === false ? false : true;

    // v1.10.15：BOSS 输入精确校验开关，默认开启；只有显式 false 才关闭。
    config.bossInputStrict = input.bossInputStrict === false ? false : true;

    // v1.10.29：BOSS 会话一致性校验开关，默认开启；只有显式 false 才关闭。
    config.bossSessionVerify = input.bossSessionVerify === false ? false : true;

    // v1.10.8：速率控制开关，默认全部开启；只有显式 false 才关闭。
    config.rateControl = input.rateControl === false ? false : true;
    config.humanize = input.humanize === false ? false : true;
    config.adaptiveRate = input.adaptiveRate === false ? false : true;

    const jobs = parseInt(config.maxJobs, 10);
    config.maxJobs = isFinite(jobs) ? Math.max(1, Math.min(200, jobs)) : DEFAULT_CONFIG.maxJobs;

    const min = parseFloat(config.minInterval);
    const max = parseFloat(config.maxInterval);
    config.minInterval = isFinite(min) ? Math.max(1, Math.min(120, min)) : DEFAULT_CONFIG.minInterval;
    // 兜底值也必须不小于 min：旧写法在 min=120、max 非法时会得到 max=6。
    const maxValue = isFinite(max) ? Math.min(120, max) : DEFAULT_CONFIG.maxInterval;
    config.maxInterval = Math.max(config.minInterval, maxValue);
    return config;
  }

  function loadConfig() {
    const saved = readStoredJSON(STORAGE_KEY);
    return sanitizeConfig(saved && typeof saved === 'object' ? saved : {});
  }

  function persistConfig(config) {
    const value = sanitizeConfig(config);
    // GM 中保持对象（与旧版一致），localStorage 兜底时写入 JSON 字符串。
    writeStoredValue(STORAGE_KEY, value, JSON.stringify(value));
  }

  function readAndValidateConfig() {
    if (!ui) return sanitizeConfig({});
    const maxJobs = parseInt(ui.maxJobs.value, 10);
    const minInterval = parseFloat(ui.minInterval.value);
    const maxInterval = parseFloat(ui.maxInterval.value);
    // v1.10.6：循环模式与区间模式互斥，同一时间只认一个。
    // 面板交互会保证两个开关只有一项勾选；这里以区间开关为准，
    // 都未勾选时自然回到循环模式。
    const rangeMode = ui.rangeMode ? ui.rangeMode.checked : false;
    return sanitizeConfig({
      presets: uiPresets.slice(),
      selectedPreset: uiSelectedPreset,
      randomPreset: ui.randomPreset ? ui.randomPreset.checked : true,
      enableGreeting: ui.enableGreeting ? ui.enableGreeting.checked : true,
      rangeEnabled: rangeMode,
      rangeStart: ui.rangeStart ? parseInt(ui.rangeStart.value, 10) : DEFAULT_CONFIG.rangeStart,
      rangeEnd: ui.rangeEnd ? parseInt(ui.rangeEnd.value, 10) : DEFAULT_CONFIG.rangeEnd,
      bossAutoReturn: ui.bossAutoReturn ? ui.bossAutoReturn.checked : true,
      bossInputStrict: ui.bossInputStrict ? ui.bossInputStrict.checked : true,
      bossSessionVerify: ui.bossSessionVerify ? ui.bossSessionVerify.checked : true,
      zhaopinAutoClose: ui.zhaopinAutoClose ? ui.zhaopinAutoClose.checked : true,
      yupaoInputFix: ui.yupaoInputFix ? ui.yupaoInputFix.checked : true,
      rateControl: ui.rateControl ? ui.rateControl.checked : true,
      humanize: ui.humanize ? ui.humanize.checked : true,
      adaptiveRate: ui.adaptiveRate ? ui.adaptiveRate.checked : true,
      maxJobs: maxJobs,
      minInterval: minInterval,
      maxInterval: maxInterval
    });
  }

  function writeConfigToUI(config) {
    if (!ui) return;
    uiPresets = config.presets.slice();
    uiSelectedPreset = config.selectedPreset;
    if (ui.randomPreset) ui.randomPreset.checked = config.randomPreset;
    if (ui.enableGreeting) ui.enableGreeting.checked = config.enableGreeting !== false;
    if (ui.loopMode) ui.loopMode.checked = config.rangeEnabled !== true;
    if (ui.rangeMode) ui.rangeMode.checked = config.rangeEnabled === true;
    if (ui.rangeStart) ui.rangeStart.value = config.rangeStart;
    if (ui.rangeEnd) ui.rangeEnd.value = config.rangeEnd;
    if (ui.bossAutoReturn) ui.bossAutoReturn.checked = config.bossAutoReturn !== false;
    if (ui.bossInputStrict) ui.bossInputStrict.checked = config.bossInputStrict !== false;
    if (ui.bossSessionVerify) ui.bossSessionVerify.checked = config.bossSessionVerify !== false;
    if (ui.zhaopinAutoClose) ui.zhaopinAutoClose.checked = config.zhaopinAutoClose !== false;
    if (ui.yupaoInputFix) ui.yupaoInputFix.checked = config.yupaoInputFix !== false;
    if (ui.rateControl) ui.rateControl.checked = config.rateControl !== false;
    if (ui.humanize) ui.humanize.checked = config.humanize !== false;
    if (ui.adaptiveRate) ui.adaptiveRate.checked = config.adaptiveRate !== false;
    renderPresets();
    if (ui.newPreset) ui.newPreset.value = '';
    ui.maxJobs.value = config.maxJobs;
    ui.minInterval.value = config.minInterval;
    ui.maxInterval.value = config.maxInterval;
    syncScanModeUI();
  }

  function pickGreeting(config) {
    const list = (config.presets && config.presets.length)
      ? config.presets
      : [config.greeting || DEFAULT_GREETING];
    const selected = parseInt(config.selectedPreset, 10);
    let index = isFinite(selected)
      ? Math.max(0, Math.min(list.length - 1, selected))
      : 0;
    if (config.randomPreset && list.length > 1) {
      index = randInt(0, list.length - 1);
      // 避免连续两次使用同一条预设，保证循环发送时内容有变化。
      if (index === state.lastPresetIndex) {
        index = (index + 1) % list.length;
      }
    }
    state.lastPresetIndex = index;
    return { text: list[index], index: index, total: list.length };
  }

  function renderPresets() {
    if (!ui || !ui.presetList) return;
    if (!uiPresets.length) uiPresets = [DEFAULT_GREETING];
    uiSelectedPreset = Math.max(0, Math.min(uiPresets.length - 1, uiSelectedPreset));
    ui.presetList.innerHTML = '';

    uiPresets.forEach(function (text, index) {
      const selected = index === uiSelectedPreset;
      const item = document.createElement('div');
      item.className = 'jd-preset' + (selected ? ' selected' : '');
      item.title = state.running ? '任务运行中不可切换' : '点击选择这条打招呼语';
      item.addEventListener('click', function (event) {
        if (state.running) return;
        if (event.target && event.target.closest && event.target.closest('.jd-preset-del')) return;
        selectPreset(index);
      });

      const content = document.createElement('div');
      content.className = 'jd-preset-text';
      content.textContent = text;

      if (selected) {
        const badge = document.createElement('span');
        badge.className = 'jd-preset-badge';
        badge.textContent = '使用中';
        item.appendChild(badge);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'jd-preset-del';
      remove.textContent = '删除';
      remove.title = '删除该预设';
      remove.disabled = state.running;
      remove.addEventListener('click', function (event) {
        event.stopPropagation();
        deletePreset(index);
      });

      // v1.10.31：编辑按钮（与删除并列；阻止冒泡，避免顺带切换选中条目）。
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'jd-preset-edit';
      edit.textContent = '编辑';
      edit.title = '编辑该预设';
      edit.disabled = state.running;
      edit.addEventListener('click', function (event) {
        event.stopPropagation();
        openPresetEditor(index);
      });

      item.insertBefore(content, item.firstChild);
      item.appendChild(remove);
      item.insertBefore(edit, remove);
      ui.presetList.appendChild(item);
    });

    const random = !!(ui.randomPreset && ui.randomPreset.checked);
    if (ui.presetCount) {
      ui.presetCount.textContent = '共 ' + uiPresets.length + ' 条 · ' +
        (random
          ? '循环时随机选取'
          : '当前使用第 ' + (uiSelectedPreset + 1) + ' 条');
    }
    // v1.10.10：核心区用紧凑下拉框选择话术，完整管理列表收纳在折叠面板中。
    if (ui.presetSelect) {
      const select = ui.presetSelect;
      select.innerHTML = '';
      uiPresets.forEach(function (text, index) {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = '第 ' + (index + 1) + ' 条 · ' + truncate(text, 28);
        select.appendChild(option);
      });
      select.value = String(uiSelectedPreset);
      select.disabled = state.running;
    }
  }

  function selectPreset(index) {
    if (!ui || state.running) return;
    if (index < 0 || index >= uiPresets.length) return;
    uiSelectedPreset = index;
    // 用户主动选择时关闭随机，确保选中的模板立即生效。
    if (ui.randomPreset) ui.randomPreset.checked = false;
    const config = readAndValidateConfig();
    persistConfig(config);
    renderPresets();
    log('已选择第 ' + (index + 1) + ' 条预设话术，循环时固定使用', 'ok');
  }

  function addPreset(value) {
    const text = String(value || '').trim();
    if (!text) {
      log('请输入要添加的打招呼语', 'warn');
      if (ui && ui.newPreset) ui.newPreset.focus();
      return;
    }
    if (uiPresets.length >= 50) {
      log('预设最多保留 50 条', 'warn');
      return;
    }
    if (uiPresets.indexOf(text) !== -1) {
      log('该打招呼语已存在，未重复添加', 'warn');
      return;
    }
    uiPresets.push(text.slice(0, 500));
    const config = readAndValidateConfig();
    persistConfig(config);
    if (ui && ui.newPreset) ui.newPreset.value = '';
    renderPresets();
    log('已添加预设话术（共 ' + uiPresets.length + ' 条）', 'ok');
  }

  function deletePreset(index) {
    if (index < 0 || index >= uiPresets.length) return;
    if (uiPresets.length <= 1) {
      log('至少保留一条预设话术', 'warn');
      return;
    }
    uiPresets.splice(index, 1);
    if (uiSelectedPreset > index) {
      uiSelectedPreset--;
    } else if (uiSelectedPreset >= uiPresets.length) {
      uiSelectedPreset = uiPresets.length - 1;
    }
    if (uiSelectedPreset < 0) uiSelectedPreset = 0;
    const config = readAndValidateConfig();
    persistConfig(config);
    renderPresets();
    log('已删除一条预设话术（剩余 ' + uiPresets.length + ' 条）', 'ok');
  }

  // =========================================================================
  // v1.10.31：预设话术编辑（仅“管理预设话术”模块）
  // 交互与校验完全对齐 addPreset：trim、500 字截断、重复拒绝、50 条上限不变，
  // 保存仍走 readAndValidateConfig + persistConfig + renderPresets 原链路。
  // =========================================================================
  let editingPresetIndex = -1;

  function openPresetEditor(index) {
    if (!ui || !ui.editMask || !ui.editText) return;
    if (state.running) return;
    if (index < 0 || index >= uiPresets.length) return;
    editingPresetIndex = index;
    ui.editText.value = uiPresets[index];
    ui.editMask.hidden = false;
    ui.editText.focus();
    try {
      ui.editText.setSelectionRange(0, ui.editText.value.length);
    } catch (err) {
      // 部分环境不支持选区操作，忽略即可。
    }
  }

  function closePresetEditor() {
    editingPresetIndex = -1;
    if (ui && ui.editMask) ui.editMask.hidden = true;
    if (ui && ui.editText) ui.editText.value = '';
  }

  function savePresetEdit() {
    if (!ui || !ui.editText) return;
    if (state.running) return;
    const index = editingPresetIndex;
    if (index < 0 || index >= uiPresets.length) {
      closePresetEditor();
      return;
    }
    const text = String(ui.editText.value || '').trim();
    if (!text) {
      log('请输入要保存的打招呼语', 'warn');
      ui.editText.focus();
      return;
    }
    const next = text.slice(0, 500);
    const existsAt = uiPresets.indexOf(next);
    if (existsAt !== -1 && existsAt !== index) {
      log('该打招呼语已存在，未保存', 'warn');
      return;
    }
    if (next === uiPresets[index]) {
      closePresetEditor();
      return;
    }
    uiPresets[index] = next;
    const config = readAndValidateConfig();
    persistConfig(config);
    closePresetEditor();
    renderPresets();
    log('已更新第 ' + (index + 1) + ' 条预设话术（共 ' + uiPresets.length + ' 条）', 'ok');
  }

  // =========================================================================
  // v1.10.32：启动结构自检（仅手动按钮触发，纯只读探测）
  // 逐项检查当前平台锚点是否命中，复用 log() 输出「锚点名 ✓（命中数）/ ✗ /
  // — 不适用」，末尾汇总「结构自检 N/M 通过」，失败项各配一句「可能坏在哪层」。
  // 只做 DOM 查询：不点击、不输入、不发送、不滚动、不弹窗；waitFor* 系列
  // 带轮询语义一律不调用，仅调用纯查询函数与平台常量锚点。
  // =========================================================================
  function selfCheckHitCount(selectors, root) {
    const scope = root || document;
    const seen = new Set();
    for (let i = 0; i < selectors.length; i++) {
      try {
        // 多个选择器命中同一节点时只计一次，保证「命中数」真实。
        const nodes = scope.querySelectorAll(selectors[i]);
        for (let n = 0; n < nodes.length; n++) seen.add(nodes[n]);
      } catch (err) {
        // 忽略选择器异常。
      }
    }
    return seen.size;
  }

  function selfCheckFirstMatch(selectors, root) {
    const scope = root || document;
    for (let i = 0; i < selectors.length; i++) {
      try {
        const node = scope.querySelector(selectors[i]);
        if (node) return node;
      } catch (err) {
        // 忽略选择器异常。
      }
    }
    return null;
  }

  // 探测表：when 决定该项在当前页面状态下是否适用——
  //   list  职位列表页（shouldActivate 且非 BOSS 聊天页）
  //   chat  BOSS 聊天页（isBossChatPage）
  //   panel 聊天面板/抽屉已打开（findChatPanel 命中）
  //   popup 智联结果弹窗 DOM 已挂载（发送后才出现，未出现 ≠ 结构失配）
  // check(cards, panel) 返回 { ok, text, tip }；返回 null 表示当前状态不适用。
  const SELF_CHECK_PROBES = {
    boss: [
      { name: '职位卡片列表', when: 'list',
        check: function (cards) {
          const count = cards.length;
          return count
            ? { ok: true, text: count + ' 张' }
            : { ok: false, tip: '→ 整个流程无法定位职位，多为页面结构改版或非标准列表页' };
        } },
      { name: '卡片点击目标', when: 'list',
        check: function (cards) {
          if (!cards.length) return null;
          const hits = selfCheckHitCount(platform.cardClickTargets, cards[0]);
          return hits
            ? { ok: true, text: hits + ' 个候选' }
            : { ok: false, tip: '→ 卡片点击退化为整卡点击，详情切换可能失败' };
        } },
      { name: '沟通按钮锚点', when: 'list',
        check: function (cards) {
          if (!cards.length) return null;
          return findActionButton(cards[0])
            ? { ok: true, text: '已命中' }
            : { ok: false, tip: '→ 可能详情面板未展示（点一张卡片后再自检）或按钮锚点已改版' };
        } },
      { name: '详情面板锚点', when: 'list',
        check: function () {
          return findDetailPanelRoot()
            ? { ok: true, text: '已命中' }
            : { ok: false, tip: '→ 详情切换与校验会失败' };
        } },
      { name: '聊天输入框', when: 'chat',
        check: function () {
          const hits = selfCheckHitCount(platform.inputSelectors);
          return hits
            ? { ok: true, text: hits + ' 个候选' }
            : { ok: false, tip: '→ 聊天页无法填写话术' };
        } }
    ],
    zhaopin: [
      { name: '职位卡片列表', when: 'list',
        check: function (cards) {
          return cards.length
            ? { ok: true, text: cards.length + ' 张' }
            : { ok: false, tip: '→ 整个流程无法定位职位，多为页面结构改版或非标准列表页' };
        } },
      { name: '沟通按钮锚点', when: 'list',
        check: function (cards) {
          if (!cards.length) return null;
          // 智联为 detail 作用域，findActionButton 允许文档级查找。
          return findActionButton(cards[0])
            ? { ok: true, text: '已命中' }
            : { ok: false, tip: '→ 可能详情面板未展示（点一张卡片后再自检）或按钮锚点已改版' };
        } },
      { name: '聊天输入框', when: 'panel',
        check: function (cards, panel) {
          const hits = selfCheckHitCount(platform.inputSelectors, panel);
          return hits
            ? { ok: true, text: hits + ' 个候选' }
            : { ok: false, tip: '→ 聊天抽屉内无法填写话术' };
        } },
      { name: '结果弹窗结构锚点', when: 'popup',
        check: function () {
          const boxes = selfCheckHitCount(
            ['.deliver-greeting-modal__box', '[class*="deliver-greeting-modal__box"]']);
          if (!boxes) return null;
          const closes = selfCheckHitCount([
            '.deliver-greeting-modal__close', '[class*="deliver-greeting-modal__close"]',
            'button[aria-label="关闭"]'
          ]);
          return closes
            ? { ok: true, text: '结果框 ' + boxes + ' + 关闭按钮 ' + closes }
            : { ok: false, tip: '→ 弹窗「×」锚点失配 → 自动关闭退化为「留在」文字与 Esc 兜底' };
        } }
    ],
    yupao: [
      { name: '职位卡片收集（含 extra/leading 补收）', when: 'list',
        check: function (cards) {
          const extra = collectYupaoExtraCards(cards).length;
          const leading = collectYupaoLeadingCards(cards).length;
          if (!cards.length && !extra && !leading) {
            return { ok: false, tip: '→ 整个流程无法定位职位，多为页面结构改版或非标准列表页' };
          }
          return { ok: true, text: '主收集 ' + cards.length + ' + extra ' + extra + ' + leading ' + leading };
        } },
      { name: '可编辑节点', when: 'panel',
        check: function (cards, panel) {
          const hits = selfCheckHitCount(platform.inputSelectors, panel);
          return hits
            ? { ok: true, text: hits + ' 个候选' }
            : { ok: false, tip: '→ 聊天抽屉内无法填写话术' };
        } },
      { name: '计数器锚点', when: 'panel',
        check: function (cards, panel) {
          const input = selfCheckFirstMatch(platform.inputSelectors, panel);
          if (!input) return { ok: false, tip: '→ 编辑器未找到 → 计数器同步判断失效' };
          const current = yupaoCounterText(input);
          return current >= 0
            ? { ok: true, text: '已渲染，当前值 ' + current }
            : { ok: false, tip: '→ 计数器锚点失配 → 0/300 同步判断会失效' };
        } },
      { name: '发送按钮', when: 'panel',
        check: function (cards, panel) {
          const input = selfCheckFirstMatch(platform.inputSelectors, panel);
          return findSendButton(panel, input, true)
            ? { ok: true, text: '已命中' }
            : { ok: false, tip: '→ 话术写入后无法点击发送（配合计数器项排查）' };
        } }
    ]
  };

  function runStructureSelfCheck() {
    if (!ui) return;
    const onChat = isBossChatPage();
    const onList = !onChat && shouldActivate();
    const panel = findChatPanel();
    const cards = collectCards();
    const probes = SELF_CHECK_PROBES[platform.key] || [];
    const stateNames = {
      list: '当前非职位列表页',
      chat: '仅 BOSS 聊天页可探测',
      panel: '聊天面板未打开——点一次沟通按钮后再自检',
      popup: '当前页面无结果弹窗——发送后才会出现'
    };
    log('开始结构自检：' + platform.name + ' · ' +
      (onChat ? '聊天页' : (onList ? '职位列表页' : '其他页面')) +
      '（只读探测，不点击不发送）');
    let passed = 0;
    let failed = 0;
    for (let i = 0; i < probes.length; i++) {
      const item = probes[i];
      const applies = item.when === 'list' ? onList :
        item.when === 'chat' ? onChat :
        item.when === 'panel' ? !!panel :
        item.when === 'popup' ? selfCheckHitCount(
          ['[class*="deliver-greeting-modal"]']) > 0 : false;
      if (!applies) {
        log('  ' + item.name + ' — 不适用（' + stateNames[item.when] + '）');
        continue;
      }
      let result = null;
      try {
        result = item.check(cards, panel);
      } catch (err) {
        result = { ok: false, tip: '→ 探测自身异常：' + (err && err.message ? err.message : String(err)) };
      }
      if (!result) {
        log('  ' + item.name + ' — 不适用（' + stateNames[item.when] + '）');
        continue;
      }
      if (result.ok) {
        passed++;
        log('  ' + item.name + ' ✓（' + (result.text || '命中') + '）', 'ok');
      } else {
        failed++;
        log('  ' + item.name + ' ✗' + (result.tip ? ' ' + result.tip : ''), 'warn');
      }
    }
    log('结构自检 ' + passed + '/' + (passed + failed) + ' 通过' +
      (failed ? '（✗ 项见上方分层提示）' : '，全部锚点正常'), failed ? 'warn' : 'ok');
  }

  // =========================================================================
  // 面板 UI
  // =========================================================================
  const PANEL_CSS = [
    ':host{all:initial;}',
    '*{box-sizing:border-box;}',
    '.jd-wrap{width:340px;max-width:calc(100vw - 24px);background:#fff;color:#0f172a;border-radius:14px;',
    'box-shadow:0 12px 36px rgba(15,23,42,.22),0 2px 8px rgba(15,23,42,.12);overflow:hidden;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.5;}',
    '.jd-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#0f172a;color:#fff;',
    'cursor:move;user-select:none;touch-action:none;}',
    '.jd-title{display:flex;align-items:center;gap:7px;font-weight:600;font-size:13px;}',
    '.jd-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18);flex:none;}',
    '.jd-platform{font-size:11px;font-weight:500;color:#bbf7d0;background:rgba(34,197,94,.14);padding:1px 6px;border-radius:999px;}',
    '.jd-icon{width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:#cbd5e1;cursor:pointer;',
    'font-size:16px;line-height:1;padding:0;}',
    '.jd-icon:hover{background:rgba(255,255,255,.1);color:#fff;}',
    '.jd-body{padding:10px;max-height:calc(100vh - 96px);overflow:auto;}',
    '.jd-field{display:block;margin-bottom:8px;}',
    '.jd-label{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;color:#334155;font-weight:600;font-size:12px;}',
    '.jd-hint{color:#94a3b8;font-weight:400;font-size:11px;}',
    // v1.10.10：折叠分组，非核心设置默认收起，减少默认占用。
    '.jd-group{margin:0 0 8px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;overflow:hidden;}',
    '.jd-group>summary{list-style:none;cursor:pointer;padding:7px 10px;color:#334155;font-size:12px;font-weight:600;',
    'display:flex;align-items:center;justify-content:space-between;user-select:none;}',
    '.jd-group>summary::-webkit-details-marker{display:none;}',
    '.jd-group>summary::after{content:"▸";color:#94a3b8;font-size:11px;}',
    '.jd-group[open]>summary::after{content:"▾";}',
    '.jd-group-body{padding:0 10px 8px;border-top:1px solid #eef2f7;}',
    '.jd-group-body .jd-field{margin-top:8px;margin-bottom:8px;}',
    '.jd-group-body .jd-field:last-child{margin-bottom:0;}',
    '.jd-select{height:30px;padding:2px 6px;cursor:pointer;}',
    '.jd-inline-hint{margin:-2px 0 8px;}',
    '.jd-preset-list{display:flex;flex-direction:column;gap:6px;max-height:120px;overflow:auto;margin-bottom:6px;}',
    '.jd-preset{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border:1px solid #e2e8f0;border-radius:8px;',
    'background:#f8fafc;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s;}',
    '.jd-preset:hover{border-color:#cbd5e1;background:#f1f5f9;}',
    '.jd-preset.selected{border-color:#16a34a;background:#f0fdf4;box-shadow:0 0 0 2px rgba(22,163,74,.12);}',
    '.jd-preset.selected:hover{border-color:#16a34a;background:#f0fdf4;}',
    '.jd-preset-badge{flex:none;align-self:center;font-size:10px;line-height:1.4;color:#15803d;background:#dcfce7;',
    'border-radius:999px;padding:1px 6px;white-space:nowrap;}',
    '.jd-preset-text{flex:1;min-width:0;font-size:12px;color:#334155;white-space:pre-wrap;word-break:break-word;}',
    '.jd-preset-del{flex:none;border:0;border-radius:6px;background:#fef2f2;color:#b91c1c;padding:3px 7px;font-size:11px;cursor:pointer;}',
    '.jd-preset-del:hover:not(:disabled){background:#fee2e2;}',
    '.jd-preset-del:disabled{opacity:.55;cursor:not-allowed;}',
    // v1.10.31：预设话术编辑按钮与编辑弹窗（仅管理预设话术模块）。
    '.jd-preset-edit{flex:none;border:0;border-radius:6px;background:#eff6ff;color:#1d4ed8;padding:3px 7px;font-size:11px;cursor:pointer;}',
    '.jd-preset-edit:hover:not(:disabled){background:#dbeafe;}',
    '.jd-preset-edit:disabled{opacity:.55;cursor:not-allowed;}',
    '.jd-modal-mask{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:2147483001;}',
    '.jd-modal-mask[hidden]{display:none;}',
    '.jd-modal{width:320px;max-width:100%;background:#fff;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;',
    'box-shadow:0 16px 40px rgba(15,23,42,.28);}',
    '.jd-modal-title{font-size:12px;font-weight:600;color:#334155;}',
    '.jd-modal .jd-textarea{min-height:96px;max-height:220px;}',
    '.jd-modal-actions{display:flex;justify-content:flex-end;gap:8px;}',
    '.jd-modal-actions .jd-btn{flex:none;height:30px;padding:0 14px;}',
    '.jd-preset-actions{display:flex;align-items:center;gap:10px;margin-bottom:4px;}',
    '.jd-preset-actions .jd-btn{flex:none;height:30px;padding:0 12px;}',
    '.jd-check{display:flex;align-items:center;gap:5px;color:#475569;font-size:12px;cursor:pointer;}',
    '.jd-check input{accent-color:#16a34a;}',
    '.jd-scan-row{display:flex;align-items:center;gap:6px;margin-top:6px;color:#64748b;font-size:12px;}',
    '.jd-scan-row .jd-input{width:60px;flex:none;height:28px;padding:2px 6px;}',
    '.jd-textarea,.jd-input{width:100%;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#0f172a;',
    'font:inherit;outline:none;transition:border-color .15s,box-shadow .15s;}',
    '.jd-textarea{padding:8px;resize:vertical;min-height:76px;max-height:160px;}',
    '.jd-textarea:focus,.jd-input:focus{border-color:#16a34a;background:#fff;box-shadow:0 0 0 3px rgba(22,163,74,.12);}',
    '.jd-textarea:disabled,.jd-input:disabled{opacity:.7;cursor:not-allowed;}',
    '.jd-row{display:flex;gap:10px;}',
    '.jd-half{flex:1;min-width:0;}',
    '.jd-range{display:flex;align-items:center;gap:5px;color:#64748b;}',
    '.jd-input{height:30px;padding:4px 7px;}',
    '.jd-actions{display:flex;gap:6px;margin-top:2px;}',
    '.jd-btn{flex:1;height:32px;border:1px solid transparent;border-radius:8px;cursor:pointer;font:inherit;font-weight:600;font-size:12px;}',
    '.jd-btn:disabled{opacity:.55;cursor:not-allowed;}',
    '.jd-ghost{background:#f1f5f9;border-color:#e2e8f0;color:#334155;}',
    '.jd-ghost:hover:not(:disabled){background:#e2e8f0;}',
    '.jd-primary{background:#16a34a;color:#fff;}',
    '.jd-primary:hover:not(:disabled){background:#15803d;}',
    '.jd-danger{background:#fef2f2;border-color:#fecaca;color:#b91c1c;}',
    '.jd-danger:hover:not(:disabled){background:#fee2e2;}',
    '.jd-status{display:flex;justify-content:space-between;gap:8px;margin-top:8px;padding:5px 8px;border-radius:7px;',
    'background:#f8fafc;color:#475569;font-size:12px;}',
    '.jd-status span:last-child{color:#16a34a;font-weight:600;white-space:nowrap;}',
    '.jd-log{margin-top:6px;max-height:96px;overflow:auto;border-radius:7px;background:#0f172a;padding:5px 8px;',
    'color:#cbd5e1;font:11px/1.5 Consolas,Monaco,monospace;}',
    '.jd-log:empty{display:none;}',
    '.jd-log .line{white-space:pre-wrap;word-break:break-word;}',
    '.jd-log .ok{color:#86efac;}',
    '.jd-log .warn{color:#fde68a;}',
    '.jd-log .error{color:#fca5a5;}',
    '.jd-wrap.collapsed{width:210px;}',
    '.jd-wrap.collapsed .jd-body{display:none;}',
    '@media (max-width:480px){.jd-wrap{width:calc(100vw - 24px);}}'
  ].join('');

  const PANEL_HTML = [
    '<div class="jd-wrap" id="jdWrap">',
    '  <div class="jd-head" id="jdHead">',
    '    <div class="jd-title">',
    '      <span class="jd-dot"></span>',
    '      <span>自动沟通助手</span>',
    '      <span class="jd-platform" id="jdPlatform"></span>',
    '    </div>',
    '    <button class="jd-icon" id="jdCollapse" type="button" title="收起面板">−</button>',
    '  </div>',
    '  <div class="jd-body" id="jdBody">',
    '    <div class="jd-field">',
    '      <div class="jd-label">当前话术 <span class="jd-hint" id="jdPresetCount"></span></div>',
    '      <select id="jdPresetSelect" class="jd-input jd-select"></select>',
    '    </div>',
    '    <details class="jd-group" id="jdPresetGroup">',
    '      <summary>管理预设话术</summary>',
    '      <div class="jd-group-body">',
    '        <div class="jd-preset-list" id="jdPresetList"></div>',
    '        <textarea id="jdNewPreset" class="jd-textarea" rows="3" spellcheck="false" placeholder="输入新的打招呼语，点击下方“添加预设”"></textarea>',
    '        <div class="jd-preset-actions">',
    '          <button id="jdAddPreset" class="jd-btn jd-ghost" type="button">添加预设</button>',
    '          <label class="jd-check"><input id="jdRandomPreset" type="checkbox"> <span>循环时随机使用</span></label>',
    '        </div>',
    '      </div>',
    '    </details>',
    '    <div class="jd-field">',
    '      <label class="jd-check"><input id="jdEnableGreeting" type="checkbox" checked> <span>启用自动打招呼</span></label>',
    '      <div class="jd-hint">关闭后只切换/跳过职位，不点击沟通、不发送话术</div>',
    '    </div>',
    '    <div class="jd-row">',
    '      <label class="jd-field jd-half">处理数量',
    '        <input id="jdMaxJobs" class="jd-input" type="number" min="1" max="200" step="1">',
    '      </label>',
    '      <label class="jd-field jd-half">操作间隔（秒）',
    '        <div class="jd-range">',
    '          <input id="jdMinInterval" class="jd-input" type="number" min="1" max="120" step="1">',
    '          <span>~</span>',
    '          <input id="jdMaxInterval" class="jd-input" type="number" min="1" max="120" step="1">',
    '        </div>',
    '      </label>',
    '    </div>',
    '    <div class="jd-hint jd-inline-hint">间隔按「上一张卡片点击结束 → 下一张卡片点击开始」计算；建议 ≥3 秒并先登录</div>',
    '    <details class="jd-group" id="jdMoreGroup">',
    '      <summary>更多设置（扫描范围 / 平台适配 / 速率控制）</summary>',
    '      <div class="jd-group-body">',
    '        <div class="jd-field">',
    '          <div class="jd-label">扫描范围 <span class="jd-hint">循环 / 区间互斥</span></div>',
    '          <label class="jd-check"><input id="jdLoopMode" type="checkbox" checked> <span>循环模式（按处理数量）</span></label>',
    '          <label class="jd-check"><input id="jdRangeMode" type="checkbox"> <span>区间模式（指定起始 / 结束序号）</span></label>',
    '          <div class="jd-scan-row">',
    '            <span>第</span><input id="jdRangeStart" class="jd-input" type="number" min="1" max="500" step="1">',
    '            <span>条 ~ 第</span><input id="jdRangeEnd" class="jd-input" type="number" min="1" max="500" step="1">',
    '            <span>条</span>',
    '          </div>',
    '        </div>',
    '        <div class="jd-field" id="jdBossReturnField">',
    '          <label class="jd-check"><input id="jdBossAutoReturn" type="checkbox" checked> <span>BOSS 聊天页发送后自动返回列表</span></label>',
    '          <div class="jd-hint">按原列表地址返回，保留筛选条件并恢复滚动位置</div>',
    '        </div>',
    '        <div class="jd-field" id="jdBossStrictField">',
    '          <label class="jd-check"><input id="jdBossInputStrict" type="checkbox" checked> <span>BOSS 输入精确校验</span></label>',
    '          <div class="jd-hint">填入前清除草稿/残留内容，发送前校验与预设完全一致，防止重复追加</div>',
    '        </div>',
    '        <div class="jd-field" id="jdBossVerifyField">',
    '          <label class="jd-check"><input id="jdBossSessionVerify" type="checkbox" checked> <span>BOSS 会话与职位校验</span></label>',
    '          <div class="jd-hint">填写/发送前校验当前会话与目标职位一致；详情页与列表项存在差异被误跳过时可关闭</div>',
    '        </div>',
    '        <div class="jd-field" id="jdZhaopinField">',
    '          <label class="jd-check"><input id="jdZhaopinAutoClose" type="checkbox" checked> <span>智联弹窗自动关闭（兜底）</span></label>',
    '          <div class="jd-hint">每轮开始前清理残留的「已向对方发送打招呼」弹窗；发送当次仍会自动关闭</div>',
    '        </div>',
    '        <div class="jd-field" id="jdYupaoField">',
    '          <label class="jd-check"><input id="jdYupaoInputFix" type="checkbox" checked> <span>鱼泡输入同步增强</span></label>',
    '          <div class="jd-hint">补发 input/change/keyup 并直调组件处理器，解决输入后 0/300、发送按钮置灰</div>',
    '        </div>',
    '        <div class="jd-field">',
    '          <div class="jd-label">速率控制（防风控） <span class="jd-hint">建议全部开启</span></div>',
    '          <label class="jd-check"><input id="jdRateControl" type="checkbox" checked> <span>平滑速率控制（不规则间隔 + 周期休息）</span></label>',
    '          <label class="jd-check"><input id="jdHumanize" type="checkbox" checked> <span>模拟人工操作（悬停 / 微滚动 / 停顿）</span></label>',
    '          <label class="jd-check"><input id="jdAdaptiveRate" type="checkbox" checked> <span>动态降速（连续异常后自动拉长间隔）</span></label>',
    '        </div>',
    '        <div class="jd-field">',
    '          <button id="jdSelfCheck" class="jd-btn jd-ghost" type="button">结构自检</button>',
    '          <div class="jd-hint">只读探测当前页面锚点：不点击、不输入、不发送；结果输出到下方日志</div>',
    '        </div>',
    '      </div>',
    '    </details>',
    '    <div class="jd-actions">',
    '      <button id="jdSave" class="jd-btn jd-ghost" type="button">保存配置</button>',
    '      <button id="jdStart" class="jd-btn jd-primary" type="button">开始</button>',
    '      <button id="jdStop" class="jd-btn jd-danger" type="button" disabled>停止</button>',
    '    </div>',
    '    <div class="jd-status">',
    '      <span id="jdStatus">就绪</span>',
    '      <span id="jdProgress">0 / 0</span>',
    '    </div>',
    '    <div class="jd-log" id="jdLog"></div>',
    // v1.10.31：预设话术编辑弹窗（默认隐藏，点条目「编辑」打开）。
    '    <div class="jd-modal-mask" id="jdEditMask" hidden>',
    '      <div class="jd-modal" role="dialog" aria-modal="true">',
    '        <div class="jd-modal-title">编辑预设话术</div>',
    '        <textarea id="jdEditPreset" class="jd-textarea" rows="4" spellcheck="false" placeholder="修改后点击“保存”"></textarea>',
    '        <div class="jd-modal-actions">',
    '          <button id="jdEditCancel" class="jd-btn jd-ghost" type="button">取消</button>',
    '          <button id="jdEditSave" class="jd-btn jd-primary" type="button">保存</button>',
    '        </div>',
    '      </div>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('');

  function log(message, type) {
    // 仅写入面板日志，不向 console 输出，避免依赖开发者工具。
    if (!ui || !ui.logEl) return;
    const line = document.createElement('div');
    line.className = 'line' + (type ? ' ' + type : '');
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    line.textContent = '[' + time + '] ' + message;
    ui.logEl.appendChild(line);
    while (ui.logEl.children.length > 60) {
      ui.logEl.removeChild(ui.logEl.firstChild);
    }
    ui.logEl.scrollTop = ui.logEl.scrollHeight;
  }

  function setStatus(text) {
    if (ui && ui.status) ui.status.textContent = text;
  }

  function updateProgress() {
    if (!ui || !ui.progress) return;
    const target = state.target || 0;
    ui.progress.textContent = state.sent + ' / ' + target + (state.skipped ? ' · 跳过 ' + state.skipped : '');
  }

  // v1.10.6：循环 / 区间两个开关互斥，且区间输入框只在区间模式下可编辑。
  function syncScanModeUI() {
    if (!ui) return;
    const rangeOn = !!(ui.rangeMode && ui.rangeMode.checked);
    if (ui.loopMode) ui.loopMode.disabled = state.running;
    if (ui.rangeMode) ui.rangeMode.disabled = state.running;
    if (ui.maxJobs) ui.maxJobs.disabled = state.running || rangeOn;
    if (ui.rangeStart) ui.rangeStart.disabled = state.running || !rangeOn;
    if (ui.rangeEnd) ui.rangeEnd.disabled = state.running || !rangeOn;
  }

  function syncRunningUI(running) {
    if (!ui) return;
    [ui.newPreset, ui.addPreset, ui.randomPreset, ui.presetSelect, ui.enableGreeting, ui.bossAutoReturn, ui.bossInputStrict, ui.bossSessionVerify, ui.zhaopinAutoClose, ui.yupaoInputFix, ui.rateControl, ui.humanize, ui.adaptiveRate, ui.maxJobs, ui.minInterval, ui.maxInterval, ui.save].forEach(function (el) {
      if (el) el.disabled = running;
    });
    if (ui.start) ui.start.disabled = running;
    if (ui.stop) ui.stop.disabled = !running;
    syncScanModeUI();
    renderPresets();
  }

  function mountUI() {
    if (!document.body || document.getElementById(HOST_ID)) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;display:block;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = PANEL_HTML;

    let styled = false;
    try {
      if (typeof CSSStyleSheet === 'function') {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(PANEL_CSS);
        shadow.adoptedStyleSheets = [sheet];
        styled = true;
      }
    } catch (err) {
      styled = false;
    }
    if (!styled) {
      const style = document.createElement('style');
      style.textContent = PANEL_CSS;
      shadow.appendChild(style);
    }

    document.body.appendChild(host);

    function get(id) {
      return shadow.querySelector('#' + id);
    }

    ui = {
      host: host,
      wrap: get('jdWrap'),
      head: get('jdHead'),
      presetList: get('jdPresetList'),
      presetSelect: get('jdPresetSelect'),
      newPreset: get('jdNewPreset'),
      addPreset: get('jdAddPreset'),
      editMask: get('jdEditMask'),
      editText: get('jdEditPreset'),
      editSave: get('jdEditSave'),
      editCancel: get('jdEditCancel'),
      selfCheck: get('jdSelfCheck'),
      randomPreset: get('jdRandomPreset'),
      enableGreeting: get('jdEnableGreeting'),
      loopMode: get('jdLoopMode'),
      rangeMode: get('jdRangeMode'),
      rangeStart: get('jdRangeStart'),
      rangeEnd: get('jdRangeEnd'),
      bossAutoReturn: get('jdBossAutoReturn'),
      bossReturnField: get('jdBossReturnField'),
      bossInputStrict: get('jdBossInputStrict'),
      bossStrictField: get('jdBossStrictField'),
      bossVerifyField: get('jdBossVerifyField'),
      bossSessionVerify: get('jdBossSessionVerify'),
      zhaopinAutoClose: get('jdZhaopinAutoClose'),
      zhaopinField: get('jdZhaopinField'),
      yupaoInputFix: get('jdYupaoInputFix'),
      yupaoField: get('jdYupaoField'),
      rateControl: get('jdRateControl'),
      humanize: get('jdHumanize'),
      adaptiveRate: get('jdAdaptiveRate'),
      presetCount: get('jdPresetCount'),
      maxJobs: get('jdMaxJobs'),
      minInterval: get('jdMinInterval'),
      maxInterval: get('jdMaxInterval'),
      save: get('jdSave'),
      start: get('jdStart'),
      stop: get('jdStop'),
      status: get('jdStatus'),
      progress: get('jdProgress'),
      logEl: get('jdLog'),
      platform: get('jdPlatform'),
      collapse: get('jdCollapse')
    };

    if (ui.platform) ui.platform.textContent = platform.name;
    // 自动返回开关仅对 BOSS 有意义，其他平台隐藏，避免误解。
    if (ui.bossReturnField && platform.key !== 'boss') ui.bossReturnField.style.display = 'none';
    // BOSS 输入精确校验仅对 BOSS 有意义，其他平台隐藏。
    if (ui.bossStrictField && platform.key !== 'boss') ui.bossStrictField.style.display = 'none';
    // v1.10.29：BOSS 会话一致性校验仅对 BOSS 有意义，其他平台隐藏。
    if (ui.bossVerifyField && platform.key !== 'boss') ui.bossVerifyField.style.display = 'none';
    // 智联弹窗开关仅对智联有意义，其他平台隐藏。
    if (ui.zhaopinField && platform.key !== 'zhaopin') ui.zhaopinField.style.display = 'none';
    // 鱼泡输入同步开关仅对鱼泡有意义，其他平台隐藏。
    if (ui.yupaoField && platform.key !== 'yupao') ui.yupaoField.style.display = 'none';
    writeConfigToUI(loadConfig());
    updateProgress();
    setStatus('就绪');

    if (ui.addPreset) {
      ui.addPreset.addEventListener('click', function () {
        addPreset(ui.newPreset ? ui.newPreset.value : '');
      });
    }
    if (ui.newPreset) {
      ui.newPreset.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          addPreset(ui.newPreset.value);
        }
      });
    }
    // v1.10.31：预设话术编辑弹窗（保存 / 取消 / 快捷键 / 点遮罩关闭）。
    if (ui.editSave) ui.editSave.addEventListener('click', savePresetEdit);
    if (ui.editCancel) ui.editCancel.addEventListener('click', closePresetEditor);
    if (ui.editText) {
      ui.editText.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          savePresetEdit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closePresetEditor();
        }
      });
    }
    if (ui.editMask) {
      ui.editMask.addEventListener('click', function (event) {
        if (event.target === ui.editMask) closePresetEditor();
      });
    }
    // v1.10.32：启动结构自检按钮（纯只读探测，运行中也可执行）。
    if (ui.selfCheck) {
      ui.selfCheck.addEventListener('click', function () {
        runStructureSelfCheck();
      });
    }
    if (ui.presetSelect) {
      ui.presetSelect.addEventListener('change', function () {
        selectPreset(parseInt(ui.presetSelect.value, 10));
      });
    }
    if (ui.enableGreeting) {
      ui.enableGreeting.addEventListener('change', function () {
        const config = readAndValidateConfig();
        persistConfig(config);
        log(ui.enableGreeting.checked
          ? '自动打招呼已开启：将点击沟通按钮并发送话术'
          : '自动打招呼已关闭：仅切换职位并跳过已沟通职位，不会点击沟通按钮或发送', 'warn');
      });
    }
    if (ui.bossAutoReturn) {
      ui.bossAutoReturn.addEventListener('change', function () {
        const config = readAndValidateConfig();
        persistConfig(config);
        log(ui.bossAutoReturn.checked
          ? 'BOSS 聊天页发送后将自动返回职位列表页（保留筛选与滚动位置）'
          : 'BOSS 聊天页发送后将停留在聊天页，请手动返回列表', 'ok');
      });
    }
    // v1.10.15：BOSS 输入精确校验开关即时保存并回显。
    if (ui.bossInputStrict) {
      ui.bossInputStrict.addEventListener('change', function () {
        const config = readAndValidateConfig();
        persistConfig(config);
        log(ui.bossInputStrict.checked
          ? 'BOSS 输入精确校验已开启：填入前清空旧内容，发送前校验与预设完全一致'
          : 'BOSS 输入精确校验已关闭：聊天框有草稿时可能追加旧内容',
        ui.bossInputStrict.checked ? 'ok' : 'warn');
      });
    }
    // v1.10.29：BOSS 会话一致性校验开关即时保存并回显。
    if (ui.bossSessionVerify) {
      ui.bossSessionVerify.addEventListener('change', function () {
        const config = readAndValidateConfig();
        persistConfig(config);
        log(ui.bossSessionVerify.checked
          ? 'BOSS 会话校验已开启：填写/发送前校验当前会话与目标职位一致'
          : 'BOSS 会话校验已关闭：跳过会话一致性确认，直接填入发送（存在发错会话风险）',
        ui.bossSessionVerify.checked ? 'ok' : 'warn');
      });
    }
    // v1.10.12：智联弹窗自动关闭开关即时保存并回显。
    if (ui.zhaopinAutoClose) {
      ui.zhaopinAutoClose.addEventListener('change', function () {
        const config = readAndValidateConfig();
        persistConfig(config);
        log(ui.zhaopinAutoClose.checked
          ? '智联弹窗自动关闭已开启：结果弹窗会自动点「留在此页」'
          : '智联弹窗自动关闭已关闭：结果弹窗保持原样，需手动关闭',
        ui.zhaopinAutoClose.checked ? 'ok' : 'warn');
      });
    }
    // v1.10.13：鱼泡输入同步开关即时保存并回显。
    if (ui.yupaoInputFix) {
      ui.yupaoInputFix.addEventListener('change', function () {
        const config = readAndValidateConfig();
        persistConfig(config);
        log(ui.yupaoInputFix.checked
          ? '鱼泡输入同步已开启：补发完整输入事件并直调组件处理器'
          : '鱼泡输入同步已关闭：仅使用基础写入方式，可能出现 0/300 与发送置灰',
        ui.yupaoInputFix.checked ? 'ok' : 'warn');
      });
    }
    // v1.10.8：速率控制开关即时保存并回显当前生效策略。
    function onRateControlChange() {
      const config = readAndValidateConfig();
      persistConfig(config);
      log('速率控制已更新：' + (config.rateControl ? '平滑间隔' : '基础间隔') +
        ' / ' + (config.humanize ? '人工模拟' : '无人工模拟') +
        ' / ' + (config.adaptiveRate ? '动态降速' : '固定速度'), 'ok');
    }
    [ui.rateControl, ui.humanize, ui.adaptiveRate].forEach(function (el) {
      if (!el) return;
      el.addEventListener('change', onRateControlChange);
    });
    if (ui.randomPreset) {
      ui.randomPreset.addEventListener('change', function () {
        const config = readAndValidateConfig();
        persistConfig(config);
        renderPresets();
        log(ui.randomPreset.checked
          ? '循环模式已开启随机预设'
          : '循环模式将固定使用第 ' + (uiSelectedPreset + 1) + ' 条预设', 'ok');
      });
    }

    // v1.10.6：循环模式 / 区间模式互斥。勾选一项时自动取消另一项，
    // 并立即保存到配置，避免运行时出现两个模式同时生效。
    function onScanModeChange(source) {
      if (!ui) return;
      if (source === 'range') {
        if (ui.rangeMode.checked && ui.loopMode) ui.loopMode.checked = false;
        if (!ui.rangeMode.checked && ui.loopMode) ui.loopMode.checked = true;
      } else {
        if (ui.loopMode.checked && ui.rangeMode) ui.rangeMode.checked = false;
        if (!ui.loopMode.checked && ui.rangeMode) ui.rangeMode.checked = true;
      }
      syncScanModeUI();
      const config = readAndValidateConfig();
      persistConfig(config);
      log(config.rangeEnabled
        ? '区间模式已开启：仅处理第 ' + config.rangeStart + '~' + config.rangeEnd + ' 条职位'
        : '循环模式已开启：按处理数量从列表当前位置依次处理', 'ok');
    }

    if (ui.loopMode) {
      ui.loopMode.addEventListener('change', function () {
        onScanModeChange('loop');
      });
    }
    if (ui.rangeMode) {
      ui.rangeMode.addEventListener('change', function () {
        onScanModeChange('range');
      });
    }
    [ui.rangeStart, ui.rangeEnd].forEach(function (el) {
      if (!el) return;
      el.addEventListener('change', function () {
        const config = readAndValidateConfig();
        writeConfigToUI(config);
        persistConfig(config);
        log('区间范围已保存：第 ' + config.rangeStart + '~' + config.rangeEnd + ' 条', 'ok');
      });
    });

    if (ui.save) {
      ui.save.addEventListener('click', function () {
        const config = readAndValidateConfig();
        writeConfigToUI(config);
        persistConfig(config);
        log('配置已保存', 'ok');
        setStatus('配置已保存');
        setTimeout(function () {
          if (!state.running) setStatus('就绪');
        }, 1800);
      });
    }

    if (ui.start) {
      ui.start.addEventListener('click', function () {
        startBatch().catch(function (err) {
          state.starting = false;
          state.running = false;
          syncRunningUI(false);
          log('启动失败：' + (err && err.message ? err.message : String(err)), 'error');
        });
      });
    }

    if (ui.stop) {
      ui.stop.addEventListener('click', function () {
        if (!state.running || state.stopRequested) return;
        state.stopRequested = true;
        stopBossFlow();
        setStatus('正在停止');
        if (ui.stop) ui.stop.disabled = true;
        log('已请求停止，将在当前步骤结束后退出', 'warn');
      });
    }

    if (ui.collapse) {
      ui.collapse.addEventListener('click', function () {
        const collapsed = ui.wrap.classList.toggle('collapsed');
        ui.collapse.textContent = collapsed ? '+' : '−';
        ui.collapse.title = collapsed ? '展开面板' : '收起面板';
      });
    }

    // 拖动面板
    let drag = null;
    if (ui.head) {
      ui.head.addEventListener('pointerdown', function (event) {
        if (event.target.closest('button')) return;
        const rect = host.getBoundingClientRect();
        drag = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: rect.left,
          top: rect.top
        };
        host.style.left = rect.left + 'px';
        host.style.top = rect.top + 'px';
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        try {
          ui.head.setPointerCapture(event.pointerId);
        } catch (err) {}
        event.preventDefault();
      });

      ui.head.addEventListener('pointermove', function (event) {
        if (!drag || event.pointerId !== drag.id) return;
        const rect = host.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;
        const left = Math.min(Math.max(8, drag.left + event.clientX - drag.x), window.innerWidth - width - 8);
        const top = Math.min(Math.max(8, drag.top + event.clientY - drag.y), window.innerHeight - height - 8);
        host.style.left = left + 'px';
        host.style.top = top + 'px';
      });

      ui.head.addEventListener('pointerup', function (event) {
        if (!drag) return;
        try {
          ui.head.releasePointerCapture(event.pointerId);
        } catch (err) {}
        drag = null;
      });

      // pointercancel 时同样释放捕获，避免拖动状态和指针捕获悬挂。
      ui.head.addEventListener('pointercancel', function (event) {
        if (!drag) return;
        try {
          ui.head.releasePointerCapture(event.pointerId);
        } catch (err) {}
        drag = null;
      });
    }

    // 阻止面板内的操作冒泡到招聘网站，避免误触站点快捷键或关闭弹窗。
    host.addEventListener('click', function (event) {
      event.stopPropagation();
    });
    host.addEventListener('pointerdown', function (event) {
      event.stopPropagation();
    });
    host.addEventListener('keydown', function (event) {
      event.stopPropagation();
    });
  }

  // =========================================================================
  // 启动与菜单
  // =========================================================================
  function startWatcher() {
    if (watcherStarted) return;
    watcherStarted = true;
    setInterval(function () {
      if (!document.body) return;
      if (shouldActivate()) {
        if (!document.getElementById(HOST_ID)) {
          if (state.running) state.stopRequested = true;
          mountUI();
        }
      } else if (state.running && (
        location.hostname !== state.startHost ||
        (platform.key === 'zhaopin' && isZhaopinGreetingSettingsPage())
      )) {
        state.stopRequested = true;
        stopBossFlow();
        log('已离开职位列表页，任务停止', 'warn');
      }
    }, 2500);
  }

  // 诊断导出：把关键区域的真实 DOM 结构落成文件，替代被反爬封锁的控制台。
  // F12 / Ctrl+S 都被鱼泡拦截，但脚本运行在页面内部，不受这些拦截影响。
  function dumpPageStructure() {
    try {
      const parts = [];
      parts.push('URL: ' + location.href);
      parts.push('时间: ' + new Date().toLocaleString('zh-CN', { hour12: false }));
      parts.push('脚本版本: ' + ((typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) || 'unknown'));
      let framework = '未知';
      let node = collectCards()[0] || document.body;
      for (let i = 0; i < 6 && node; i++) {
        if (reactFindProps(node)) { framework = 'React'; break; }
        if (node.__vueParentComponent) { framework = 'Vue'; break; }
        if (node._vei) { framework = 'Vue(_vei)'; break; }
        if (node.__vue__) { framework = 'Vue2'; break; }
        node = node.parentElement;
      }
      parts.push('框架探测: ' + framework);
      const clip = function (el, limit) {
        if (!el) return '（未找到）';
        let html = '';
        try { html = el.outerHTML || ''; } catch (err) { html = ''; }
        if (html.length > limit) html = html.slice(0, limit) + '\n<!-- ...已截断，共 ' + html.length + ' 字符... -->';
        return html;
      };
      const cards = collectCards();
      parts.push('\n===== 职位卡片（第 1 张）=====\n' + clip(cards[0] || null, 2500));
      parts.push('\n===== 详情面板 =====\n' + clip(findDetailRoot(), 4500));
      parts.push('\n===== 聊天面板（未打开则为空）=====\n' + clip(findChatPanel(), 4500));
      parts.push('\n===== 可输入元素清单 =====');
      const editors = collectEditors();
      if (!editors.length) parts.push('（无）');
      editors.slice(0, 10).forEach(function (el, idx) {
        parts.push(idx + 1 + '. <' + el.tagName + '> class=' + (el.className || '') +
          ' contenteditable=' + el.getAttribute('contenteditable') +
          ' placeholder=' + (el.getAttribute('placeholder') || '') +
          ' text长度=' + (getEditorText(el) || '').length);
      });
      const sendBtn = findClickableByText(document, ['发送'], { partial: false, exclude: ['发送验证码', '发送简历'] });
      parts.push('\n===== 「发送」按钮候选 =====\n' + clip(sendBtn, 800));

      // v1.10.2：点击绑定探测——报告卡片向上 6 层 / 向下 60 个子级上的
      // 框架事件绑定键分布，合成点击无效时据此判定直调通道是否可用。
      parts.push('\n===== 点击绑定探测（卡片向上 6 层 + 向下 60 个子级）=====');
      try {
        const probeCard = cards[0];
        const describeProbe = function (n) {
          let cls = '';
          try { cls = typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/)[0] : ''; } catch (err) { cls = ''; }
          const keys = [];
          if (n._vei) keys.push('_vei[' + Object.keys(n._vei).join(',') + ']');
          if (n.__vueParentComponent) keys.push('__vueParentComponent');
          if (n.__vue__) keys.push('__vue__');
          if (reactFindProps(n)) keys.push('reactProps');
          return '<' + String(n.tagName).toLowerCase() + cls + '> ' + (keys.length ? keys.join(' ') : '（无绑定键）');
        };
        if (!probeCard) {
          parts.push('（未找到职位卡片，无法探测）');
        } else {
          let foundAny = false;
          let up = probeCard;
          for (let i = 0; i < 6 && up && up !== document.body; i++) {
            const line = describeProbe(up);
            if (line.indexOf('（无绑定键）') === -1) { foundAny = true; parts.push('↑第' + i + '层 ' + line); }
            up = up.parentElement;
          }
          let inside;
          try { inside = probeCard.querySelectorAll('div, a, span, li, button'); } catch (err) { inside = []; }
          let scanned = 0;
          for (let i = 0; i < inside.length && scanned < 60; i++) {
            const n = inside[i];
            scanned++;
            const line = describeProbe(n);
            if (line.indexOf('（无绑定键）') === -1) { foundAny = true; parts.push('↓' + line); }
          }
          parts.push('子级已扫描 ' + scanned + ' 个。');
          if (!foundAny) parts.push('结论：卡片周边未发现任何框架绑定键——事件极可能以原生 addEventListener 命令式绑定（直调不可达），需走事件拦截方案。');
        }
      } catch (err) {
        parts.push('探测异常：' + (err && err.message ? err.message : err));
      }

      const blob = new Blob([parts.join('\n')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'yupao-dom-' + Date.now() + '.txt';
      document.body.appendChild(link);
      try { link.click(); } catch (err) {}
      setTimeout(function () {
        try { document.body.removeChild(link); URL.revokeObjectURL(url); } catch (err) {}
      }, 2000);
      if (ui && ui.logEl) log('页面结构已导出为下载文件，请发给助手分析', 'ok');
    } catch (err) {
      if (ui && ui.logEl) log('导出失败：' + (err && err.message ? err.message : err), 'error');
    }
  }

  function registerMenuCommands() {
    try {
      if (typeof GM_registerMenuCommand !== 'function') return;
      GM_registerMenuCommand('显示 / 隐藏自动沟通面板', function () {
        const host = document.getElementById(HOST_ID);
        if (host) {
          host.style.display = host.style.display === 'none' ? 'block' : 'none';
        } else {
          mountUI();
        }
      });
      GM_registerMenuCommand('导出页面结构（诊断）', dumpPageStructure);
      GM_registerMenuCommand('恢复默认预设话术', function () {
        if (!ui || !ui.presetList) return;
        uiPresets = DEFAULT_PRESETS.slice();
        uiSelectedPreset = 0;
        const config = readAndValidateConfig();
        writeConfigToUI(config);
        persistConfig(config);
        log('已恢复默认预设话术（共 ' + uiPresets.length + ' 条）', 'ok');
      });
    } catch (err) {
      // 忽略菜单注册异常。
    }
  }

  function boot() {
    if (!document.body) return;
    registerMenuCommands();
    if (shouldActivate()) {
      mountUI();
      if (isBossChatPage()) {
        // 聊天页：由列表页发起的流程自动接管发送。
        runBossChatPage();
      } else {
        // 列表页：若存在未完成的跨页流程（如从聊天页返回），自动续跑。
        maybeResumeBossFlow();
      }
    }
    startWatcher();
  }

  if (document.body) {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  }

  // bfcache 恢复：history.back() 可能还原旧页面实例，其异步流程已过期。
  // 停掉旧流程，按存储中的最新状态重新接管。
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    if (platform.key !== 'boss') return;
    state.stopRequested = true;
    setTimeout(function () {
      state.stopRequested = false;
      state.running = false;
      state.starting = false;
      if (ui) syncRunningUI(false);
      if (isBossChatPage()) {
        runBossChatPage();
      } else {
        maybeResumeBossFlow();
      }
    }, 350);
  });
})();
