# CHANGELOG

## [Result Strategy + JD Headless Fix] - 2026-08-13

### 新增 (Added)
- **候选范围策略**: 支持“每个平台各取 N 条”和“全平台按置信度取前 N 条”，范围 1–50。
- **平台查询明细**: 展示每个平台数据来源、原始返回数、最终入选数和错误原因，零结果不再静默消失。

### 修复 (Fixed)
- **京东无头搜索恢复**: 移除无头浏览器 UA 中的 `HeadlessChrome` 显式指纹，并将“访问频繁”识别为风控而非普通零结果。

### 验证 (Verified)
- 43 项自动化测试通过。
- 京东真实无头查询恢复返回 20 条实时商品，完成前 5 条详情核验且未弹出浏览器窗口。

---

## [Phase 4 MVP] - MISUMI China Catalog - 2026-08-13

### 新增 (Added)
- **米思米中国适配器**: 使用无头 Playwright 通过官网 WAF，提取品牌、产品系列、未税起价、发货日和详情链接。
- **目录系列可信标记**: 米思米搜索结果明确标为系列级 `POSSIBLE`，不把系列最低价冒充完整订购型号价格。
- **米思米登录态**: 独立 Profile 可见登录，后台查询保持无头；未公开价格时返回登录提示。
- **四平台闭环**: 1688、淘宝/天猫、京东、米思米支持统一查询、状态、排序、历史和 Excel。

### 修复 (Fixed)
- **京东后台查询**: 京东登录仍使用可见窗口，搜索与商品详情改为 `headless=new`，不再展示浏览过程。

### 验证 (Verified)
- 39 项自动化测试通过。
- 真实米思米无头查询返回 12 个 SKF 相关目录系列；京东无头查询在无登录态时正确返回 `JD_LOGIN_REQUIRED`，未弹出浏览器窗口。

---

## [Phase 3 MVP] - Keyword Mode + JD - 2026-08-13

### 新增 (Added)
- **双查询模式**: 新增关键词搜索；原“工业品牌 + 完整型号”继续执行严格型号/后缀匹配。
- **关键词相关性**: 按关键词片段覆盖率分为 HIGH / POSSIBLE / MISMATCH，不套用工业型号判定规则。
- **京东适配器**: 复用浏览器签名搜索 API，识别登录墙、验证码、广告，并对前 5 个高相关商品补充详情。
- **京东店铺识别**: 详情核验后区分京东自营、第三方店和官方旗舰店；未核验时明确标记待确认。
- **查询历史与 Excel**: 保存查询模式及关键词，导出文件按实际查询内容命名。
- **结果排序**: 页面结果支持按置信分、平台、价格升序或降序排列。

### 修复 (Fixed)
- **京东 Windows 登录启动**: 将 Chrome 可执行路径规范成 Windows 原生格式，修复带空格正斜杠路径导致的 `WinError 2`。

### 验证 (Verified)
- 32 项自动化测试通过，覆盖关键词匹配、京东实时转换、登录墙降级、三平台 Mock API、Windows Chrome 路径与结果排序控件。

---

## [Phase 2 MVP] - Taobao/Tmall Multi-Platform Loop - 2026-08-13

### 新增 (Added)
- **淘宝/天猫搜索适配器**: 复用 `cn-scraper-mcp` 的 MTOP 搜索引擎，转换为统一报价 Schema，并接入型号匹配、数据库和 Excel 导出。搜索列表价统一标记为需确认目标 SKU。
- **淘宝登录闭环**: 独立 Playwright Profile 人工登录，自动保存本地 Cookie 到被 Git 忽略的 `cookies/taobao.json`。
- **多平台并行调度**: 1688 与淘宝/天猫并行查询，分别返回数据来源、登录状态、错误码和结果数量。
- **多平台界面**: 平台可勾选，新增淘宝/天猫登录入口及逐平台实时/离线状态提示。
- **可信降级**: 缺少 Cookie、会话过期或 MTOP 异常时明确标记离线样本，不伪装成实时结果。
- **淘宝详情核验**: 从商品详情提取真实店铺名称和 `sellerType`，可靠区分淘宝店/天猫店；不再根据标题或店名猜测平台类型。
- **目标 SKU 实价**: 解析 `skuBase` 与 `skuCore`，唯一命中目标型号时返回 SKU 实价、库存和发货时间；组合规格价格不唯一时继续标记待确认。
- **搜索乱码修复**: 自动修复 MTOP 搜索响应中 GB18030 被误当作 Latin-1 的商品标题。

### 验证 (Verified)
- 22 项自动化测试通过，覆盖淘宝适配、详情字段解析、店型判定、目标 SKU 唯一性、乱码修复、登录态缺失、统一转换、多平台 API 和登录 Cookie 原子写入。
- 使用本机登录态完成真实淘宝查询：14 条结果均获取真实店名和店型，5 条唯一命中目标 SKU；接口在前端 60 秒限时内返回。
- 浏览器端验证 1688 + 淘宝/天猫联合查询、结果分组和状态展示无控制台错误。

---

## [Phase 1 Complete] - 1688 Single-Platform Minimal Loop - 2026-08-12

### 新增 (Added)
- **1688 平台适配器**: [`adapters/alibaba1688_adapter.py`](file:///d:/code/bijia/adapters/alibaba1688_adapter.py)，接入 `1688-cli`，支持 B2B 品牌型号检索、SKU 价格展开、数量阶梯价计算与供应商信息抽取。
- **数据库持久化**: [`backend/database.py`](file:///d:/code/bijia/backend/database.py) 与 [`backend/models.py`](file:///d:/code/bijia/backend/models.py) 使用 SQLite 记录查询历史 (`QueryHistoryRecord`) 与统一结构报价 (`QueryResultRecord`)。
- **业务调度与导出**: [`backend/services/query_service.py`](file:///d:/code/bijia/backend/services/query_service.py) 统一调度与结果分组；[`backend/services/excel_service.py`](file:///d:/code/bijia/backend/services/excel_service.py) 生成包含样式高亮、冻结表头与原始链接的 Excel 询价单。
- **REST API 服务**: [`backend/main.py`](file:///d:/code/bijia/backend/main.py) 提供 `/api/inquire`, `/api/history`, `/api/export/{id}` 等接口。
- **采购比价界面**: [`frontend/public/index.html`](file:///d:/code/bijia/frontend/public/index.html) 提供简洁、字段清晰的 Web 采购比价看板。
- **测试与启动**:
  - `tests/test_1688_adapter.py`: 适配器与阶梯价单元测试。
  - `scripts/run_1688_test.py`: 阶段1 端到端自动化集成验证脚本（完全通过）。
  - `start.bat` & `run_server.py`: Windows 本地一键启动脚本。

---

## [Phase 0 Complete] - 2026-08-12

### 新增 (Added)
- 环境检查、初始化目录、评估 5 大开源底座并建立 `THIRD_PARTY.md` 与 `UPSTREAM_EVALUATION.md`。
- `matching/schemas.py` 统一数据结构定义。
- `matching/engine.py` P0 型号匹配评分引擎与全半角标准化算法。
