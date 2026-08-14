# 第三方开源代码与评估记录 (THIRD_PARTY.md)

本系统遵循“优先复用成熟代码，避免重复造轮子”的原则，在适配器 (Adapters) 架构设计中吸取并引入了以下开源项目的架构思路与核心代码模块。所有引入的代码均通过适配器解耦，并明确固定依赖版本与 Commit Hash。

---

## 1. cn-scraper-mcp
- **仓库地址**: [https://github.com/goesByhc/cn-scraper-mcp](https://github.com/goesByhc/cn-scraper-mcp)
- **Commit Hash**: `f878f78f844ea55b48bdc39166ce96a07c7b8939`
- **许可证**: MIT License
- **主要复用与参考模块**:
  - `auth.py`: Chrome 独立 User Data Directory Profile 管理与身份认证逻辑。
  - `cookie_harvest.py`: Cookie 提取与自动化采集工具链。
  - `engines/cdp.py`: Chrome DevTools Protocol (CDP) 本地浏览器远程控制底座。
  - `engines/taobao.py`: 淘宝 MTOP 签名与请求处理经验。
  - `engines/jd.py`: 京东网页 CDP 抓取与页面状态判定。

---

## 2. 1688-cli
- **仓库地址**: [https://github.com/superjack2050/1688-cli](https://github.com/superjack2050/1688-cli)
- **Commit Hash**: `5f958211c002ba3f210bfd88d9d838080c4593f0`
- **许可证**: MIT License
- **主要复用与参考模块**:
  - 1688 搜索、商品详情与 SKU 解析器。
  - 数量阶梯价 (Tier Prices) 解析规则。
  - 供应商基础信息与资质字段映射 (厂/商、年限、经营主体等)。
  - 支持通过 Node.js CLI 子进程/适配器调用 `1688-cli` 或直接移植解析引擎。

---

## 3. taobao_mcp
- **仓库地址**: [https://github.com/JeremyDong22/taobao_mcp](https://github.com/JeremyDong22/taobao_mcp)
- **Commit Hash**: `4cdeb50297929f76e15704e812a3aa15e050919c`
- **许可证**: MIT Style / Custom (无独立 LICENSE 文件)
- **主要复用与参考模块**:
  - `taobao_scraper.py`: 淘宝商品详情页 HTML 及 JS 交互解析逻辑补充。
  - `unified_fetcher.py`: 统一请求分发逻辑。

---

## 4. JD_Price_Crawler
- **仓库地址**: [https://github.com/JeremyDong22/JD_Price_Crawler](https://github.com/JeremyDong22/JD_Price_Crawler)
- **Commit Hash**: `4c9769fd2f5dab76aea278b2b1004795105b0046`
- **许可证**: MIT Style / Custom (无独立 LICENSE 文件)
- **主要复用与参考模块**:
  - `jd_scraper.py`: 京东商品价格与 SKU 选择策略参考。

---

## 5. PriceDive
- **仓库地址**: [https://github.com/DAILtech/PriceDive](https://github.com/DAILtech/PriceDive)
- **Commit Hash**: `4b2dfa2f78c6617e28379195fab58a6c7c009ac0`
- **许可证**: MIT License
- **主要复用与参考模块**:
  - 阶段6价格监控架构、历史价格数据模型与触发提醒机制设计参考。

---

## 合规与隔离声明
所有第三方代码均保留原始版权声明，并限制在 `adapters/` 目录或隔离服务中运行。任何私密登录数据 (Cookie/Token/Profile) 严格禁止写入代码库或提交版本控制。
